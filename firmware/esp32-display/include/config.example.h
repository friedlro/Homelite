#pragma once
// Kopie als include/config.h anlegen und ausfüllen (config.h wird nicht ins Repository übernommen).

// ---- WLAN ----
#define WIFI_SSID   "DEIN_WLAN"
#define WIFI_PASS   "DEIN_WLAN_PASSWORT"

// ---- MQTT-Broker von HomeLite ----
#define MQTT_HOST   "192.168.1.10"
#define MQTT_PORT   1883
// Leer lassen ("") für anonymen Zugang (muss im HomeLite-Broker erlaubt sein),
// sonst einen Broker-Benutzer aus den HomeLite-Einstellungen eintragen.
#define MQTT_USER   ""
#define MQTT_PASS   ""

// ---- Plugin "ESP32-Display" ----
// Display-ID: dieselbe wie in HomeLite -> Displays (nur Kleinbuchstaben, Ziffern, _ und -)
#define DISPLAY_ID    "flur"
// Themenpräfix: dieselbe Einstellung wie im Plugin (Standard "hl")
#define MQTT_PREFIX   "hl"

// ---- Bildschirmschoner (Uhr + Datum, wandert über den Bildschirm) ----
// Nach so vielen Sekunden ohne Berührung startet er; 0 = ausgeschaltet. Berührung/Knopf weckt das Display auf.
#define SAVER_AFTER_S  120
// Zeit per NTP (der ESP32 braucht dafür Internetzugang) und Zeitzone (Österreich, Sommer-/Winterzeit)
#define NTP_SERVER     "pool.ntp.org"
#define TZ_INFO        "CET-1CEST,M3.5.0,M10.5.0/3"

// ---- Optionale Einstellungen (jeweils auch als Build-Flag möglich, z. B. -DROTATION=3) ----
// Bildausrichtung 0..3 (Standard 1 = Querformat, USB-Seite je nach Modul). Bei Änderung wird der Touch neu kalibriert.
// #define ROTATION        1
// Hintergrundlicht im Bildschirmschoner in % (0 = aus). Nur mit Modulen, deren Beleuchtung per PWM steuerbar ist
// (Build-Flag TFT_BL, z. B. CYD). Ohne Angabe bleibt die Helligkeit unverändert.
// #define SAVER_BACKLIGHT 0
// Optionaler Taster (gegen GND, interner Pull-up): weckt das Display auf, sonst blättert er zur nächsten Seite.
// Für Module ohne Touch, z. B. -DBUTTON_PIN=0 (BOOT-Taste des DevKits). Ohne Touch sind Kacheln nur Anzeige.
// #define BUTTON_PIN      0
