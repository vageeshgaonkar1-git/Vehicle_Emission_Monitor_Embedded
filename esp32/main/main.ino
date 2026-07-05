/**
 * ESP32 Vehicle Emissions Monitor — Firebase REST Bridge
 *
 * Reads UART_Frames from STM32 over Serial2 and pushes
 * to Firebase Realtime Database using the built-in HTTPClient.
 * NO external Firebase library required — uses ESP32 built-ins only:
 *   WiFi.h, HTTPClient.h, WiFiClientSecure.h, ArduinoJson.h
 *
 * Wiring:
 *   STM32 PA2 (TX) → ESP32 GPIO16 (RX2)
 *   STM32 GND      → ESP32 GND
 *
 * Libraries needed (both come with ESP32 Arduino core):
 *   - WiFi.h         (built-in)
 *   - HTTPClient.h   (built-in)
 *   - ArduinoJson    by Benoit Blanchon v6.x (Library Manager)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

// ─── Wi-Fi ────────────────────────────────────────────────────────────────────
const char* WIFI_SSID     = "Motorolag64";
const char* WIFI_PASSWORD = "qwertyuiop";

// ─── Firebase REST endpoint ───────────────────────────────────────────────────
// Format: https://<project-id>-default-rtdb.firebaseio.com/<path>.json?auth=<apikey>
const char* FIREBASE_HOST = "vehicle-emission-monitor-12345-default-rtdb.firebaseio.com";
const char* FIREBASE_AUTH = "AIzaSyA3nP0sYeqeiCY6BDdI-Ha_AKs4gkxFxzk";

// ─── Serial2 (from STM32) ─────────────────────────────────────────────────────
const int  RX2_PIN   = 16;
const int  TX2_PIN   = 17;
const long UART_BAUD = 115200;

// ─── Globals ──────────────────────────────────────────────────────────────────
String uartBuffer   = "";
int    readingIndex = 0;

WiFiClientSecure secureClient;

// ─── Wi-Fi connect ────────────────────────────────────────────────────────────
void connectWiFi() {
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 40) {
    delay(500);
    Serial.print(".");
    retries++;
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[WiFi] Failed — will retry.");
  }
}

// ─── NTP timestamp fallback ───────────────────────────────────────────────────
String getISOTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "";
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S.000Z", &timeinfo);
  return String(buf);
}

// ─── Firebase PUT via HTTPS REST ─────────────────────────────────────────────
// path example: "/latest" or "/history/42"
bool firebasePut(const String& path, const String& jsonBody) {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = "https://" + String(FIREBASE_HOST) + path
               + ".json?auth=" + String(FIREBASE_AUTH);

  HTTPClient http;
  secureClient.setInsecure();   // skip cert validation (fine for open rules)
  http.begin(secureClient, url);
  http.addHeader("Content-Type", "application/json");

  int code = http.PUT(jsonBody);
  bool ok  = (code == 200 || code == 204);

  if (!ok) {
    Serial.printf("[Firebase] PUT %s -> HTTP %d  body: %s\n",
                  path.c_str(), code, http.getString().c_str());
  }
  http.end();
  return ok;
}

// ─── Process a complete UART frame ────────────────────────────────────────────
void processFrame(const String& raw) {
  // 1. Parse and validate JSON
  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, raw);
  if (err) {
    Serial.printf("[Bridge] Bad JSON (%s): %s\n", err.c_str(), raw.c_str());
    return;
  }

  float co         = doc["co"]         | 0.0f;
  float nox        = doc["nox"]        | 0.0f;
  float temp       = doc["temp"]       | 0.0f;
  float hum        = doc["hum"]        | 0.0f;
  int   is_running = doc["is_running"] | 0;
  const char* ts   = doc["timestamp"]  | "";
  // Always use ESP32 NTP time — more reliable than DS3231 over UART.
  // STM32 timestamp is only used as last resort if NTP hasn't synced yet.
  String ntpTime   = getISOTime();
  String timestamp = (ntpTime.length() > 10) ? ntpTime
                   : ((ts && strlen(ts) > 4) ? String(ts) : "1970-01-01T00:00:00.000Z");

  // 2. Build JSON payload for Firebase
  char body[256];
  snprintf(body, sizeof(body),
    "{\"co\":%.2f,\"nox\":%.2f,\"temp\":%.2f,\"hum\":%.2f,"
    "\"is_running\":%d,\"timestamp\":\"%s\",\"idx\":%d}",
    co, nox, temp, hum, is_running, timestamp.c_str(), readingIndex);

  // 3. PUT to /latest  (overwrites — always shows newest reading)
  if (firebasePut("/latest", body)) {
    Serial.printf("[Firebase] /latest updated: co=%.2f nox=%.2f temp=%.1f\n",
                  co, nox, temp);
  }

  // 4. PUT to /history/<slot>  (circular buffer of 500)
  String histPath = "/history/" + String(readingIndex % 500);
  if (firebasePut(histPath, body)) {
    Serial.printf("[Firebase] /history/%d written\n", readingIndex % 500);
  }

  readingIndex++;
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[Bridge] ESP32 Firebase REST Bridge starting...");

  Serial2.begin(UART_BAUD, SERIAL_8N1, RX2_PIN, TX2_PIN);
  Serial.printf("[Bridge] Serial2 GPIO%d(RX)/GPIO%d(TX) at %ld baud\n",
                RX2_PIN, TX2_PIN, UART_BAUD);

  connectWiFi();

  // Sync NTP time — IST = UTC+5:30 = 19800 seconds offset
  configTime(19800, 0, "pool.ntp.org", "time.nist.gov");
  Serial.println("[NTP] Syncing time...");
  delay(3000);
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
void loop() {
  // Wi-Fi watchdog
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Disconnected — reconnecting...");
    connectWiFi();
  }

  // Read UART from STM32
  while (Serial2.available()) {
    char c = (char)Serial2.read();
    if (c == '\n') {
      uartBuffer.trim();
      if (uartBuffer.length() > 0) {
        processFrame(uartBuffer);
      }
      uartBuffer = "";
    } else {
      if (uartBuffer.length() < 512) {
        uartBuffer += c;
      } else {
        Serial.println("[Bridge] Buffer overflow — discarding.");
        uartBuffer = "";
      }
    }
  }
}
