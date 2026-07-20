# 🛡️ Vehicle Emissions Monitor

A full-stack embedded system that measures, analyses, and visualises real-time vehicle exhaust emissions. The system combines STM32 microcontroller firmware, an ESP32 Wi-Fi bridge, a Node.js data pipeline, and a live Firebase-powered dashboard deployed on Vercel — all wired together into a single, end-to-end emissions monitoring solution.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Hardware Components](#hardware-components)
4. [Power Architecture](#power-architecture)
5. [Wiring Diagram](#wiring-diagram)
6. [Project Structure](#project-structure)
7. [Firmware](#firmware)
   - [STM32 (main.c)](#stm32-mainc)
   - [ESP32 (main.ino)](#esp32-mainino)
8. [Backend — Node.js Pipeline](#backend--nodejs-pipeline)
9. [Vercel Dashboard](#vercel-dashboard)
10. [Diagnostic Assessment](#diagnostic-assessment)
11. [Vehicle Emission Profiles](#vehicle-emission-profiles)
12. [Firebase Integration](#firebase-integration)
13. [Getting Started](#getting-started)
14. [Environment Variables](#environment-variables)
15. [Running Tests](#running-tests)
16. [Scripts Reference](#scripts-reference)
17. [Dependencies](#dependencies)
18. [Contact](#contact)

---

## System Overview

The monitor probes a vehicle's exhaust tailpipe and measures:

| Sensor | Parameter | Unit |
|--------|-----------|------|
| MQ-7   | Carbon Monoxide (CO)     | ppm |
| MQ-135 | Nitrogen Oxides (NOx)    | ppm |
| DHT22  | Temperature              | °C  |
| DHT22  | Humidity                 | % RH |
| MPU-6050 | Engine vibration (running/stopped) | — |
| DS3231 | RTC timestamp            | ISO 8601 |

Readings flow through a UART → ESP32 → Firebase pipeline and appear on a live dashboard within seconds of measurement.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         HARDWARE LAYER                          │
│                                                                 │
│  MQ-7 (CO) ──┐                                                  │
│  MQ-135(NOx)─┤                                                  │
│  DHT22 ──────┼──► STM32F411CEU6 (Black Pill) ──UART2──► ESP32   │
│  MPU-6050 ───┤    (main.c)        115200 baud  (main.ino)       │
│  DS3231 RTC ─┘                                     │            │
└────────────────────────────────────────────────────┼────────────┘
                                                     │ HTTPS REST
                                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                       FIREBASE RTDB                             │
│   /latest   — most recent single reading (always overwritten)   │
│   /history  — circular buffer of 500 readings, keyed by slot    │
└────────────────────────┬────────────────────────────────────────┘
                         │ Realtime listener
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│               VERCEL DASHBOARD (vercel-dashboard/)              │
│   Live sensor cards · Diagnostic Assessment · Charts            │
│   History table · Alert thresholds · Contact Us form            │
└─────────────────────────────────────────────────────────────────┘

         ── Optional local pipeline (no ESP32 needed) ──

  STM32 USB-COM ──► serial-bridge.js ──MQTT──► server.js ──► public/index.html
                                               (SQLite)       (Socket.IO)
```

**Two independent pipelines are supported:**

| Mode | Bridge | Storage | Dashboard |
|------|--------|---------|-----------|
| **Production** | ESP32 over HTTPS REST | Firebase RTDB | `vercel-dashboard/` (Vercel) |
| **Local / Dev** | `serial-bridge.js` over MQTT | SQLite (`emissions.db`) | `public/index.html` (localhost:3000) |

---

## Hardware Components

| Component | Model | Role |
|-----------|-------|------|
| Main MCU | STM32F411CEU6 (Black Pill) | Reads all sensors, runs purge/settle/sample state machine, transmits UART frames |
| Wi-Fi Bridge | ESP32 (30-pin DevKit) | Receives UART frames from STM32, pushes to Firebase via HTTPS REST |
| CO Sensor | MQ-7 | Carbon monoxide (PA0, ADC channel 0) |
| NOx / Air Quality Sensor | MQ-135 | Nitrogen oxides & smoke (PA1, ADC channel 1) |
| Temp & Humidity | DHT22 (AM2302) | Environmental correction, bit-bang on PA4 |
| IMU / Vibration | MPU-6050 | Engine running state detection (I2C1, PB6/PB7) |
| RTC | DS3231 | Hardware ISO 8601 timestamps (I2C1, shared with MPU-6050) |
| Fan / Blower | 12V DC | Purge residual gases from sensing chamber |
| N-CH MOSFET | 2N7000 / IRLZ44N | Switches 12V fan from 3.3V GPIO PA5 |
| Flyback Diode | 1N4007 | Suppresses back-EMF from fan motor across fan terminals |
| Load resistors | 10 kΩ × 2 | RL for MQ-7 and MQ-135 voltage dividers |
| Pull-up resistor | 4.7 kΩ | DHT22 data line |
| Decoupling caps | 100 nF × 4 | Power noise suppression on sensor rails |

---

## Power Architecture

The system runs entirely from a self-contained battery pack — no USB tethering required in the field.

| Stage | Component | Detail |
|-------|-----------|--------|
| Battery | 2S Li-ion pack + BMS | Nominal 7.4 V (8.4 V full), 2000 mAh typical; BMS handles cell balancing, over-current, and over-discharge protection |
| Step-down regulation | LM2596 buck converter | Converts 7.4–8.4 V → 5 V @ up to 3 A; powers MQ-7 heater, MQ-135 heater, and ESP32 |
| 3.3 V logic rail | AMS1117-3.3 LDO | Derived from the 5 V rail; powers STM32, DHT22, MPU-6050, DS3231, sensor logic pins |
| Fan switch | N-CH MOSFET (gate PA5) | 12V fan is driven from battery voltage via MOSFET; gate driven from 3.3 V GPIO through 10 kΩ gate resistor |
| Fan protection | 1N4007 flyback diode | Placed across fan terminals (anode to −, cathode to +) to clamp inductive back-EMF on MOSFET turn-off |

> **Note:** The LM2596 output voltage is set by the resistor divider on its ADJ/FB pin. Verify the divider values give exactly 5.0 V before connecting sensors.

---

## Wiring Diagram

```
STM32F411CEU6 (Black Pill)
┌─────────────────────────────────────────────────────────────────┐
│ PA0  ──────────────────────── MQ-7   AOUT (5V Vcc, 10kΩ RL)    │
│ PA1  ──────────────────────── MQ-135 AOUT (5V Vcc, 10kΩ RL)    │
│ PA4  ──────────────────────── DHT22  DATA (3.3V, 4.7kΩ pull-up) │
│ PA5  ──[10kΩ gate R]────────► MOSFET Gate → Fan (12V) + 1N4007  │
│ PA2 (UART2 TX) ─────────────► ESP32 GPIO16 (RX2)               │
│ PB6 (I2C1 SCL) ─────────────► MPU-6050 SCL  &  DS3231 SCL      │
│ PB7 (I2C1 SDA) ─────────────► MPU-6050 SDA  &  DS3231 SDA      │
│ GND ────────────────────────── ESP32 GND  (shared ground)       │
└─────────────────────────────────────────────────────────────────┘

Power rail:
  2S Li-ion + BMS (7.4V) ──► LM2596 buck ──► 5V ──► MQ-7, MQ-135, ESP32
                                              5V ──► AMS1117 ──► 3.3V ──► STM32, DHT22, I2C devices
  Battery (7.4V) ──────────────────────────────────► MOSFET Drain ──► Fan (–)
  Fan (+) ──► 12V supply (or battery direct for 2S)
  1N4007 flyback: anode → Fan (–) / MOSFET Drain, cathode → Fan (+)
```

### DS3231 Address Conflict Fix

Both MPU-6050 and DS3231 default to I2C address `0x68`. To resolve the collision:

> Pull the DS3231 **A0** pin HIGH (connect to VCC through a 10 kΩ resistor). This moves the DS3231 to address `0x69`. The firmware already uses `0x69` for DS3231 and `0x68` for MPU-6050.

---

## Project Structure

```
.
├── esp32/
│   └── main/
│       └── main.ino          # ESP32 Firebase REST bridge firmware
├── stm32/
│   └── main.c                # STM32F411 sensor firmware (HAL, no RTOS)
├── src/
│   ├── db.js                 # SQLite init, insert, query helpers
│   ├── parser.js             # MQTT payload validator & field mapper
│   └── uartFrame.js          # UART frame formatter / parser / gas correction
├── public/
│   └── index.html            # Local dashboard (Socket.IO, Chart.js)
├── vercel-dashboard/
│   ├── index.html            # Production dashboard (Firebase RTDB, Vercel)
│   └── vercel.json           # Vercel deployment config
├── test/
│   ├── server.test.js        # Integration tests — REST API & WebSocket
│   ├── simulate.test.js      # Simulator publish tests
│   ├── db.property.test.js   # Property-based DB tests (fast-check)
│   ├── parser.property.test.js
│   ├── uartFrame.property.test.js
│   ├── alert.property.test.js
│   ├── broadcast.property.test.js
│   ├── chart.property.test.js
│   └── dht22.property.test.js
├── server.js                 # Express + MQTT + Socket.IO backend
├── serial-bridge.js          # STM32 USB serial → MQTT bridge (local mode)
├── simulate.js               # Mock sensor publisher for testing
├── emissions.db              # SQLite database (auto-created on first run)
├── package.json
└── README.md
```

---

## Firmware

### STM32 (main.c)

**Target:** STM32F411CEU6 (Black Pill) at 96 MHz (HSE 25 MHz → PLL).
Written in bare-metal C using the STM32 HAL library. No RTOS. All I2C calls use a **50 ms timeout** (not `HAL_MAX_DELAY`) so the state machine never hangs on a missing peripheral.

**Measurement cycle — 25 s total:**

```
┌─────────────┐    15 s    ┌─────────────┐   10 s   ┌─────────────┐
│  PURGE      │──────────►│  SETTLE     │─────────►│  SAMPLE     │
│  Fan ON     │            │  Fan OFF    │           │  Read all   │
│  (PA5 HIGH) │            │  Poll MPU   │           │  Transmit   │
│             │            │  every 10ms │           │  UART frame │
└─────────────┘            └─────────────┘           └─────────────┘
```

During SETTLE, vibration is polled at 100 Hz. The engine is declared **running** if ≥ 3 vibration hits accumulate across the 10-second window — preventing false positives from single cable taps.

**Key compile-time macros:**

| Macro | Default | Description |
|-------|---------|-------------|
| `PURGE_MS` | 15 000 ms | Fan-on purge duration |
| `SETTLE_MS` | 10 000 ms | Fan-off settle duration |
| `VIBRATION_THRESHOLD` | 250 LSB | Euclidean delta from still-baseline for engine detection |
| `BASELINE_SAMPLES` | 20 | Accelerometer samples averaged at boot for still-baseline |

**Pin map:**

| Pin | Function | Peripheral |
|-----|----------|------------|
| PA0 | ADC1 CH0 | MQ-7 AOUT |
| PA1 | ADC1 CH1 | MQ-135 AOUT |
| PA2 | UART2 TX | → ESP32 GPIO16 (RX2) |
| PA3 | UART2 RX | (reserved, not used) |
| PA4 | GPIO bit-bang | DHT22 DATA |
| PA5 | GPIO output | Fan MOSFET gate |
| PB6 | I2C1 SCL | MPU-6050 + DS3231 |
| PB7 | I2C1 SDA | MPU-6050 + DS3231 |

**Sensor functions:**

| Function | Sensor | Output |
|----------|--------|--------|
| `calibrate_mq7_baseline()` | MQ-7 / PA0 | Measures Rs in clean air over 5 s; derives R0 = Rs / 27.0 (datasheet ratio) |
| `mq7_read_ppm(raw_adc)` | MQ-7 / PA0 | CO ppm via `100 × (Rs/R0)^−1.518`; EMA α=0.1; thermal drift tracking |
| `mq135_read_ppm(raw_adc, t, h)` | MQ-135 / PA1 | NOx ppm via `116.6 × (Rs/R0)^−2.769`; R0 = 5.847 kΩ (calibrated) |
| `dht22_read(&temp, &hum)` | DHT22 / PA4 | Temperature (°C) and humidity (% RH), bit-bang 1-Wire via TIM2 µs tick |
| `mpu6050_calibrate()` | MPU-6050 / I2C1 | Averages 20 samples at boot to establish still-state baseline |
| `mpu6050_is_running()` | MPU-6050 / I2C1 | Returns 1 if Euclidean distance from baseline > VIBRATION_THRESHOLD |
| `ds3231_get_timestamp(buf, len)` | DS3231 / I2C1 | ISO 8601 string; 50 ms I2C timeout; DS3231 at address 0x69 |
| `adc_read_channel(channel)` | ADC1 | 12-bit software-triggered single conversion, 84-cycle sample time |

**MQ-7 calibration detail:**

R0 is the sensor resistance at 100 ppm CO (not in clean air). In clean air, Rs/R0 = 27.0 (datasheet). At boot, `calibrate_mq7_baseline()` samples 50 readings over 5 seconds, filters out near-rail voltages (< 0.05 V or > 3.25 V), averages the valid Rs values, and divides by 27.0:

```
R0 = Rs_clean_air / 27.0    (fallback: R0 = 1.5 kΩ if < 0.1 kΩ)
```

During operation, `mq7_read_ppm()` applies slow upward R0 adaptation to prevent ambient PPM creep from thermal drift:

```
if current_r0 > MQ7_R0:
    MQ7_R0 = 0.99 × MQ7_R0 + 0.01 × current_r0
```

**UART frame format (JSON, newline-terminated):**

```json
{"co":45.12,"nox":18.30,"temp":32.50,"hum":61.20,"is_running":1,"timestamp":"2026-07-05T14:30:00.000Z"}
```

Transmitted over UART2 (PA2 TX) at 115 200 baud with a 100 ms blocking timeout.

---

### ESP32 (main.ino)

Uses only the built-in ESP32 Arduino core — no external Firebase library.

| Library | Source |
|---------|--------|
| `WiFi.h` | ESP32 Arduino core (built-in) |
| `HTTPClient.h` | ESP32 Arduino core (built-in) |
| `WiFiClientSecure.h` | ESP32 Arduino core (built-in) |
| `ArduinoJson` v6.x | Arduino Library Manager |

**Flow:**

1. Connect to Wi-Fi (`WIFI_SSID` / `WIFI_PASSWORD`)
2. Sync NTP time — IST offset `configTime(19800, 0, "pool.ntp.org")`
3. Listen on `Serial2` (GPIO16 RX) for `\n`-terminated JSON frames from STM32
4. For each valid frame:
   - `PUT /latest.json` — always overwrites with the newest reading
   - `PUT /history/<idx % 500>.json` — circular buffer of 500 slots
5. Uses `setInsecure()` on `WiFiClientSecure` (no cert pinning required for open Firebase rules)
6. Wi-Fi watchdog reconnects automatically if the connection drops

**Timestamp strategy:** NTP time is preferred. DS3231 timestamp passed from STM32 is used as a fallback only if NTP has not yet synced.

---

## Backend — Node.js Pipeline

Used for **local / development** mode when the ESP32 is not available.

### server.js

| Feature | Detail |
|---------|--------|
| Framework | Express 4 + Socket.IO 4 |
| Data source | MQTT broker (`vehicle/emissions` topic) |
| Storage | SQLite via `src/db.js` |
| REST API | `GET /api/history`, `GET /api/thresholds`, `POST /api/thresholds`, `GET /api/status` |
| Real-time | Socket.IO emits `telemetry` and `thresholds` events to connected browsers |

### serial-bridge.js

Reads UART frames from the STM32 USB virtual COM port and re-publishes them to the MQTT broker. Acts as a software replacement for the ESP32 Wi-Fi bridge.

```
STM32 USB COM port  →  serial-bridge.js  →  MQTT broker  →  server.js  →  browser
```

### simulate.js

Publishes random mock sensor payloads to the MQTT broker every 5 s. Use this to test the full pipeline without any hardware connected.

```bash
npm run simulate
```

---

## Vercel Dashboard

The production dashboard is a **single-file, zero-build HTML app** deployed on Vercel.

**URL:** https://vehicle-emission-monitor-embedded.vercel.app/

### Features

| Tab | Contents |
|-----|----------|
| 📡 **Live** | Sensor value cards (CO, NOx, Temp, Humidity) · Diagnostic Assessment Panel · CO & NOx chart · Temp & Humidity chart · Alarm log · Export CSV |
| 🗂 **History** | Last 15 Firebase records in a scrollable table with sticky header and Band classification column |
| ⚙️ **Settings** | Vehicle Emission Profile selector · Alert threshold sliders · Contact Us form |

### Header badges

| Badge | Meaning |
|-------|---------|
| 🟢 Firebase: Live | RTDB listener is receiving data |
| 🔴 Firebase: Connecting | No data received yet |
| 🟢 Engine: Running | `is_running = 1` in latest reading |
| 🔴 Engine: Stopped | `is_running = 0` |

### History table

- Fetches last 15 records sorted by `idx`; falls back to standard key order if the `idx` index is missing in Firebase
- Deadband filter applied: CO < 15 ppm → 0.00, NOx < 10 ppm → 0.00 (matches live dashboard)
- All numeric columns use monospace font for alignment
- Flexible engine-running check handles both `bool` and `int` values from Firebase

---

## Diagnostic Assessment

The Diagnostic Assessment Panel classifies every reading in real time using a **dynamic threshold formula** based on the selected vehicle profile.

### Band formula

```
OPTIMAL   ≤ 20% of Failure Limit       (catalytic converter scrubbing efficiently)
DEGRADED  20% – 100% of Failure Limit  (aging catalyst / rich mixture)
FAILURE   > 100% of Failure Limit      (emission control failure — PUC hazard)
```

The overall verdict is the worst band across both CO and NOx.

### Visual indicators

| Band | Colour | Verdict label |
|------|--------|---------------|
| 🟢 OPTIMAL | Emerald | Likely BS6 Compliant |
| 🟡 DEGRADED | Yellow | Maintenance Advised |
| 🔴 FAILURE | Red | Emission Control Failed |

Progress bars show the current reading as a percentage of the failure limit (capped at 100%).

---

## Vehicle Emission Profiles

| Profile | CO Failure Limit | NOx Failure Limit | CO Optimal | NOx Optimal |
|---------|-----------------|-------------------|------------|-------------|
| BS6 Petrol | 300 ppm | 150 ppm | < 60 ppm | < 30 ppm |
| BS6 Diesel | 150 ppm | 250 ppm | < 30 ppm | < 50 ppm |
| BS4 Petrol | 1000 ppm | 400 ppm | < 200 ppm | < 80 ppm |
| BS4 Diesel | 500 ppm | 600 ppm | < 100 ppm | < 120 ppm |

> Switching the profile instantly re-evaluates the live panel and all history rows without a page reload.

---

## Firebase Integration

The project uses **Firebase Realtime Database** (no Firestore, no Auth).

### Database structure

```
/latest
  ├── co          (number)   — latest CO reading in ppm
  ├── nox         (number)   — latest NOx reading in ppm
  ├── temp        (number)   — temperature in °C
  ├── hum         (number)   — humidity in % RH
  ├── is_running  (0 | 1)    — engine state
  ├── timestamp   (string)   — ISO 8601 (IST, Z-suffixed)
  └── idx         (number)   — reading index (increments each cycle)

/history
  └── 0 … 499               — circular buffer slots, same fields as /latest
```

### Dashboard SDK

Uses the Firebase compat SDK v9 (`firebase-app-compat`, `firebase-database-compat`) loaded from the gstatic CDN — no npm install needed.

### Timestamp note

The ESP32 NTP clock is set to IST (`UTC+5:30`) but `strftime` appends a `Z` suffix. The dashboard strips the `Z` before constructing `Date` objects so times display correctly regardless of the viewer's locale.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- An MQTT broker (e.g. [Mosquitto](https://mosquitto.org/)) on `localhost:1883` for local mode
- Arduino IDE with the ESP32 board package for flashing `main.ino`
- STM32CubeIDE or STM32CubeProgrammer for flashing `main.c` to the Black Pill

### 1. Clone and install

```bash
git clone https://github.com/vageeshgaonkar1-git/Vehicle_Emission_Monitor_Embedded.git
cd Vehicle_Emission_Monitor_Embedded
npm install
```

### 2a. Production mode (ESP32 + Firebase)

1. Flash `stm32/main.c` to the STM32F411 Black Pill via STM32CubeIDE.
2. Edit `esp32/main/main.ino` — set your Wi-Fi credentials:
   ```cpp
   const char* WIFI_SSID     = "YourSSID";
   const char* WIFI_PASSWORD = "YourPassword";
   ```
3. Flash `esp32/main/main.ino` via Arduino IDE with the **ESP32 board package** installed.
4. Open the live dashboard or deploy to Vercel:
   ```bash
   vercel deploy vercel-dashboard/
   ```

### 2b. Local / development mode (no ESP32)

Start a local MQTT broker first, then:

```bash
# Terminal 1 — backend server
npm start

# Terminal 2 — serial bridge (STM32 connected via USB)
SERIAL_PORT=COM3 npm run bridge

# Or use the simulator instead of real hardware
npm run simulate
```

Open `http://localhost:3000` in your browser.

---

## Environment Variables

| Variable | Default | Used by | Description |
|----------|---------|---------|-------------|
| `SERIAL_PORT` | `COM3` | `serial-bridge.js` | COM port of the STM32 Black Pill |
| `BAUD_RATE` | `115200` | `serial-bridge.js` | UART baud rate |
| `MQTT_URL` | `mqtt://localhost:1883` | `server.js`, `serial-bridge.js`, `simulate.js` | MQTT broker URL |
| `PORT` | `3000` | `server.js` | HTTP server port |
| `CO_THRESHOLD` | `50` | `server.js` | Initial CO alert threshold (ppm) |
| `NOX_THRESHOLD` | `25` | `server.js` | Initial NOx alert threshold (ppm) |
| `DB_PATH` | `emissions.db` | `src/db.js` | SQLite database file path |
| `INTERVAL_MS` | `5000` | `simulate.js` | Simulator publish interval (ms) |

---

## Running Tests

```bash
npm test
```

The test suite uses **Jest** with **fast-check** for property-based testing.

| Test file | Coverage |
|-----------|----------|
| `server.test.js` | REST API endpoints, WebSocket broadcast |
| `simulate.test.js` | Simulator MQTT publish |
| `db.property.test.js` | SQLite insert / query properties |
| `parser.property.test.js` | Payload validation edge cases |
| `uartFrame.property.test.js` | Frame format / parse round-trip |
| `dht22.property.test.js` | Gas correction formula properties |
| `alert.property.test.js` | Alert threshold evaluation |
| `broadcast.property.test.js` | Socket.IO broadcast properties |
| `chart.property.test.js` | Chart data windowing properties |

---

## Scripts Reference

```bash
npm start          # Start the Node.js backend server (local mode)
npm run simulate   # Publish mock sensor data to MQTT
npm run bridge     # Start the STM32 serial → MQTT bridge
npm test           # Run all Jest tests
```

---

## Dependencies

### Runtime

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^4.22 | HTTP server and REST API |
| `socket.io` | ^4.8 | Real-time WebSocket broadcast to browser |
| `mqtt` | ^5.3 | MQTT client (subscribe broker / publish from bridge) |
| `serialport` | ^13.0 | Read STM32 UART frames via USB COM port |
| `sqlite3` | ^5.1 | Local time-series storage |

### Dev / Test

| Package | Version | Purpose |
|---------|---------|---------|
| `jest` | ^29.7 | Test runner |
| `fast-check` | ^3.15 | Property-based testing |

### CDN (dashboard only — no install required)

| Library | Version | Purpose |
|---------|---------|---------|
| Tailwind CSS | CDN | Styling |
| Chart.js | 4.4.2 | Live line charts |
| Firebase JS SDK (compat) | 9.22.0 | Realtime Database listener |
| @formspree/ajax | 1.x | Contact Us form submission |

---

## Contact

Have a question, feature request, or found an issue? Use the **Contact Us** form in the dashboard's Settings tab, powered by [Formspree](https://formspree.io).

---

*Built with STM32 HAL · ESP32 Arduino Core · Node.js · Firebase RTDB · Chart.js · Tailwind CSS*
