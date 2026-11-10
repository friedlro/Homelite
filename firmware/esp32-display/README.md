# Firmware: ESP32 + Waveshare 3.5" RPi LCD

Firmware für das Plugin **ESP32-Display**: Sie spricht das MQTT-Textprotokoll des Plugins (siehe
[Plugin-Anleitung](../../plugins-example/esp32-display/LIESMICH.md)), zeichnet die in HomeLite zusammengestellten Seiten und Kacheln auf einem
**Waveshare 3.5" RPi LCD (320×480, ILI9486 über SPI, resistiver Touch XPT2046)** und meldet Tippen zurück.
Der ESP32 braucht kein JSON, kein HTTP, kein HomeLite-Passwort und keinen KI-Zugriff.

> Stand: Das Projekt kompiliert (PlatformIO, ESP32 DevKit). Auf echter Hardware und gegen einen echten Broker ist
> es noch **nicht getestet**; die Display-Einstellung `RPI_ILI9486_DRIVER` bei 20 MHz stammt aus der TFT_eSPI-Dokumentation
> für dieses Modul. Rückmeldungen sind willkommen.

## Funktionen
- Seiten (max. 8) mit je bis zu 12 Kacheln in 4 Spalten; Kachel-Arten *Wert*, *Schalter* (Tippen schaltet), *Zustand*
- Blättern mit `<` und `>`, Statuspunkt oben rechts (grün = MQTT verbunden)
- Layout und Hash im Flash gespeichert: Nach einem Neustart sendet HomeLite nur noch die Werte
- Touch-Kalibrierung beim ersten Start (später über "Kal." unten links), im Flash gespeichert
- **Bildschirmschoner:** Nach `SAVER_AFTER_S` Sekunden (Standard 120, `0` = aus) ohne Berührung wird der Bildschirm schwarz und
  zeigt Uhrzeit und Datum, die langsam über den ganzen Bildschirm wandern. Berührung weckt auf (löst keine Kachel aus).
  Die Uhrzeit kommt per NTP (Zeitzone `TZ_INFO`, Standard Österreich mit Sommerzeit), der ESP32 braucht dafür Internetzugang.
- Last Will `offline` (retained); beim Wiederverbinden wird `hello` erneut gesendet

## Verdrahtung

Das Display ist ein Raspberry-Pi-Aufsteckmodul (26 Pins am Stecker, SPI). Alle Pins am ESP32 (DevKit, 30/38 Pin):

| Display-Pin | Signal | ESP32 |
|---|---|---|
| 1 (oder 17) | 3,3 V | 3V3 |
| 2 (oder 4) | 5 V | 5V / VIN |
| 6 (9, 14, 20, 25) | GND | GND |
| 11 | TP_IRQ | GPIO32 (optional, wird nicht gebraucht) |
| 18 | LCD_RS (DC) | GPIO27 |
| 19 | MOSI (LCD + Touch) | GPIO23 |
| 21 | TP_SO (MISO Touch) | GPIO19 |
| 22 | RST | GPIO26 |
| 23 | SCK (LCD + Touch) | GPIO18 |
| 24 | LCD_CS | GPIO5 |
| 26 | TP_CS | GPIO33 |

- 5 V **und** 3,3 V müssen beide angeschlossen sein (die Schieberegister/Pegelwandler auf dem Modul brauchen 5 V).
- Die Hintergrundbeleuchtung hängt fest an der Versorgung und ist nicht per Software dimmbar oder abschaltbar. Der `cfg`-Wert
  `b=` (Helligkeit/Nachtabsenkung des Plugins) wird empfangen, aber nicht umgesetzt; der Bildschirmschoner macht den Schirm nur schwarz.
- Pins lassen sich in `platformio.ini` ändern (Build-Flags `TFT_*`, `TOUCH_CS`).

## Einrichtung
1. **HomeLite**: Plugin ESP32-Display, Seite *Displays* → *Display hinzufügen*, **Display-ID** vergeben (z. B. `flur`), Seiten und Kacheln anlegen.
2. **MQTT-Broker**: *Einstellungen → Erweiterungen → Eingebauter MQTT-Broker* einschalten und einen **Benutzer** für das Display anlegen
   (anonyme Verbindungen sind dort standardmäßig verboten, TLS wird nicht unterstützt: nur im Heimnetz oder über ein VPN verwenden).
3. Konfiguration anlegen und ausfüllen:
   ```bash
   cd firmware/esp32-display
   cp include/config.example.h include/config.h    # WLAN, MQTT_HOST/USER/PASS, DISPLAY_ID, MQTT_PREFIX
   ```
   `DISPLAY_ID` und `MQTT_PREFIX` müssen mit HomeLite (Display-ID, Plugin-Einstellung "Themenpräfix") übereinstimmen.
   `include/config.h` steht in `.gitignore` (enthält Zugangsdaten).
4. Bauen und flashen (PlatformIO):
   ```bash
   pio run -t upload
   pio device monitor
   ```
   Beim ersten Start den Touch kalibrieren (vier Ecken antippen).

## Technik
- Display: TFT_eSPI mit `RPI_ILI9486_DRIVER` (20 MHz SPI), Touch XPT2046 am selben SPI-Bus; alles per Build-Flags, die Bibliothek bleibt unverändert
- MQTT: PubSubClient mit Puffer 1024 Byte (Layout-Nachrichten sind länger als der Standardpuffer)
- Plattform: `espressif32@6.9.0` (Arduino-Core 2.x), Bibliotheken `TFT_eSPI`, `PubSubClient`
- Die eingebauten Fonts haben keine Umlaute; Texte werden als ae/oe/ue/ss dargestellt
- Das Plugin selbst ändert sich durch die Firmware nicht; das Protokoll steht in [Plugin-Anleitung](../../plugins-example/esp32-display/LIESMICH.md)
