'use strict';

const mqtt    = require('mqtt');
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const { initDb, insertRecord, queryHistory } = require('./src/db');
const { parsePayload }                       = require('./src/parser');

// ── Configuration ────────────────────────────────────────────────────────────
// The ESP32 now bridges STM32 UART → MQTT Wi-Fi.
// server.js subscribes to the MQTT broker; no serial port is needed here.
const MQTT_URL   = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_TOPIC = 'vehicle/emissions';
const WEB_PORT   = parseInt(process.env.PORT || '3000', 10);

// Runtime-adjustable alert thresholds (updated via POST /api/thresholds)
let thresholds = {
  co:  parseFloat(process.env.CO_THRESHOLD  || '50'),
  nox: parseFloat(process.env.NOX_THRESHOLD || '25'),
};

// Connection state exposed to the status endpoint
// With ESP32 integration, 'serial' reflects MQTT connectivity (no direct serial port).
const connStatus = { serial: false, mqtt: false };

// ── Web Server & WebSockets ──────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/history?limit=N  — returns last N rows (default 100)
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
    const rows  = await queryHistory(limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/thresholds  — returns current thresholds
app.get('/api/thresholds', (req, res) => {
  res.json(thresholds);
});

// POST /api/thresholds  — { co: number, nox: number }
app.post('/api/thresholds', (req, res) => {
  const { co, nox } = req.body;
  if (typeof co  === 'number' && isFinite(co)  && co  >= 0) thresholds.co  = co;
  if (typeof nox === 'number' && isFinite(nox) && nox >= 0) thresholds.nox = nox;
  io.emit('thresholds', thresholds);
  res.json(thresholds);
});

// GET /api/status  — heartbeat / connection health
app.get('/api/status', (req, res) => {
  res.json(connStatus);
});

// ── WebSocket connections ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Send current status immediately so the browser doesn't wait for an event
  socket.emit('conn_status', connStatus);
});

// ── MQTT Client ──────────────────────────────────────────────────────────────
const mqttClient = mqtt.connect(MQTT_URL, {
  clientId: 'server-dashboard-' + Math.random().toString(16).slice(2, 8),
  clean: true,
});

// Register message handler BEFORE connect fires to avoid race conditions
mqttClient.on('message', async (topic, messageBuffer) => {
  console.log(`[MQTT] message on "${topic}": ${messageBuffer.toString()}`);

  if (topic !== MQTT_TOPIC) return;

  const result = parsePayload(messageBuffer);
  if (!result.ok) {
    console.error('[Pipeline] Parse error:', result.error, '|', messageBuffer.toString());
    return;
  }

  const record = result.data;

  // 1. Persist to SQLite
  try {
    const { id, timestamp } = await insertRecord(record);
    console.log(`[DB] Inserted id=${id} ts=${timestamp}`);
  } catch (err) {
    console.error('[DB] Write error:', err.message);
  }

  // 2. Push to browser with current thresholds attached
  io.emit('telemetry', { ...record, thresholds });
  console.log('[WS] Emitted telemetry to', io.engine.clientsCount, 'client(s)');
});

mqttClient.on('connect', () => {
  connStatus.mqtt   = true;
  connStatus.serial = true;
  console.log('[MQTT] Connected to broker at', MQTT_URL);
  io.emit('conn_status', connStatus);

  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) console.error('[MQTT] Subscribe error:', err.message);
    else console.log('[MQTT] Subscribed to', MQTT_TOPIC);
  });
});

mqttClient.on('error', (err) => {
  connStatus.mqtt   = false;
  connStatus.serial = false;
  console.error('[MQTT] Error:', err.message);
  io.emit('conn_status', connStatus);
});

mqttClient.on('close', () => {
  connStatus.mqtt   = false;
  connStatus.serial = false;
  io.emit('conn_status', connStatus);
});

// ── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  await initDb();

  httpServer.listen(WEB_PORT, () => {
    console.log(`[WebUI] Dashboard → http://localhost:${WEB_PORT}`);
  });
}

start().catch((err) => {
  console.error('[Startup] Fatal:', err.message);
  process.exit(1);
});
