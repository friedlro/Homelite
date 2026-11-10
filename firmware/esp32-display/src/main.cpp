// HomeLite-Bedienpanel für den ESP32 mit SPI-Displays (ILI9341/ILI9486/ILI9488/ST7796/ST7789, Waveshare 3.5" RPi LCD, CYD)
// Display, Pins und Touch werden je Umgebung in platformio.ini per Build-Flags gewählt (siehe README.md).
//
// Spricht das Protokoll des HomeLite-Plugins "ESP32-Display" (Text über MQTT, siehe dessen LIESMICH.md):
//   ESP32 -> HomeLite:  <Präfix>/<ID>/status  online|offline (retained, Last Will)
//                       <Präfix>/<ID>/hello   gespeicherter Layout-Hash (leer = keiner)
//                       <Präfix>/<ID>/tap     Kachel-Nummer (tid)
//   HomeLite -> ESP32:  <Präfix>/<ID>/layout/<n>   Seite n:  H|hash|anzahl  /  P|n|name  /  T|tid|art|label|einheit
//                       <Präfix>/<ID>/v            Werte:    <tid>=<wert> je Zeile
//                       <Präfix>/<ID>/cfg          b=<Helligkeit 0-100>  (wirkt nur mit PWM-Hintergrundlicht, Flag TFT_BL)
// Seiten und Kacheln werden in HomeLite zusammengestellt; die Firmware zeichnet sie nur.

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <time.h>
#include <TFT_eSPI.h>
#include "config.h"

// ---- Optionen mit Standardwerten (config.h oder Build-Flags überschreiben sie) ----
#ifndef ROTATION
#define ROTATION 1
#endif
#ifndef SAVER_BACKLIGHT
#define SAVER_BACKLIGHT -1
#endif

// ---- Touch-Variante: TFT_eSPI-intern (TOUCH_CS), eigener XPT2046-Bus (TOUCH_RAW) oder keiner ----
#if defined(TOUCH_RAW)
#include <SPI.h>
#include <XPT2046_Touchscreen.h>
#define HAS_TOUCH 1
#elif defined(TOUCH_CS)
#define HAS_TOUCH 1
#else
#define HAS_TOUCH 0
#endif

#define RGB(r, g, b) ((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))
static const uint16_t C_BG = RGB(10, 14, 24);
static const uint16_t C_HEAD = RGB(22, 30, 52);
static const uint16_t C_TILE = RGB(32, 52, 96);
static const uint16_t C_SUB = RGB(170, 180, 200);
static const uint16_t C_ON = RGB(30, 150, 80);
static const uint16_t C_OFF = RGB(70, 76, 92);
static const uint16_t C_BTN = RGB(48, 70, 120);
static const uint16_t C_WARN = RGB(200, 140, 20);
static const uint16_t C_ERR = RGB(200, 50, 50);

static const int MAXP = 8;    // Seiten (wie im Plugin)
static const int MAXT = 12;   // Kacheln je Seite (wie im Plugin)
static const uint16_t TOUCH_Z = 350;
TFT_eSPI tft = TFT_eSPI();

// Geometrie wird aus der Displaygröße berechnet (computeGeometry), damit alle Auflösungen/Ausrichtungen passen
static int SCR_W, SCR_H;
static int COLS, ROWS, TILE_W, TILE_H, TILE_GX, TILE_GY, TILE_X0;
static const int TILE_Y0 = 44, GAP = 5;
static int FTR_Y, FTR_H, BTN_W, KAL_X, PREV_X, NEXT_X;

static void computeGeometry() {
  SCR_W = tft.width();
  SCR_H = tft.height();
  FTR_H = SCR_H >= 300 ? 44 : 38;
  FTR_Y = SCR_H - FTR_H - 4;
  COLS = SCR_W >= SCR_H ? 4 : 3;
  ROWS = 12 / COLS;
  TILE_W = (SCR_W - 12 - (COLS - 1) * GAP) / COLS;
  TILE_H = (FTR_Y - 4 - TILE_Y0 - (ROWS - 1) * GAP) / ROWS;
  TILE_GX = TILE_W + GAP;
  TILE_GY = TILE_H + GAP;
  TILE_X0 = (SCR_W - (COLS * TILE_W + (COLS - 1) * GAP)) / 2;
  BTN_W = SCR_W >= 400 ? 70 : 62;
  KAL_X = 8;
  PREV_X = KAL_X + BTN_W + 8;
  NEXT_X = SCR_W - 8 - BTN_W;
}

Preferences prefs;
WiFiClient wifi;
PubSubClient mqtt(wifi);
static bool saverOn = false;  // Bildschirmschoner aktiv: normale Zeichenfunktionen schweigen

// ---------- Layout ----------
enum Kind : uint8_t { K_VALUE, K_TOGGLE, K_STATE };
struct Tile {
  uint16_t tid = 0;
  Kind kind = K_VALUE;
  String label, unit, val = "-";
};
struct Page {
  String name;
  Tile tiles[MAXT];
  uint8_t n = 0;
};
static Page pages[MAXP];
static String pageRaw[MAXP];     // Rohtext der Layout-Nachrichten (zum Speichern im Flash)
static int nPages = 0;           // gültig, wenn layoutOk
static int pagesExpected = 0;
static uint8_t gotMask = 0;
static String pendingHash, layoutHash;
static bool layoutOk = false;
static int curPage = 0;
static int bright = -1;          // letzter cfg-Wert (0-100), wirkt nur mit PWM-Hintergrundlicht (TFT_BL)

static String tTopic(const char* sub) { return String(MQTT_PREFIX) + "/" + DISPLAY_ID + "/" + sub; }

// ---------- Hintergrundlicht (PWM, nur wenn das Board TFT_BL definiert) ----------
#if defined(TFT_BL)
static void blInit() { ledcSetup(0, 5000, 8); ledcAttachPin(TFT_BL, 0); }
static void blSet(int pct) { ledcWrite(0, constrain(pct, 0, 100) * 255 / 100); }
#else
static void blInit() {}
static void blSet(int) {}
#endif
static void applyBacklight() {
  if (saverOn && SAVER_BACKLIGHT >= 0) blSet(SAVER_BACKLIGHT);
  else blSet(bright < 0 ? 100 : bright);
}

// ---------- Text (eingebaute Fonts haben keine Umlaute) ----------
static String ascii(const String& s) {
  String o;
  for (size_t i = 0; i < s.length(); i++) {
    uint8_t c = s[i];
    if (c == 0xC3 && i + 1 < s.length()) {
      uint8_t d = s[++i];
      switch (d) {
        case 0xA4: o += "ae"; break;
        case 0xB6: o += "oe"; break;
        case 0xBC: o += "ue"; break;
        case 0x84: o += "Ae"; break;
        case 0x96: o += "Oe"; break;
        case 0x9C: o += "Ue"; break;
        case 0x9F: o += "ss"; break;
        default: o += '?';
      }
    } else if (c == 0xC2 && i + 1 < s.length()) {
      i++;  // z. B. Gradzeichen überspringen
    } else if (c < 0x80) {
      o += (char)c;
    } else if (c >= 0xC0) {
      o += '?';
    }
  }
  return o;
}

static String fit(const String& s, int maxW, int font) {
  String t = s;
  if (tft.textWidth(t, font) <= maxW) return t;
  while (t.length() > 1 && tft.textWidth(t + "..", font) > maxW) t.remove(t.length() - 1);
  return t + "..";
}

static int splitFields(const String& s, char sep, String* out, int maxN) {
  int n = 0, start = 0, len = s.length();
  for (int i = 0; i <= len && n < maxN; i++) {
    if (i == len || s[i] == sep) { out[n++] = s.substring(start, i); start = i + 1; }
  }
  return n;
}

// ---------- Layout einlesen ----------
static void applyLayoutPage(const String& text, int n) {
  int cur = n;
  int p = 0;
  while (p < (int)text.length()) {
    int e = text.indexOf('\n', p);
    if (e < 0) e = text.length();
    String line = text.substring(p, e);
    p = e + 1;
    line.trim();
    if (!line.length()) continue;
    String f[5];
    int c = splitFields(line, '|', f, 5);
    if (f[0] == "H" && c >= 3) {
      pendingHash = f[1];
      pagesExpected = constrain(f[2].toInt(), 0, MAXP);
      for (int i = 0; i < MAXP; i++) pages[i] = Page();
      gotMask = 0;
    } else if (f[0] == "P" && c >= 3) {
      cur = f[1].toInt();
      if (cur < 0 || cur >= MAXP) return;
      pages[cur].name = f[2];
      pages[cur].n = 0;
    } else if (f[0] == "T" && c >= 4 && cur >= 0 && cur < MAXP && pages[cur].n < MAXT) {
      Tile& t = pages[cur].tiles[pages[cur].n++];
      t.tid = f[1].toInt();
      t.kind = f[2] == "toggle" ? K_TOGGLE : (f[2] == "state" ? K_STATE : K_VALUE);
      t.label = f[3];
      t.unit = c >= 5 ? f[4] : String("");
      t.val = "-";
    }
  }
  if (n >= 0 && n < MAXP) gotMask |= (1 << n);
}

static void loadLayout() {
  String h = prefs.getString("hash", "");
  int np = prefs.getUChar("np", 0);
  if (!h.length() || np <= 0 || np > MAXP) return;
  for (int i = 0; i < np; i++) {
    pageRaw[i] = prefs.getString((String("L") + i).c_str(), "");
    if (!pageRaw[i].length()) return;  // unvollständig -> neu anfordern
  }
  for (int i = 0; i < np; i++) applyLayoutPage(pageRaw[i], i);
  layoutHash = h;
  nPages = np;
  layoutOk = true;
}

static void saveLayout() {
  prefs.putString("hash", layoutHash);
  prefs.putUChar("np", nPages);
  for (int i = 0; i < nPages; i++) prefs.putString((String("L") + i).c_str(), pageRaw[i]);
}

// ---------- Zeichnen ----------
static String shownStatus;
static bool shownOk = false;

static String statusText() {
  if (WiFi.status() != WL_CONNECTED) return "kein WLAN";
  if (!mqtt.connected()) return "MQTT ...";
  return "";
}

static void drawHeader() {
  if (saverOn) return;
  tft.fillRect(0, 0, SCR_W, 36, C_HEAD);
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(TFT_WHITE, C_HEAD);
  String title = (layoutOk && nPages > 0) ? pages[curPage].name : String("HomeLite Panel");
  tft.drawString(fit(ascii(title), SCR_W - 130, 4), 10, 18, 4);
  tft.fillCircle(SCR_W - 14, 18, 6, mqtt.connected() ? C_ON : C_ERR);
  tft.setTextDatum(MR_DATUM);
  tft.setTextColor(C_SUB, C_HEAD);
  tft.drawString(fit(ascii(shownStatus), 100, 2), SCR_W - 26, 18, 2);
}

static void tileRect(int ti, int& x, int& y) {
  x = TILE_X0 + (ti % COLS) * TILE_GX;
  y = TILE_Y0 + (ti / COLS) * TILE_GY;
}

static void drawTile(int pi, int ti) {
  if (saverOn || pi != curPage || pi >= nPages || ti >= pages[pi].n) return;
  Tile& t = pages[pi].tiles[ti];
  int x, y;
  tileRect(ti, x, y);
  bool bin = (t.kind != K_VALUE) && (t.val == "1" || t.val == "0");
  uint16_t col = bin ? (t.val == "1" ? C_ON : C_OFF) : C_TILE;
  tft.fillRoundRect(x, y, TILE_W, TILE_H, 8, col);
  if (t.kind == K_TOGGLE) tft.drawRoundRect(x, y, TILE_W, TILE_H, 8, RGB(190, 200, 225));
  tft.setTextDatum(TC_DATUM);
  tft.setTextColor(RGB(215, 220, 235), col);
  tft.drawString(fit(ascii(t.label), TILE_W - 8, 2), x + TILE_W / 2, y + 3, 2);
  String v = bin ? (t.val == "1" ? String("An") : String("Aus")) : t.val;
  if (!bin && t.val != "-" && t.unit.length()) v += " " + t.unit;
  v = ascii(v);
  int font = tft.textWidth(v, 4) <= TILE_W - 8 ? 4 : 2;
  tft.setTextColor(TFT_WHITE, col);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(fit(v, TILE_W - 8, font), x + TILE_W / 2, y + 17 + (TILE_H - 17) / 2, font);
}

static void drawFooter() {
  auto btn = [](int x, int w, const char* label, uint16_t col) {
    tft.fillRoundRect(x, FTR_Y, w, FTR_H, 6, col);
    tft.setTextColor(TFT_WHITE, col);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(label, x + w / 2, FTR_Y + FTR_H / 2, 2);
  };
  if (HAS_TOUCH) btn(KAL_X, BTN_W, "Kal.", C_OFF);
  if (layoutOk && nPages > 1) {
    if (HAS_TOUCH) {
      btn(PREV_X, BTN_W, "<", C_BTN);
      btn(NEXT_X, BTN_W, ">", C_BTN);
    }
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(C_SUB, C_BG);
    tft.drawString(String(curPage + 1) + "/" + String(nPages), SCR_W / 2, FTR_Y + FTR_H / 2, 2);
  }
}

static void drawPage() {
  if (saverOn) return;
  tft.fillScreen(C_BG);
  drawHeader();
  if (!layoutOk || nPages == 0) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_WHITE, C_BG);
    int cy = (TILE_Y0 + FTR_Y) / 2;
    tft.drawString("Warte auf Layout von HomeLite ...", SCR_W / 2, cy - 26, 2);
    tft.setTextColor(C_SUB, C_BG);
    tft.drawString(String("Display-ID: ") + DISPLAY_ID + "  Praefix: " + MQTT_PREFIX, SCR_W / 2, cy, 2);
    tft.drawString("HomeLite: Displays -> hinzufuegen", SCR_W / 2, cy + 26, 2);
  } else {
    for (int i = 0; i < pages[curPage].n; i++) drawTile(curPage, i);
  }
  drawFooter();
}

// ---------- MQTT ----------
static void onValues(const String& text) {
  int p = 0;
  while (p < (int)text.length()) {
    int e = text.indexOf('\n', p);
    if (e < 0) e = text.length();
    String line = text.substring(p, e);
    p = e + 1;
    int eq = line.indexOf('=');
    if (eq <= 0) continue;
    uint16_t tid = line.substring(0, eq).toInt();
    String val = line.substring(eq + 1);
    val.trim();
    for (int pi = 0; pi < nPages; pi++) {
      for (int ti = 0; ti < pages[pi].n; ti++) {
        if (pages[pi].tiles[ti].tid != tid) continue;
        pages[pi].tiles[ti].val = val;
        drawTile(pi, ti);
      }
    }
  }
}

static void onLayout(int n, const String& text) {
  if (n < 0 || n >= MAXP) return;
  pageRaw[n] = text;
  if (n == 0) layoutOk = false;  // neues Layout beginnt
  applyLayoutPage(text, n);
  uint8_t need = (pagesExpected > 0) ? (uint8_t)((1 << pagesExpected) - 1) : 0;
  if (need && (gotMask & need) == need) {
    layoutHash = pendingHash;
    nPages = pagesExpected;
    layoutOk = true;
    if (curPage >= nPages) curPage = 0;
    saveLayout();
    drawPage();
  }
}

static void mqttCallback(char* topic, byte* payload, unsigned int len) {
  String t(topic);
  String base = String(MQTT_PREFIX) + "/" + DISPLAY_ID + "/";
  if (!t.startsWith(base)) return;
  String sub = t.substring(base.length());
  String body;
  body.reserve(len + 1);
  for (unsigned int i = 0; i < len; i++) body += (char)payload[i];
  if (sub == "v") onValues(body);
  else if (sub.startsWith("layout/")) onLayout(sub.substring(7).toInt(), body);
  else if (sub == "cfg") {
    if (body.startsWith("b=")) { bright = constrain((int)body.substring(2).toInt(), 0, 100); applyBacklight(); }
  }
}

static void mqttConnect() {
  static uint32_t lastTry = 0;
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED || millis() - lastTry < 3000) return;
  lastTry = millis();
  String id = String("esp32-panel-") + DISPLAY_ID + "-" + String((uint32_t)(ESP.getEfuseMac() & 0xFFFFFF), HEX);
  String will = tTopic("status");
  bool user = strlen(MQTT_USER) > 0;
  bool ok = mqtt.connect(id.c_str(), user ? MQTT_USER : nullptr, user ? MQTT_PASS : nullptr, will.c_str(), 1, true, "offline");
  if (!ok) { Serial.printf("MQTT Fehler %d\n", mqtt.state()); return; }
  mqtt.subscribe(tTopic("layout/+").c_str());
  mqtt.subscribe(tTopic("v").c_str());
  mqtt.subscribe(tTopic("cfg").c_str());
  mqtt.publish(will.c_str(), "online", true);
  // Hash nur melden, wenn das gespeicherte Layout vollständig geladen ist
  String h = layoutOk ? layoutHash : String("");
  mqtt.publish(tTopic("hello").c_str(), (const uint8_t*)h.c_str(), h.length(), false);
}

// ---------- Touch ----------
// Drei Varianten: TFT_eSPI-intern (TOUCH_CS, 4-Ecken-Kalibrierung der Bibliothek), eigener XPT2046-Bus
// (TOUCH_RAW, 3-Punkt-Kalibrierung in dieser Datei) oder ohne Touch (nur Taster/Anzeige).
static String calKey() { return String("cal") + ROTATION; }

#if defined(TOUCH_RAW)
static SPIClass touchSPI(VSPI);
static XPT2046_Touchscreen ts(TOUCH_RAW_CS);
static float rcal[6];  // x = a*rx + b*ry + c, y = d*rx + e*ry + f
static bool haveCal = false;

// Löst [rx ry 1] * [a b c]^T = t für drei Punkte (Cramer)
static bool solve3(const float* rx, const float* ry, const float* t, float* o) {
  float det = rx[0] * (ry[1] - ry[2]) - ry[0] * (rx[1] - rx[2]) + (rx[1] * ry[2] - rx[2] * ry[1]);
  if (fabsf(det) < 1e-3f) return false;
  o[0] = (t[0] * (ry[1] - ry[2]) - ry[0] * (t[1] - t[2]) + (t[1] * ry[2] - t[2] * ry[1])) / det;
  o[1] = (rx[0] * (t[1] - t[2]) - t[0] * (rx[1] - rx[2]) + (rx[1] * t[2] - rx[2] * t[1])) / det;
  o[2] = (rx[0] * (ry[1] * t[2] - ry[2] * t[1]) - ry[0] * (rx[1] * t[2] - rx[2] * t[1]) + t[0] * (rx[1] * ry[2] - rx[2] * ry[1])) / det;
  return true;
}

static void rawSample(float& rx, float& ry) {
  while (!ts.touched()) delay(10);
  delay(60);  // Kontakt setzen lassen
  float sx = 0, sy = 0;
  int n = 0;
  uint32_t t0 = millis();
  while (ts.touched() && millis() - t0 < 500) {
    TS_Point p = ts.getPoint();
    sx += p.x; sy += p.y; n++;
    delay(10);
  }
  while (ts.touched()) delay(10);
  delay(150);
  rx = n ? sx / n : 0;
  ry = n ? sy / n : 0;
}

static void calibrateTouch() {
  float tx[3] = {24, (float)SCR_W - 24, SCR_W / 2.0f}, ty[3] = {24, 24, (float)SCR_H - 24};
  float rx[3], ry[3];
  for (;;) {
    for (int i = 0; i < 3; i++) {
      tft.fillScreen(C_BG);
      tft.setTextDatum(MC_DATUM);
      tft.setTextColor(TFT_WHITE, C_BG);
      tft.drawString("Touch kalibrieren", SCR_W / 2, SCR_H / 2 - 20, 4);
      tft.drawString("Kreuze nacheinander antippen", SCR_W / 2, SCR_H / 2 + 14, 2);
      tft.drawLine(tx[i] - 12, ty[i], tx[i] + 12, ty[i], TFT_MAGENTA);
      tft.drawLine(tx[i], ty[i] - 12, tx[i], ty[i] + 12, TFT_MAGENTA);
      rawSample(rx[i], ry[i]);
    }
    if (solve3(rx, ry, tx, rcal) && solve3(rx, ry, ty, rcal + 3)) break;
  }
  haveCal = true;
  prefs.putBytes(calKey().c_str(), rcal, sizeof(rcal));
}

static void touchBegin() {
  touchSPI.begin(TOUCH_RAW_CLK, TOUCH_RAW_MISO, TOUCH_RAW_MOSI, TOUCH_RAW_CS);
  ts.begin(touchSPI);
  haveCal = prefs.getBytes(calKey().c_str(), rcal, sizeof(rcal)) == sizeof(rcal);
  if (!haveCal) calibrateTouch();
}

static bool touchRead(int16_t& x, int16_t& y) {
  if (!ts.touched()) return false;
  TS_Point p = ts.getPoint();
  x = constrain((int)(rcal[0] * p.x + rcal[1] * p.y + rcal[2]), 0, SCR_W - 1);
  y = constrain((int)(rcal[3] * p.x + rcal[4] * p.y + rcal[5]), 0, SCR_H - 1);
  return true;
}

#elif HAS_TOUCH
static void calibrateTouch() {
  uint16_t cal[5];
  tft.fillScreen(C_BG);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, C_BG);
  tft.drawString("Touch kalibrieren:", SCR_W / 2, SCR_H / 2 - 40, 4);
  tft.drawString("Die Ecken nacheinander antippen", SCR_W / 2, SCR_H / 2 - 6, 2);
  tft.calibrateTouch(cal, TFT_MAGENTA, C_BG, 15);
  prefs.putBytes(calKey().c_str(), cal, sizeof(cal));
  tft.setTouch(cal);
}

static void touchBegin() {
  uint16_t cal[5];
  if (prefs.getBytes(calKey().c_str(), cal, sizeof(cal)) == sizeof(cal)) tft.setTouch(cal);
  else calibrateTouch();
}

static bool touchRead(int16_t& x, int16_t& y) {
  uint16_t ux, uy;
  if (!tft.getTouch(&ux, &uy, TOUCH_Z)) return false;
  x = ux; y = uy;
  return true;
}

#else
static void calibrateTouch() {}
static void touchBegin() {}
static bool touchRead(int16_t&, int16_t&) { return false; }
#endif

// Optionaler Taster (gegen GND): liefert true bei jedem Drücken
#if defined(BUTTON_PIN)
static bool buttonEdge() {
  static bool last = false;
  static uint32_t lt = 0;
  bool d = digitalRead(BUTTON_PIN) == LOW;
  if (d == last || millis() - lt < 40) return false;
  lt = millis();
  last = d;
  return d;
}
#else
static bool buttonEdge() { return false; }
#endif

static int flashPage = -1, flashTileIdx = -1;
static uint32_t flashUntil = 0;

static void handleTap(int16_t x, int16_t y) {
  if (y >= FTR_Y) {
    if (HAS_TOUCH && x < KAL_X + BTN_W + 4) { calibrateTouch(); drawPage(); }
    else if (layoutOk && nPages > 1 && x >= PREV_X && x < PREV_X + BTN_W) { curPage = (curPage + nPages - 1) % nPages; drawPage(); }
    else if (layoutOk && nPages > 1 && x >= NEXT_X) { curPage = (curPage + 1) % nPages; drawPage(); }
    return;
  }
  if (!layoutOk || nPages == 0) return;
  for (int i = 0; i < pages[curPage].n; i++) {
    int tx, ty;
    tileRect(i, tx, ty);
    if (x < tx || x >= tx + TILE_W || y < ty || y >= ty + TILE_H) continue;
    Tile& t = pages[curPage].tiles[i];
    if (t.kind != K_TOGGLE) return;
    if (!mqtt.connected()) return;
    mqtt.publish(tTopic("tap").c_str(), String(t.tid).c_str(), false);
    int bx, by;
    tileRect(i, bx, by);
    tft.drawRoundRect(bx, by, TILE_W, TILE_H, 8, C_WARN);  // Rückmeldung bis der neue Wert eintrifft
    tft.drawRoundRect(bx + 1, by + 1, TILE_W - 2, TILE_H - 2, 7, C_WARN);
    flashPage = curPage;
    flashTileIdx = i;
    flashUntil = millis() + 700;
    return;
  }
}

// ---------- Bildschirmschoner ----------
// Schwarzer Bildschirm mit Uhrzeit und Datum, die als Sprite langsam über den Schirm wandern (abprallend).
// Das Sprite hat einen schwarzen Rand größer als die Schrittweite, dadurch bleiben keine Spuren zurück.
static int SPR_W = 240;
static const int SPR_H = 100;
static const int SAVER_STEP_MS = 50;
static TFT_eSprite spr = TFT_eSprite(&tft);
static int sx = 0, sy = 0, svx = 2, svy = 1;
static uint32_t lastMove = 0, lastActivity = 0;
static String sprKey;

static void renderClock() {
  struct tm tm;
  char tbuf[16] = "Zeit ...", dbuf[24] = "";
  bool synced = getLocalTime(&tm, 0);  // false, bis NTP die Uhrzeit geliefert hat
  if (synced) {
    static const char* WD[7] = {"So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"};
    snprintf(tbuf, sizeof(tbuf), "%02d:%02d", tm.tm_hour, tm.tm_min);
    snprintf(dbuf, sizeof(dbuf), "%s %02d.%02d.%04d", WD[tm.tm_wday], tm.tm_mday, tm.tm_mon + 1, tm.tm_year + 1900);
  }
  String key = String(tbuf) + dbuf;
  if (key == sprKey) return;  // nichts neu zeichnen, solange sich Minute und Datum nicht ändern
  sprKey = key;
  spr.fillSprite(TFT_BLACK);
  spr.setTextDatum(TC_DATUM);
  spr.setTextColor(RGB(220, 225, 240), TFT_BLACK);
  // Font 7 (große Ziffern) kennt nur Ziffern und ':'; vor der Synchronisierung deshalb Font 4
  if (synced) spr.drawString(tbuf, SPR_W / 2, 6, 7);
  else spr.drawString(tbuf, SPR_W / 2, 24, 4);
  spr.setTextColor(C_SUB, TFT_BLACK);
  spr.drawString(dbuf, SPR_W / 2, 66, 4);
}

static void enterSaver() {
  SPR_W = min(240, SCR_W);
  if (!spr.createSprite(SPR_W, SPR_H)) { lastActivity = millis(); return; }  // zu wenig Speicher -> kein Schoner
  saverOn = true;
  applyBacklight();
  tft.fillScreen(TFT_BLACK);
  sx = random(0, SCR_W - SPR_W + 1);
  sy = random(0, SCR_H - SPR_H + 1);
  svx = random(2) ? 2 : -2;
  svy = random(2) ? 1 : -1;
  sprKey = "";
  renderClock();
  spr.pushSprite(sx, sy);
  lastMove = millis();
}

static void tickSaver() {
  if (millis() - lastMove < SAVER_STEP_MS) return;
  lastMove = millis();
  sx += svx;
  sy += svy;
  if (sx <= 0) { sx = 0; svx = -svx; }
  if (sx >= SCR_W - SPR_W) { sx = SCR_W - SPR_W; svx = -svx; }
  if (sy <= 0) { sy = 0; svy = -svy; }
  if (sy >= SCR_H - SPR_H) { sy = SCR_H - SPR_H; svy = -svy; }
  renderClock();
  spr.pushSprite(sx, sy);
}

static void exitSaver() {
  saverOn = false;
  applyBacklight();
  spr.deleteSprite();
  drawPage();
}

// ---------- Arduino ----------
void setup() {
  Serial.begin(115200);
  prefs.begin("panel", false);

  tft.init();
  tft.setRotation(ROTATION);
  computeGeometry();
  blInit();
  applyBacklight();
  tft.fillScreen(C_BG);
#if defined(BUTTON_PIN)
  pinMode(BUTTON_PIN, INPUT_PULLUP);
#endif
  touchBegin();

  loadLayout();

  tft.fillScreen(C_BG);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, C_BG);
  tft.drawString("HomeLite Panel", SCR_W / 2, SCR_H / 2 - 30, 4);
  tft.setTextColor(C_SUB, C_BG);
  tft.drawString("Verbinde mit WLAN ...", SCR_W / 2, SCR_H / 2 + 14, 2);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(200);

  configTzTime(TZ_INFO, NTP_SERVER);  // Uhrzeit für den Bildschirmschoner
  lastActivity = millis();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);  // Layout-Nachrichten sind länger als der Standardpuffer
  mqtt.setKeepAlive(30);
  mqtt.setCallback(mqttCallback);

  shownStatus = statusText();
  drawPage();
}

void loop() {
  static bool wasDown = false;
  static uint32_t lastTap = 0, lastTry = 0;

  mqttConnect();
  mqtt.loop();

  int16_t x = 0, y = 0;
  bool down = touchRead(x, y);
  if (buttonEdge()) {
    lastActivity = millis();
    if (saverOn) exitSaver();
    else if (layoutOk && nPages > 1) { curPage = (curPage + 1) % nPages; drawPage(); }
  }
  if (down) {
    lastActivity = millis();
    if (saverOn) {
      exitSaver();
      wasDown = true;  // diese Berührung weckt nur auf und löst keine Kachel aus
    }
  }
  if (down && !wasDown && millis() - lastTap > 200) {
    lastTap = millis();
    handleTap(x, y);
  }
  wasDown = down;

  if (WiFi.status() != WL_CONNECTED && millis() - lastTry > 10000) {
    lastTry = millis();
    WiFi.reconnect();
  }

  // Statusanzeige nur bei Änderung neu zeichnen
  String st = statusText();
  bool ok = mqtt.connected();
  if (st != shownStatus || ok != shownOk) {
    shownStatus = st;
    shownOk = ok;
    drawHeader();
  }

  // Bildschirmschoner: nach Ruhezeit starten, solange er läuft die Uhr bewegen
  if (SAVER_AFTER_S > 0 && !saverOn && millis() - lastActivity > (uint32_t)SAVER_AFTER_S * 1000UL) enterSaver();
  if (saverOn) tickSaver();

  // Tipp-Rückmeldung zurücknehmen, falls kein neuer Wert kam
  if (flashTileIdx >= 0 && millis() > flashUntil) {
    drawTile(flashPage, flashTileIdx);
    flashTileIdx = -1;
  }
}
