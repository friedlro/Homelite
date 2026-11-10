#pragma once

// ---- WLAN ----
#define WIFI_SSID   "DEIN_WLAN"
#define WIFI_PASS   "DEIN_WLAN_PASSWORT"

// ---- MQTT-Broker von HomeLite (Einstellungen -> Erweiterungen -> Eingebauter MQTT-Broker) ----
#define MQTT_HOST   "192.168.1.10"
#define MQTT_PORT   1883
// Benutzer aus den HomeLite-Einstellungen (Eingebauter MQTT-Broker -> Benutzer anlegen);
// anonyme Verbindungen sind dort standardmäßig verboten. "" nur, wenn anonym erlaubt wurde.
#define MQTT_USER   ""
#define MQTT_PASS   ""

// ---- Bildschirmschoner (Uhr + Datum, wandert über den Bildschirm) ----
// Nach so vielen Sekunden ohne Berührung startet er; 0 = ausgeschaltet. Berührung weckt das Display auf.
#define SAVER_AFTER_S  120
// Zeit per NTP (der ESP32 braucht dafür Internetzugang) und Zeitzone (Österreich, Sommer-/Winterzeit)
#define NTP_SERVER     "pool.ntp.org"
#define TZ_INFO        "CET-1CEST,M3.5.0,M10.5.0/3"

// ---- Plugin "ESP32-Display" ----
// Display-ID: dieselbe wie in HomeLite -> Displays (nur Kleinbuchstaben, Ziffern, _ und -)
#define DISPLAY_ID    "flur"
// Themenpräfix: dieselbe Einstellung wie im Plugin (Standard "hl")
#define MQTT_PREFIX   "hl"
