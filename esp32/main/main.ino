/**
 * ESP32 Vehicle Emissions Monitor — Firebase Bridge
 *
 * Reads UART_Frames from the STM32 over Serial2, validates JSON,
 * and pushes each reading directly to Firebase Realtime Database over HTTPS.
 *
 * Wiring:
 *   STM32 PA2 (TX)  →  ESP32 GPIO16 (RX2)
 *   STM32 GND       →  ESP32 GND
 *
 * Libraries required (Arduino Library Manager):
 *   - ArduinoJson    by Benoit Blanchon  (v6.x)
 *   - Firebase ESP Client  by Mobizt    (search: "Firebase ESP Client")
 */

#include <WiFi.h>
#include <FirebaseESP32.h>
#include <ArduinoJson.h>
#include <time.h>

// ─── Wi-Fi ────────────────────────────────────────────────────────────────────
const char* WIFI_SSID     = "Motorolag64";
const char* WIFI_PASSWORD = "qwertyuiop";

// ─── Firebase ─────────────────────────────────────────────────────────────────
#define FIREBASE_HOST  "vehicle-emission-monitor-12345-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH  "AIzaSyA3nP0sYeqeiCY6BDdI-Ha_AKs4gkxFxzk"

// ─── Serial2 (from STM32) ─────────────────────────────────────────────────────
const int  RX2_PIN   = 16;
const int  TX2_PIN   = 17;
const long UART_BAUD = 115200;

// ─── Globals ──────────────────────────────────────────────────────────────────
FirebaseData   fbData;
FirebaseAuth   fbAuth;
FirebaseConfig fbConfig;

String uartBuffer = "";
int    readingIndex = 0;   // incremental key for history entries

// ─── Wi-Fi ────────────────────────────────────────────────────────────────────
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
    Serial.println("[WiFi] Failed — will retry in loop.");
  }
}

// ─── Process a complete frame ─────────────────────────────────────────────────
void processFrame(const String& raw) {
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

  // Use ESP32 time if STM32 timestamp is empty
  String timestamp = (ts && strlen(ts) > 0) ? String(ts) : getISOTime();

  if (!Firebase.ready()) {
    Serial.println("[Firebase] Not ready — frame dropped.");
    return;
  }

  // ── Write /latest (always overwrite with most recent reading) ────────────
  FirebaseJson latest;
  latest.set("co",         co);
  latest.set("nox",        nox);
  latest.set("temp",       temp);
  latest.set("hum",        hum);
  latest.set("is_running", is_running);
  latest.set("timestamp",  timestamp);

  if (Firebase.setJSON(fbData, "/latest", latest)) {
    Serial.printf("[Firebase] /latest updated: co=%.2f nox=%.2f temp=%.1f\n", co, nox, temp);
  } else {
    Serial.printf("[Firebase] /latest error: %s\n", fbData.errorReason().c_str());
  }

  // ── Append to /history (keep last 500 readings) ──────────────────────────
  String histPath = "/history/" + String(readingIndex % 500);
  FirebaseJson histEntry;
  histEntry.set("co",         co);
  histEntry.set("nox",        nox);
  histEntry.set("temp",       temp);
  histEntry.set("hum",        hum);
  histEntry.set("is_running", is_running);
  histEntry.set("timestamp",  timestamp);
  histEntry.set("idx",        readingIndex);

  if (Firebase.setJSON(fbData, histPath, histEntry)) {
    Serial.printf("[Firebase] /history/%d written\n", readingIndex % 500);
  } else {
    Serial.printf("[Firebase] /history error: %s\n", fbData.errorReason().c_str());
  }

  readingIndex++;
}

// ─── NTP timestamp fallback ───────────────────────────────────────────────────
String getISOTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "1970-01-01T00:00:00.000Z";
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S.000Z", &timeinfo);
  return String(buf);
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[Bridge] ESP32 Firebase Bridge starting...");

  Serial2.begin(UART_BAUD, SERIAL_8N1, RX2_PIN, TX2_PIN);
  Serial.printf("[Bridge] Serial2 GPIO%d(RX)/GPIO%d(TX) at %ld baud\n",
                RX2_PIN, TX2_PIN, UART_BAUD);

  connectWiFi();

  // Sync time via NTP (used as fallback timestamp)
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  // Firebase init
  fbConfig.host           = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;

  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);
  Firebase.setDoubleDigits(2);

  Serial.println("[Firebase] Initialised.");
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
