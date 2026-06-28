// UART_Frame formatter
// Mirrors the STM32 logic: produces a minified JSON string terminated by \n.
// Used by Node.js utilities and tests; the ESP32 reads until \n to capture a complete frame.

'use strict';

/**
 * Format sensor values into a UART_Frame string.
 *
 * @param {object} values - { co, nox, temp, hum, is_running, timestamp }
 * @returns {string} Minified JSON terminated by \n
 */
function formatFrame(values) {
  const frame = {
    co: values.co,
    nox: values.nox,
    temp: values.temp,
    hum: values.hum,
    is_running: values.is_running,
    timestamp: values.timestamp,
  };
  return JSON.stringify(frame) + '\n';
}

/**
 * Parse a UART_Frame string back into sensor values.
 *
 * @param {string} frame - Minified JSON string (with or without trailing \n)
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
function parseFrame(frame) {
  try {
    const data = JSON.parse(frame.trim());
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Frame parse error: ${e.message}` };
  }
}

/**
 * DHT22 environmental correction — mirrors STM32 dht22_correct_gas() (Requirement 13.2).
 *
 * Applies a temperature and humidity compensation factor to a raw 12-bit ADC
 * reading from an MQ-series gas sensor and returns a corrected, non-negative
 * gas concentration value.
 *
 * @param {number} rawAdc     - 12-bit ADC reading (0–4095)
 * @param {number} temperature - DHT22 temperature in °C (−40 to 80)
 * @param {number} humidity    - DHT22 relative humidity in % (0 to 100)
 * @returns {number} Corrected gas concentration (non-negative finite float)
 */
function dht22CorrectGas(rawAdc, temperature, humidity) {
  const T_REF  = 20.0;
  const H_REF  = 65.0;
  const K_TEMP = 0.005;
  const K_HUM  = 0.002;
  const V_REF  = 3.3;
  const V_MAX  = 4095.0;
  const R_LOAD = 10.0;

  let voltage = (rawAdc / V_MAX) * V_REF;
  if (voltage < 0.001) voltage = 0.001;

  let rs = R_LOAD * (V_REF - voltage) / voltage;
  if (rs < 0.0) rs = 0.0;

  let correction = 1.0
    + K_TEMP * (temperature - T_REF)
    + K_HUM  * (humidity    - H_REF);

  if (correction < 0.01) correction = 0.01;

  let concentration = rs / correction;
  if (concentration < 0.0) concentration = 0.0;

  return concentration;
}

module.exports = { formatFrame, parseFrame, dht22CorrectGas };
