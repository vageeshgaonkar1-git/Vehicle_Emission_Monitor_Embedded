# 🛡️ Vehicle Emissions Monitor

A full-stack embedded system that measures, analyses, and visualises real-time vehicle exhaust emissions. The system combines STM32 microcontroller firmware, an ESP32 Wi-Fi bridge, a Node.js data pipeline, and a live Firebase-powered dashboard deployed on Vercel — all wired together into a single, end-to-end emissions monitoring solution.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Hardware Components](#hardware-components)
4. [Wiring Diagram](#wiring-diagram)
5. [Project Structure](#project-structure)
6. [Firmware](#firmware)
   - [STM32 (main.c)](#stm32-mainc)
   - [ESP32 (main.ino)](#esp32-mainino)
7. [Backend — Node.js Pipeline](#backend--nodejs-pipeline)
8. [Vercel Dashboard](#vercel-dashboard)
9. [Diagnostic Assessment](#diagnostic-assessment)
10. [Vehicle Emission Profiles](#vehicle-emission-profiles)
11. [Firebase Integration](#firebase-integration)
12. [Getting Started](#getting-started)
13. [Environment Variables](#environment-variables)
14. [Running Tests](#running-tests)
15. [Scripts Reference](#scripts-reference)
16. [Dependencies](#dependencies)
17. [Contact](#contact)

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
│  DHT22 ──────┼──► STM32 Nucleo-F446RE ──UART2(115200)──► ESP32  │
│  MPU-6050 ───┤    (main.c)                              (main.ino)│
│  DS3231 RTC ─┘                                            │     │
└───────────────────────────────────────────────────────────┼─────┘
                                                            │ HTTPS REST
                                                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       FIREBASE RTDB                             │
│   /latest   — most recent single reading (always overwritten)   │
│   /history  — circular buffer of 500 readings, keyed by slot    │
└────────────────────────────┬────────────────────────────────────┘
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

| Component | Role |
|-----------|------|
| STM32 Nucleo-F446RE | Main MCU — reads all sensors, runs purge/settle/sample state machine, transmits UART frames |
| ESP32 (generic 30-pin) | Wi-Fi bridge — receives UART frames from STM32, pushes to Firebase via HTTPS REST |
| MQ-7 | Electrochemical CO sensor (PA0, ADC channel 0) |
| MQ-135 | Air quality / NOx sensor (PA1, ADC channel 1) |
| DHT22 | Temperature and humidity sensor (PA3, GPIO bit-bang) |
| MPU-6050 | 3-axis accelerometer for engine vibration detection (I2C1 — SCL PB6, SDA PB7) |
| DS3231 RTC | Real-time clock for accurate ISO 8601 timestamps (I2C1 shared with MPU-6050) |
| 10 kΩ resistors (×2) | RL load resistors for MQ-7 and MQ-135 |
| Fan / relay | Purge fan on PA5 — clears exhaust gases between samples |

---

## Wiring Diagram

```
STM32 Nucleo-F446RE
┌────────────────────────────────┐
│ PA0  ──────────────────────── MQ-7  AOUT  (+5V, GND, 10kΩ RL to GND) │
│ PA1  ──────────────────────── MQ-135 AOUT (+5V, GND, 10kΩ RL to GND) │
│ PA3  ──────────────────────── DHT22 DATA  (3.3V, GND, 10kΩ pull-up)   │
│ PA5  ──────────────────────── Fan relay IN                             │
│ PA2 (UART2 TX) ─────────────► ESP32 GPIO16 (RX2)                      │
│ PB6 (I2C1 SCL) ─────────────► MPU-6050 SCL  &  DS3231 SCL             │
│ PB7 (I2C1 SDA) ─────────────► MPU-6050 SDA  &  DS3231 SDA             │
│ GND ────────────────────────── ESP32 GND                               │
└────────────────────────────────┘
```

> **Note:** MQ-7 and MQ-135 require 5V Vcc for correct sensitivity. The STM32 ADC is 3.3V max — use a voltage divider on the sensor AOUT pin if needed.

---

## Project Structure

```
.
├── esp32/
│   └── main/
│       └── main.ino          # ESP32 Firebase REST bridge firmware
├── stm32/
│   └── main.c                # STM32 sensor firmware (HAL, no RTOS)
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

Written in bare-metal C using the STM32 HAL library. No RTOS is used.

**Measurement cycle — 25 s total:**

```
┌─────────────┐    15 s    ┌─────────────┐   10 s   ┌─────────────┐
│  PURGE      │──────────►│  SETTLE     │─────────►│  SAMPLE     │
│  Fan ON     │            │  Fan OFF    │           │  Read all   │
│             │            │  Poll MPU   │           │  Transmit   │
│             │            │  every 1 s  │           │  UART frame │
└─────────────┘            └─────────────┘           └─────────────┘
```

**Key constants (overridable at compile time):**

| Macro | Default | Description |
|-------|---------|-------------|
| `PURGE_MS` | 15 000 ms | Fan-on duration |
| `SETTLE_MS` | 10 000 ms | Fan-off settle duration |
| `VIBRATION_THRESHOLD` | 100 LSB | MPU-6050 acceleration threshold for engine-running detection |

**Sensor read functions:**

| Function | Sensor | Output |
|----------|--------|--------|
| `mq7_read_ppm()` | MQ-7 on PA0 | CO concentration (Rs in kΩ mapped to ppm range) |
| `mq135_read_ppm()` | MQ-135 on PA1 | NOx / air quality (Rs in kΩ) |
| `dht22_read()` | DHT22 on PA3 | Temperature (°C), Humidity (% RH) |
| `mpu6050_is_running()` | MPU-6050 on I2C1 | 1 = engine running, 0 = stopped |
| `ds3231_get_timestamp()` | DS3231 on I2C1 | ISO 8601 string |

**UART Frame format (JSON, newline-terminated):**

```json
{"co":45.12,"nox":18.30,"temp":32.5,"hum":61.2,"is_running":1,"timestamp":"2026-07-05T14:30:00.000"}
```

All I2C calls use a **50 ms timeout** (not `HAL_MAX_DELAY`) to prevent the state machine from hanging on missing peripherals.

---

### ESP32 (main.ino)

Uses only the **built-in ESP32 Arduino core** — no external Firebase library required.

| Library | Source |
|---------|--------|
| `WiFi.h` | ESP32 Arduino core (built-in) |
| `HTTPClient.h` | ESP32 Arduino core (built-in) |
| `WiFiClientSecure.h` | ESP32 Arduino core (built-in) |
| `ArduinoJson` v6.x | Arduino Library Manager |

**Flow:**

1. Connect to Wi-Fi (`WIFI_SSID` / `WIFI_PASSWORD`)
2. Sync NTP time — IST offset `configTime(19800, 0, "pool.ntp.org", ...)`
3. Listen on `Serial2` (GPIO16 RX) for newline-terminated JSON frames
4. For each valid frame:
   - `PUT /latest.json` — always overwrites with the newest reading
   - `PUT /history/<idx % 500>.json` — circular buffer of 500 slots
5. Uses `setInsecure()` on `WiFiClientSecure` (no certificate pinning needed for Firebase open rules)

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

Reads UART frames from the STM32 Nucleo USB virtual COM port and re-publishes them to the MQTT broker. Acts as a software replacement for the ESP32 Wi-Fi bridge.

```
STM32 USB COM port  →  serial-bridge.js  →  MQTT broker  →  server.js  →  browser
```

### simulate.js

Publishes random mock sensor payloads to the MQTT broker every 5 s (configurable). Use this to test the full pipeline without any hardware connected.

```bash
npm run simulate
```

---

## Vercel Dashboard

The production dashboard is a **single-file, zero-build HTML app** deployed on Vercel.

**URL:** `https://vehicle-emission-monitor-embedded.vercel.app/`

### Features

| Tab | Contents |
|-----|----------|
| 📡 **Live** | Sensor value cards (CO, NOx, Temp, Humidity) · Diagnostic Assessment Panel · CO & NOx chart · Temp & Humidity chart · Alarm log · Export CSV |
| 🗂 **History** | Last 100 Firebase records in a table with Band classification column |
| ⚙️ **Settings** | Vehicle Emission Profile selector · Alert threshold sliders · Contact Us form |

### Header badges

| Badge | Meaning |
|-------|---------|
| 🟢 Firebase: Live | RTDB listener is receiving data |
| 🔴 Firebase: Connecting | No data received yet |
| 🟢 Engine: Running | `is_running = 1` in latest reading |
| 🔴 Engine: Stopped | `is_running = 0` |

---

## Diagnostic Assessment

The Diagnostic Assessment Panel classifies every reading in real time using a **dynamic threshold formula** based on the selected vehicle profile.

### Band formula

```
OPTIMAL   ≤ 20% of Failure Limit       (catalytic converter scrubbing efficiently)
DEGRADED  20% – 100% of Failure Limit  (aging catalyst / rich mixture)
FAILURE   > 100% of Failure Limit      (emission control failure — PUC hazard)
```

The **overall verdict** is the worst band across both CO and NOx.

### Visual indicators

| Band | Colour | Verdict label |
|------|--------|---------------|
| 🟢 OPTIMAL | Emerald | Likely BS6 Compliant |
| 🟡 DEGRADED | Yellow | Maintenance Advised |
| 🔴 FAILURE | Red | Emission Control Failed |

Progress bars show the current reading as a percentage of the failure limit (capped at 100%).

---

## Vehicle Emission Profiles

The failure limits that define the three bands. Derived optimal/degraded cutoffs are shown in the Settings tab.

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
  └── idx         (number)   — reading index

/history
  └── 0 … 499               — circular buffer slots, same fields as /latest
```

### Dashboard SDK

Uses the Firebase compat SDK v9 (`firebase-app-compat`, `firebase-database-compat`) loaded from the gstatic CDN — no npm install needed.

### Timestamp note

The ESP32 NTP clock is set to IST (`UTC+5:30`) but `strftime` appends a `Z` suffix (UTC marker). The dashboard strips the `Z` before constructing `Date` objects so times display correctly regardless of the viewer's locale.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- An MQTT broker (e.g. [Mosquitto](https://mosquitto.org/)) running on `localhost:1883` for local mode
- Arduino IDE (for flashing ESP32 / STM32)
- STM32CubeIDE or STM32CubeProgrammer (for STM32)

### 1. Clone and install

```bash
git clone https://github.com/vageeshgaonkar1-git/Vehicle_Emission_Monitor_Embedded.git
cd Vehicle_Emission_Monitor_Embedded
npm install
```

### 2a. Production mode (ESP32 + Firebase)

1. Flash `stm32/main.c` to the Nucleo board via STM32CubeIDE.
2. Edit `esp32/main/main.ino` — set your Wi-Fi credentials:
   ```cpp
   const char* WIFI_SSID     = "YourSSID";
   const char* WIFI_PASSWORD = "YourPassword";
   ```
3. Flash `esp32/main/main.ino` via Arduino IDE with the **ESP32 board package** installed.
4. Open `vercel-dashboard/index.html` in a browser, or deploy to Vercel:
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
| `SERIAL_PORT` | `COM3` | `serial-bridge.js` | COM port of the STM32 Nucleo board |
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
