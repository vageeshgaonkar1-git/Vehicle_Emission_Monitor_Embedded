/**
 * STM32 Vehicle Emissions Monitor Firmware
 * Target: STM32F411CEU6 (Black Pill)
 *
 * Peripheral map:
 *   I2C1      PB6 (SCL) / PB7 (SDA)  — MPU6050 (vibration) + DS3231 (RTC)
 *   ADC1      PA0 (MQ-7 CO)           — 12-bit, single-conversion
 *             PA1 (MQ-135 NOx/smoke)
 *   GPIO      PA5 output              — N-channel MOSFET → 12 V blower fan
 *             PA4 input               — DHT22 data line (4.7 kΩ pull-up on board)
 *   UART2     PA2 (TX) / PA3 (RX)     — UART bridge to ESP32 Wi-Fi module
 *
 * Transmit path (ESP32 integrated):
 *   UART_Frames are sent over UART2 (PA2 TX → ESP32 GPIO16 RX) at 115200 baud.
 *   The ESP32 receives each newline-terminated JSON frame, validates it, and
 *   publishes it to the MQTT broker over Wi-Fi.
 *
 * Wiring:
 *   STM32 PA2 (TX)  → ESP32 GPIO16 (RX2)
 *   STM32 PA3 (RX)  → ESP32 GPIO17 (TX2)   [optional, for future commands]
 *   STM32 GND       → ESP32 GND             [shared ground — required]
 *   IMPORTANT: STM32 is 3.3 V; ESP32 GPIO is also 3.3 V — direct connection is safe.
 *
 * State machine:
 *   Purge  → PA5 HIGH for PURGE_MS  (default 3 000 ms)
 *   Settle → PA5 LOW  for SETTLE_MS (default 2 000 ms)
 *   Sample → read all sensors, build UART_Frame, transmit over UART2
 */

#include "stm32f4xx_hal.h"
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

/* ── Configurable timing (ms) ─────────────────────────────────────────────── */
#ifndef PURGE_MS
#define PURGE_MS   15000U   /* fan ON for 15 seconds (purge) */
#endif
#ifndef SETTLE_MS
#define SETTLE_MS  10000U   /* fan OFF for 10 seconds (settle) — 25s total cycle */
#endif

/* ── I2C device addresses (7-bit, shifted left 1 for HAL) ─────────────────── */
/*
 * MPU6050: fixed I2C address 0x68 (AD0 pin LOW, which is the default).
 */
#define MPU6050_ADDR  (0x68 << 1)

/*
 * DS3231: default address is also 0x68, which collides with MPU6050.
 * HARDWARE FIX REQUIRED: pull the DS3231 A0 pin HIGH (connect A0 to VCC
 * through a 10 kΩ resistor) to move it to address 0x69.
 * This address reflects that hardware change.
 */
#define DS3231_ADDR   (0x69 << 1)

/* MPU6050 registers */
#define MPU6050_REG_PWR_MGMT_1  0x6B
#define MPU6050_REG_ACCEL_XOUT  0x3B

/* DS3231 registers */
#define DS3231_REG_SECONDS  0x00

/*
 * VIBRATION_THRESHOLD — maximum allowable deviation from the gravity baseline
 * before the engine is declared "running".
 *
 * At rest, gravity produces ~16384 LSB on one accelerometer axis (±2 g range).
 * Comparing raw magnitude against a fixed value always fires because gravity
 * alone exceeds any reasonable threshold.  Instead, we capture a still-state
 * baseline at startup and compare the current reading's Euclidean distance
 * from that baseline.  A delta > VIBRATION_THRESHOLD means the board is
 * experiencing acceleration beyond gravity → engine vibration detected.
 *
 * Default 800 LSB ≈ 0.05 g — sensitive enough for idling engines, high
 * enough to ignore cable sway.  Override with -DVIBRATION_THRESHOLD=N.
 */
#ifndef VIBRATION_THRESHOLD
#define VIBRATION_THRESHOLD  250   /* 250 LSB — reliable for hand-tap */
#endif

/*
 * Number of accelerometer samples averaged to build the still baseline.
 * Taken once during the 2-second USB enumeration delay at startup.
 */
#define BASELINE_SAMPLES  20

/* ── HAL peripheral handles ───────────────────────────────────────────────── */
I2C_HandleTypeDef  hi2c1;
ADC_HandleTypeDef  hadc1;
UART_HandleTypeDef huart2;   /* UART2: PA2 TX → ESP32 GPIO16 RX */
TIM_HandleTypeDef  htim2;    /* 1 µs tick for DHT22 bit-bang */

/*
 * MPU6050 still-state baseline (set once at startup by mpu6050_calibrate).
 * mpu6050_is_running() measures the Euclidean distance of the current reading
 * from this baseline — avoiding false positives caused by gravity.
 */
static int16_t mpu_baseline_ax = 0;
static int16_t mpu_baseline_ay = 0;
static int16_t mpu_baseline_az = 0;

/* ═══════════════════════════════════════════════════════════════════════════
 *  Forward declarations
 * ═══════════════════════════════════════════════════════════════════════════ */
static void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_I2C1_Init(void);
static void MX_ADC1_Init(void);
static void MX_UART2_Init(void);
static void MX_TIM2_Init(void);

static void     dht22_set_output(void);
static void     dht22_set_input(void);
static void     dht22_write(GPIO_PinState state);
static uint8_t  dht22_read_bit(void);
static HAL_StatusTypeDef dht22_read(float *temperature, float *humidity);

static uint16_t adc_read_channel(uint32_t channel);
static void     mpu6050_calibrate(void);
static int      mpu6050_is_running(void);
static HAL_StatusTypeDef ds3231_get_timestamp(char *buf, size_t len);

float dht22_correct_gas(uint16_t raw_adc, float temperature, float humidity);
static float mq7_read_ppm(uint16_t raw_adc, float temperature, float humidity);
static float mq135_read_ppm(uint16_t raw_adc, float temperature, float humidity);

static void run_state_machine(void);
static void transmit_frame(float co, float nox, float temp, float hum,
                            int is_running, const char *timestamp);
static void delay_us(uint32_t us);

/* ═══════════════════════════════════════════════════════════════════════════
 *  main
 * ═══════════════════════════════════════════════════════════════════════════ */
int main(void)
{
    HAL_Init();
    SystemClock_Config();

    MX_GPIO_Init();
    MX_I2C1_Init();
    MX_ADC1_Init();
    MX_UART2_Init();
    MX_TIM2_Init();

    /* UART2 is now the primary transmit path to the ESP32.
     * No USB CDC initialisation needed — the ESP32 bridges to Wi-Fi/MQTT. */

    /* Wake MPU6050 — short timeout so a missing sensor doesn't hang */
    uint8_t wake = 0x00;
    HAL_I2C_Mem_Write(&hi2c1, MPU6050_ADDR, MPU6050_REG_PWR_MGMT_1,
                      I2C_MEMADD_SIZE_8BIT, &wake, 1, 50);

    /* Capture still-state accelerometer baseline.
     * The board must be stationary (engine off) at this point.
     * This eliminates false "engine running" readings caused by gravity. */
    mpu6050_calibrate();

    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET);

    while (1)
    {
        run_state_machine();
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Peripheral initialisation
 * ═══════════════════════════════════════════════════════════════════════════ */

static void MX_GPIO_Init(void)
{
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();

    GPIO_InitTypeDef gpio = {0};

    /* PA5 — blower fan MOSFET gate */
    gpio.Pin   = GPIO_PIN_5;
    gpio.Mode  = GPIO_MODE_OUTPUT_PP;
    gpio.Pull  = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOA, &gpio);
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET);

    /* PA4 — DHT22 data (external 4.7 kΩ pull-up) */
    gpio.Pin  = GPIO_PIN_4;
    gpio.Mode = GPIO_MODE_INPUT;
    gpio.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &gpio);

    /* PA2 / PA3 are configured by MX_UART2_Init() as AF7 (USART2). */
}

static void MX_I2C1_Init(void)
{
    __HAL_RCC_I2C1_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();

    GPIO_InitTypeDef gpio = {0};
    gpio.Pin       = GPIO_PIN_6 | GPIO_PIN_7;
    gpio.Mode      = GPIO_MODE_AF_OD;
    gpio.Pull      = GPIO_PULLUP;
    gpio.Speed     = GPIO_SPEED_FREQ_LOW;
    gpio.Alternate = GPIO_AF4_I2C1;
    HAL_GPIO_Init(GPIOB, &gpio);

    hi2c1.Instance             = I2C1;
    hi2c1.Init.ClockSpeed      = 100000;
    hi2c1.Init.DutyCycle       = I2C_DUTYCYCLE_2;
    hi2c1.Init.OwnAddress1     = 0;
    hi2c1.Init.AddressingMode  = I2C_ADDRESSINGMODE_7BIT;
    hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
    hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
    hi2c1.Init.NoStretchMode   = I2C_NOSTRETCH_DISABLE;
    HAL_I2C_Init(&hi2c1);
}

static void MX_ADC1_Init(void)
{
    __HAL_RCC_ADC1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();

    GPIO_InitTypeDef gpio = {0};
    gpio.Pin  = GPIO_PIN_0 | GPIO_PIN_1;
    gpio.Mode = GPIO_MODE_ANALOG;
    gpio.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &gpio);

    hadc1.Instance                   = ADC1;
    hadc1.Init.ClockPrescaler        = ADC_CLOCK_SYNC_PCLK_DIV4;
    hadc1.Init.Resolution            = ADC_RESOLUTION_12B;
    hadc1.Init.ScanConvMode          = DISABLE;
    hadc1.Init.ContinuousConvMode    = DISABLE;
    hadc1.Init.DiscontinuousConvMode = DISABLE;
    hadc1.Init.ExternalTrigConvEdge  = ADC_EXTERNALTRIGCONVEDGE_NONE;
    hadc1.Init.ExternalTrigConv      = ADC_SOFTWARE_START;
    hadc1.Init.DataAlign             = ADC_DATAALIGN_RIGHT;
    hadc1.Init.NbrOfConversion       = 1;
    hadc1.Init.DMAContinuousRequests = DISABLE;
    hadc1.Init.EOCSelection          = ADC_EOC_SINGLE_CONV;
    HAL_ADC_Init(&hadc1);
}

/* UART2: primary transmit path to ESP32 at 115200 baud */
static void MX_UART2_Init(void)
{
    __HAL_RCC_USART2_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();

    GPIO_InitTypeDef gpio = {0};
    gpio.Pin       = GPIO_PIN_2 | GPIO_PIN_3;
    gpio.Mode      = GPIO_MODE_AF_PP;
    gpio.Pull      = GPIO_NOPULL;
    gpio.Speed     = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF7_USART2;
    HAL_GPIO_Init(GPIOA, &gpio);

    huart2.Instance          = USART2;
    huart2.Init.BaudRate     = 115200;
    huart2.Init.WordLength   = UART_WORDLENGTH_8B;
    huart2.Init.StopBits     = UART_STOPBITS_1;
    huart2.Init.Parity       = UART_PARITY_NONE;
    huart2.Init.Mode         = UART_MODE_TX_RX;
    huart2.Init.HwFlowCtl    = UART_HWCONTROL_NONE;
    huart2.Init.OverSampling = UART_OVERSAMPLING_16;
    HAL_UART_Init(&huart2);
}

static void MX_TIM2_Init(void)
{
    __HAL_RCC_TIM2_CLK_ENABLE();

    /* STM32F411 at 96 MHz: APB1 timer clock = 96 MHz */
    htim2.Instance               = TIM2;
    htim2.Init.Prescaler         = (96 - 1);   /* 96 MHz / 96 = 1 MHz → 1 µs tick */
    htim2.Init.CounterMode       = TIM_COUNTERMODE_UP;
    htim2.Init.Period            = 0xFFFFFFFF;
    htim2.Init.ClockDivision     = TIM_CLOCKDIVISION_DIV1;
    htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
    HAL_TIM_Base_Init(&htim2);
    HAL_TIM_Base_Start(&htim2);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  µs delay (TIM2)
 * ═══════════════════════════════════════════════════════════════════════════ */
static void delay_us(uint32_t us)
{
    __HAL_TIM_SET_COUNTER(&htim2, 0);
    while (__HAL_TIM_GET_COUNTER(&htim2) < us);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  DHT22 bit-bang driver (PA4)
 * ═══════════════════════════════════════════════════════════════════════════ */
static void dht22_set_output(void)
{
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin   = GPIO_PIN_4;
    gpio.Mode  = GPIO_MODE_OUTPUT_PP;
    gpio.Pull  = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOA, &gpio);
}

static void dht22_set_input(void)
{
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin  = GPIO_PIN_4;
    gpio.Mode = GPIO_MODE_INPUT;
    gpio.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &gpio);
}

static void dht22_write(GPIO_PinState state)
{
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_4, state);
}

static uint8_t dht22_read_bit(void)
{
    return (HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_4) == GPIO_PIN_SET) ? 1 : 0;
}

static HAL_StatusTypeDef dht22_read(float *temperature, float *humidity)
{
    uint8_t data[5] = {0};

    dht22_set_output();
    dht22_write(GPIO_PIN_RESET);
    HAL_Delay(1);
    dht22_write(GPIO_PIN_SET);
    delay_us(30);
    dht22_set_input();

    uint32_t timeout = 200;
    while (dht22_read_bit() == 1) { delay_us(1); if (--timeout == 0) return HAL_ERROR; }
    timeout = 200;
    while (dht22_read_bit() == 0) { delay_us(1); if (--timeout == 0) return HAL_ERROR; }
    timeout = 200;
    while (dht22_read_bit() == 1) { delay_us(1); if (--timeout == 0) return HAL_ERROR; }

    for (int i = 0; i < 40; i++) {
        timeout = 200;
        while (dht22_read_bit() == 0) { delay_us(1); if (--timeout == 0) return HAL_ERROR; }
        delay_us(35);
        uint8_t bit = dht22_read_bit();
        data[i / 8] = (uint8_t)((data[i / 8] << 1) | bit);
        timeout = 200;
        while (dht22_read_bit() == 1) { delay_us(1); if (--timeout == 0) return HAL_ERROR; }
    }

    uint8_t sum = data[0] + data[1] + data[2] + data[3];
    if (sum != data[4]) return HAL_ERROR;

    *humidity    = ((data[0] << 8) | data[1]) * 0.1f;
    int16_t raw_t = (int16_t)(((data[2] & 0x7F) << 8) | data[3]);
    if (data[2] & 0x80) raw_t = -raw_t;
    *temperature = raw_t * 0.1f;

    return HAL_OK;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  ADC helper
 * ═══════════════════════════════════════════════════════════════════════════ */
static uint16_t adc_read_channel(uint32_t channel)
{
    ADC_ChannelConfTypeDef cfg = {0};
    cfg.Channel      = channel;
    cfg.Rank         = 1;
    cfg.SamplingTime = ADC_SAMPLETIME_84CYCLES;
    HAL_ADC_ConfigChannel(&hadc1, &cfg);

    HAL_ADC_Start(&hadc1);
    HAL_ADC_PollForConversion(&hadc1, HAL_MAX_DELAY);
    uint16_t val = (uint16_t)HAL_ADC_GetValue(&hadc1);
    HAL_ADC_Stop(&hadc1);
    return val;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  MQ-7 CO sensor — calibrated concentration in ppm
 *
 *  MQ-7 datasheet characteristics (Vcc=5V, RL=10kΩ, 20°C, 65% RH):
 *    Rs/R0 in clean air   ≈ 1.0  (after calibration R0 = Rs_clean)
 *    Rs/R0 at 100 ppm CO  ≈ 0.38
 *    Rs/R0 at 200 ppm CO  ≈ 0.25
 *  Power curve: ppm = a * (Rs/R0)^b
 *    a = 99.042, b = -1.518  (from datasheet curve fit)
 *
 *  NOTE: MQ-7 VCC must be 5V for correct operation.
 *  The STM32 ADC reads the voltage across RL (10kΩ) referenced to 3.3V.
 *  If the sensor is powered at 5V but ADC max is 3.3V, use a voltage divider
 *  on the output pin, OR accept that readings are approximate.
 *
 *  R0 (sensor resistance in clean air) must be measured during calibration.
 *  Default R0 = 10 kΩ — adjust after warm-up measurement.
 * ═══════════════════════════════════════════════════════════════════════════ */
static float mq7_read_ppm(uint16_t raw_adc, float temperature, float humidity)
{
    const float V_ADC_FS = 3.3f;
    const float V_MAX    = 4095.0f;
    const float V_SUPPLY = 5.0f;
    const float R_LOAD   = 10.0f;

    /* YOUR NEW CALIBRATED BASELINE */
    const float R0       = 1.515f;

    float vout = ((float)raw_adc / V_MAX) * V_ADC_FS;
    if (vout < 0.01f) vout = 0.01f;
    if (vout > V_SUPPLY - 0.01f) vout = V_SUPPLY - 0.01f;

    float rs = R_LOAD * (V_SUPPLY - vout) / vout;

    /* Convert Resistance to PPM using datasheet power curve */
    float ratio = rs / R0;
    float ppm = 99.042f * powf(ratio, -1.518f);

    if (ppm < 0.0f)    ppm = 0.0f;
    if (ppm > 1000.0f) ppm = 1000.0f;

    return ppm;
}

static float mq135_read_ppm(uint16_t raw_adc, float temperature, float humidity)
{
    const float V_ADC_FS = 3.3f;
    const float V_MAX    = 4095.0f;
    const float V_SUPPLY = 5.0f;
    const float R_LOAD   = 10.0f;

    /* YOUR NEW CALIBRATED BASELINE */
    const float R0       = 5.847f;

    float vout = ((float)raw_adc / V_MAX) * V_ADC_FS;
    if (vout < 0.01f) vout = 0.01f;
    if (vout > V_SUPPLY - 0.01f) vout = V_SUPPLY - 0.01f;

    float rs = R_LOAD * (V_SUPPLY - vout) / vout;

    /* Convert Resistance to PPM using datasheet power curve */
    float ratio = rs / R0;
    float ppm = 116.6f * powf(ratio, -2.769f);

    if (ppm < 0.0f)   ppm = 0.0f;
    if (ppm > 500.0f) ppm = 500.0f;

    return ppm;
}

/* Legacy wrapper — kept so existing call sites compile without change */
float dht22_correct_gas(uint16_t raw_adc, float temperature, float humidity)
{
    /* Default to MQ-135 behaviour when called generically */
    return mq135_read_ppm(raw_adc, temperature, humidity);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  MPU6050 — vibration detection — Requirement 13.5
 *
 *  Strategy: delta-from-baseline rather than absolute magnitude.
 *
 *  At rest, gravity (~16384 LSB on one axis in ±2 g range) dominates the
 *  raw readings.  Comparing raw magnitude against a fixed threshold always
 *  fires because gravity alone exceeds any reasonable value.
 *
 *  Instead:
 *    1. mpu6050_calibrate() samples BASELINE_SAMPLES readings at startup
 *       (engine off, board stationary) and stores the average as the baseline.
 *    2. mpu6050_is_running() computes the Euclidean distance between the
 *       current reading and the baseline.  A distance > VIBRATION_THRESHOLD
 *       means the board is experiencing extra acceleration → engine running.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Read one raw accelerometer sample from MPU6050.
 * Returns HAL_OK and fills ax/ay/az on success.
 */
static HAL_StatusTypeDef mpu6050_read_accel(int16_t *ax, int16_t *ay, int16_t *az)
{
    uint8_t buf[6];
    HAL_StatusTypeDef status = HAL_I2C_Mem_Read(
        &hi2c1, MPU6050_ADDR, MPU6050_REG_ACCEL_XOUT,
        I2C_MEMADD_SIZE_8BIT, buf, 6, 50);

    if (status != HAL_OK) return HAL_ERROR;

    *ax = (int16_t)((buf[0] << 8) | buf[1]);
    *ay = (int16_t)((buf[2] << 8) | buf[3]);
    *az = (int16_t)((buf[4] << 8) | buf[5]);
    return HAL_OK;
}

/**
 * Capture the still-state baseline.
 * Call once at startup with the engine off and the board stationary.
 * Averages BASELINE_SAMPLES readings to reduce noise.
 */
static void mpu6050_calibrate(void)
{
    int32_t sum_ax = 0, sum_ay = 0, sum_az = 0;
    int     valid  = 0;

    for (int i = 0; i < BASELINE_SAMPLES; i++) {
        int16_t ax, ay, az;
        if (mpu6050_read_accel(&ax, &ay, &az) == HAL_OK) {
            sum_ax += ax;
            sum_ay += ay;
            sum_az += az;
            valid++;
        }
        HAL_Delay(10);   /* 10 ms between samples → 200 ms total calibration window */
    }

    if (valid > 0) {
        mpu_baseline_ax = (int16_t)(sum_ax / valid);
        mpu_baseline_ay = (int16_t)(sum_ay / valid);
        mpu_baseline_az = (int16_t)(sum_az / valid);
    }
    /* If no valid samples, baseline stays at zero — worst case is a false
     * positive on the first few cycles, which is acceptable. */
}

/**
 * Returns 1 if engine vibration is detected, 0 otherwise.
 * Uses Euclidean distance from the calibrated still-state baseline.
 */
static int mpu6050_is_running(void)
{
    int16_t ax, ay, az;
    if (mpu6050_read_accel(&ax, &ay, &az) != HAL_OK) return 0;

    int32_t dx = (int32_t)ax - mpu_baseline_ax;
    int32_t dy = (int32_t)ay - mpu_baseline_ay;
    int32_t dz = (int32_t)az - mpu_baseline_az;

    /* Integer square root is not available in all C89 runtimes on Cortex-M.
     * Compare squared distance to avoid sqrt — safe because both sides are
     * non-negative and the threshold fits well within int32_t range. */
    int32_t dist_sq      = dx * dx + dy * dy + dz * dz;
    int32_t threshold_sq = (int32_t)VIBRATION_THRESHOLD * VIBRATION_THRESHOLD;

    return (dist_sq > threshold_sq) ? 1 : 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  DS3231 — hardware RTC timestamp
 * ═══════════════════════════════════════════════════════════════════════════ */
static uint8_t bcd2dec(uint8_t bcd) { return (bcd >> 4) * 10 + (bcd & 0x0F); }

static HAL_StatusTypeDef ds3231_get_timestamp(char *buf, size_t len)
{
    uint8_t regs[7];
    /* Use a short timeout (50ms) so a missing/broken DS3231 doesn't
     * block the entire state machine indefinitely. */
    HAL_StatusTypeDef status = HAL_I2C_Mem_Read(
        &hi2c1, DS3231_ADDR, DS3231_REG_SECONDS,
        I2C_MEMADD_SIZE_8BIT, regs, 7, 50);

    if (status != HAL_OK) return HAL_ERROR;

    uint8_t  sec  = bcd2dec(regs[0] & 0x7F);
    uint8_t  min  = bcd2dec(regs[1] & 0x7F);
    uint8_t  hour = bcd2dec(regs[2] & 0x3F);
    uint8_t  date = bcd2dec(regs[4] & 0x3F);
    uint8_t  mon  = bcd2dec(regs[5] & 0x1F);
    uint16_t yr   = 2000U + bcd2dec(regs[6]);

    snprintf(buf, len, "%04u-%02u-%02uT%02u:%02u:%02u.000Z",
             yr, mon, date, hour, min, sec);
    return HAL_OK;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  UART_Frame transmit over UART2 to ESP32
 *
 *  Each frame is a minified JSON string terminated by '\n'.
 *  The ESP32 reads until '\n' to detect a complete frame, then publishes
 *  it to the MQTT broker over Wi-Fi.
 *
 *  HAL_UART_Transmit() is blocking with a 100 ms timeout — sufficient for
 *  a ~200-byte frame at 115200 baud (~17 ms theoretical).
 * ═══════════════════════════════════════════════════════════════════════════ */
static void transmit_frame(float co, float nox, float temp, float hum,
                            int is_running, const char *timestamp)
{
    char frame[256];
    int len = snprintf(frame, sizeof(frame),
        "{\"co\":%.2f,\"nox\":%.2f,\"temp\":%.2f,\"hum\":%.2f,"
        "\"is_running\":%d,\"timestamp\":\"%s\"}\n",
        co, nox, temp, hum, is_running, timestamp);

    if (len <= 0 || len >= (int)sizeof(frame)) return;

    /* Transmit over UART2 → ESP32 GPIO16 (RX2) */
    HAL_UART_Transmit(&huart2, (uint8_t *)frame, (uint16_t)len, 100);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Purge → Settle → Sample state machine
 *  Cycle: 15s fan ON (purge) + 10s fan OFF (settle) + sample = 25s total
 *  Vibration is polled every 1s during settle so engine-on events are not
 *  missed during the blocking delay windows.
 * ═══════════════════════════════════════════════════════════════════════════ */
/* Temporary Calibration Loop */
static void run_state_machine(void)
{
    /* ── PURGE: fan ON for PURGE_MS ── */
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET);
    HAL_Delay(PURGE_MS);

    /* ── SETTLE: fan OFF, poll vibration every 1 s ── */
    /* ── SETTLE: fan OFF, poll vibration continuously at 100 Hz ── */
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET);

  int is_running = 0;
  int vib_count  = 0;
  uint32_t settle_start = HAL_GetTick();

  /* Loop rapidly for exactly SETTLE_MS (10 seconds) */
  while ((HAL_GetTick() - settle_start) < SETTLE_MS) {
    if (mpu6050_is_running()) {
      vib_count++;
    }
    HAL_Delay(10); /* Check every 10ms, not every 1000ms */
  }

  /* Require a few consecutive vibration hits to filter out single-tap noise */
  if (vib_count >= 3) is_running = 1;

    /* ── SAMPLE: read all sensors at end of settle phase ── */
    float temperature = 25.0f;
    float humidity    = 50.0f;
    dht22_read(&temperature, &humidity);

    uint16_t raw_co  = adc_read_channel(ADC_CHANNEL_0);
    uint16_t raw_nox = adc_read_channel(ADC_CHANNEL_1);

    /* MQ-7 on PA0 → CO in ppm, MQ-135 on PA1 → NOx/air quality in ppm */
    float co  = mq7_read_ppm(raw_co,   temperature, humidity);
    float nox = mq135_read_ppm(raw_nox, temperature, humidity);

    char timestamp[32];
    if (ds3231_get_timestamp(timestamp, sizeof(timestamp)) != HAL_OK) {
        timestamp[0] = '\0';
    }

    transmit_frame(co, nox, temperature, humidity, is_running, timestamp);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  System clock — STM32F411CEU6 at 96 MHz
 *  HSE 25 MHz (Black Pill crystal) → PLL → 96 MHz SYSCLK
 *  USB requires a 48 MHz clock: PLLQ = 4 → 96/4 = 48 MHz ✓
 * ═══════════════════════════════════════════════════════════════════════════ */
static void SystemClock_Config(void)
{
    RCC_OscInitTypeDef osc = {0};
    osc.OscillatorType = RCC_OSCILLATORTYPE_HSE;
    osc.HSEState       = RCC_HSE_ON;
    osc.PLL.PLLState   = RCC_PLL_ON;
    osc.PLL.PLLSource  = RCC_PLLSOURCE_HSE;
    osc.PLL.PLLM       = 25;   /* 25 MHz HSE / 25 = 1 MHz VCO input  */
    osc.PLL.PLLN       = 192;  /* × 192 = 192 MHz VCO                */
    osc.PLL.PLLP       = RCC_PLLP_DIV2;  /* 192 / 2 = 96 MHz SYSCLK */
    osc.PLL.PLLQ       = 4;    /* 192 / 4 = 48 MHz USB clock ✓       */
    HAL_RCC_OscConfig(&osc);

    RCC_ClkInitTypeDef clk = {0};
    clk.ClockType      = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK
                       | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    clk.SYSCLKSource   = RCC_SYSCLKSOURCE_PLLCLK;
    clk.AHBCLKDivider  = RCC_SYSCLK_DIV1;   /* HCLK  = 96 MHz */
    clk.APB1CLKDivider = RCC_HCLK_DIV2;     /* PCLK1 = 48 MHz (max for F411) */
    clk.APB2CLKDivider = RCC_HCLK_DIV1;     /* PCLK2 = 96 MHz */
    HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_3);
}
