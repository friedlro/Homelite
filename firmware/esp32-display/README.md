# Firmware: ESP32 + SPI-Display (gängige Controller)

Firmware für das Plugin **ESP32-Display**: Sie spricht das MQTT-Textprotokoll des Plugins (siehe
[Plugin-Anleitung](../../plugins-example/esp32-display/LIESMICH.md)), zeichnet die in HomeLite zusammengestellten Seiten und Kacheln auf einem
SPI-Display mit resistivem Touch (XPT2046) und meldet Tippen zurück. Unterstützt werden die gängigen Controller
(siehe Tabelle unten), je Controller gibt es eine PlatformIO-Umgebung.
Der ESP32 braucht kein JSON, kein HTTP, kein HomeLite-Passwort und keinen KI-Zugriff.

> Stand: Alle Umgebungen kompilieren (PlatformIO, ESP32 DevKit). Auf echter Hardware und gegen einen echten Broker ist
> nichts davon **getestet**; Treiber und SPI-Takte stammen aus der TFT_eSPI-Dokumentation. Falls ein Modul Farben
> vertauscht oder invertiert zeigt, siehe "Anpassungen" unten. Rückmeldungen sind willkommen.

## Funktionen
- Seiten (max. 8) mit je bis zu 12 Kacheln (Querformat 4 Spalten, Hochformat 3; Größen aus der Auflösung berechnet); Kachel-Arten *Wert*, *Schalter* (Tippen schaltet), *Zustand*
- Blättern mit `<` und `>`, Statuspunkt oben rechts (grün = MQTT verbunden)
- Layout und Hash im Flash gespeichert: Nach einem Neustart sendet HomeLite nur noch die Werte
- Touch-Kalibrierung beim ersten Start (später über "Kal." unten links), im Flash gespeichert (je Drehung)
- Optional ohne Touch mit Taster (`BUTTON_PIN`); Hintergrundlicht per PWM dimmbar, wenn das Board es zulässt (`TFT_BL`)
- **Bildschirmschoner:** Nach `SAVER_AFTER_S` Sekunden (Standard 120, `0` = aus) ohne Berührung wird der Bildschirm schwarz und
  zeigt Uhrzeit und Datum, die langsam über den ganzen Bildschirm wandern. Berührung weckt auf (löst keine Kachel aus).
  Die Uhrzeit kommt per NTP (Zeitzone `TZ_INFO`, Standard Österreich mit Sommerzeit), der ESP32 braucht dafür Internetzugang.
- Last Will `offline` (retained); beim Wiederverbinden wird `hello` erneut gesendet

## Unterstützte Displays (Umgebungen)

Bauen und flashen mit `pio run -e <Umgebung> -t upload`. Ohne `-e` wird `waveshare35` gebaut.

| Umgebung | Display / Board | Auflösung | Treiber (TFT_eSPI) | Touch | Hintergrundlicht |
|---|---|---|---|---|---|
| `waveshare35` | Waveshare 3.5" RPi LCD (A) | 320×480 | `RPI_ILI9486_DRIVER`, 20 MHz | XPT2046 am Display-Bus | fest verdrahtet |
| `ili9341` | 2.2"–3.2" SPI-Module mit ILI9341 | 240×320 | `ILI9341_DRIVER`, 40 MHz | XPT2046 am Display-Bus | meist LED an 3,3 V |
| `cyd` | ESP32-2432S028R ("Cheap Yellow Display") | 240×320 | `ILI9341_2_DRIVER`, HSPI, 55 MHz | XPT2046 am eigenen Bus (`TOUCH_RAW`) | GPIO21, PWM |
| `ili9488` | 3.5" SPI-Module mit ILI9488 (z. B. MSP3520) | 320×480 | `ILI9488_DRIVER`, 27 MHz | XPT2046 am Display-Bus | meist LED an 3,3 V |
| `ili9486` | 3.5" SPI-Module mit ILI9486 (keine Waveshare-RPi-Platine) | 320×480 | `ILI9486_DRIVER`, 27 MHz | XPT2046 am Display-Bus | meist LED an 3,3 V |
| `st7796` | 3.5"/4.0" SPI-Module mit ST7796 | 320×480 | `ST7796_DRIVER`, 40 MHz | XPT2046 am Display-Bus | meist LED an 3,3 V |
| `st7789` | 2.0"/2.4" SPI-Module mit ST7789 | 240×320 | `ST7789_DRIVER`, 40 MHz | XPT2046 am Display-Bus | meist LED an 3,3 V |

Nicht dabei: Module mit parallelem 8/16-Bit-Anschluss und I²C-Touch (kapazitiv). Sie brauchen andere Treiber.

## Verdrahtung

### Alle Umgebungen außer `cyd` (VSPI, Standardpins)
Alle Module hängen an denselben ESP32-Pins (DevKit, 30/38 Pin); Display und Touch teilen sich den SPI-Bus:

| Modul-Signal | ESP32 |
|---|---|
| VCC / 3,3 V | 3V3 |
| GND | GND |
| CS (LCD) | GPIO5 |
| RESET | GPIO26 |
| DC / RS | GPIO27 |
| SDI (MOSI) | GPIO23 |
| SCK | GPIO18 |
| LED (Hintergrundlicht) | 3V3 (oder ein GPIO, siehe unten) |
| SDO (MISO) | GPIO19 |
| T_CS (Touch) | GPIO33 |
| T_CLK / T_DIN / T_DO | wie SCK / MOSI / MISO |
| T_IRQ | nicht angeschlossen (wird nicht gebraucht) |

Beschriftung und Reihenfolge der Pins unterscheiden sich je Modul; maßgeblich sind die Signalnamen.

### Waveshare 3.5" RPi LCD (A) (`waveshare35`)
Aufsteckmodul für den Raspberry Pi mit 26 Pins am Stecker (SPI):

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

### CYD (ESP32-2432S028R, `cyd`)
Das Board hat Display, Touch und ESP32 fertig verdrahtet, es ist nur zu flashen. Display an HSPI (MISO 12, MOSI 13, SCLK 14, CS 15, DC 2),
Touch am eigenen Bus (CLK 25, MISO 39, MOSI 32, CS 33), Hintergrundlicht an GPIO21 (PWM, der `cfg`-Wert `b=` wirkt).
Der Touch wird mit einer eigenen 3-Punkt-Kalibrierung abgeglichen (drei Kreuze antippen).

## Anpassungen
- **Pins:** in `platformio.ini` (Build-Flags `TFT_*`, `TOUCH_CS`, bei `cyd` `TOUCH_RAW_*`).
- **Drehung:** `ROTATION` 0–3 (Standard 1, Querformat) in `include/config.h` oder als Build-Flag `-DROTATION=3`. Bei Hochformat (0/2) zeichnet die Firmware 3 statt 4 Spalten.
  Nach einer Änderung wird der Touch beim Start neu kalibriert (die Kalibrierung wird je Drehung gespeichert).
- **Farben vertauscht / invertiert:** Build-Flags `-DTFT_RGB_ORDER=TFT_BGR` und/oder `-DTFT_INVERSION_ON` (bzw. `-DTFT_INVERSION_OFF`) ergänzen.
  Bei manchen CYD-Varianten (zwei USB-Buchsen) hilft statt `ILI9341_2_DRIVER` der Treiber `ILI9341_DRIVER` zusammen mit `-DTFT_INVERSION_ON`.
- **Ohne Touch:** das Flag `TOUCH_CS` (bzw. bei `cyd` `TOUCH_RAW`) weglassen und `BUTTON_PIN` setzen. Der Taster (gegen GND, interner Pull-up,
  z. B. `-DBUTTON_PIN=0` für die BOOT-Taste) weckt den Bildschirm auf und blättert sonst zur nächsten Seite. Ohne Touch sind Kacheln nur Anzeige.
- **Hintergrundlicht steuern:** Hängt die LED an einem GPIO, das Flag `-DTFT_BL=<Pin>` setzen (LED aktiv bei HIGH). Dann setzt die Firmware den `cfg`-Wert `b=`
  (0–100 %) per PWM um, und mit `SAVER_BACKLIGHT` (in %) wird das Licht im Bildschirmschoner gedimmt.

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
   pio run -e waveshare35 -t upload     # Umgebung aus der Tabelle oben wählen
   pio device monitor
   ```
   Beim ersten Start den Touch kalibrieren (vier Ecken antippen, bei `cyd` drei Kreuze).

## Technik
- Display: TFT_eSPI, Treiber und Pins je Umgebung per Build-Flags (die Bibliothek bleibt unverändert); Touch XPT2046 über TFT_eSPI am Display-Bus, bei `cyd` über `XPT2046_Touchscreen` am eigenen Bus
- Layout: Kachelgrößen werden beim Start aus Breite/Höhe des Displays berechnet; der Bildschirmschoner nutzt ein Sprite (höchstens 240×100 Pixel)
- MQTT: PubSubClient mit Puffer 1024 Byte (Layout-Nachrichten sind länger als der Standardpuffer)
- Plattform: `espressif32@6.9.0` (Arduino-Core 2.x), Bibliotheken `TFT_eSPI`, `PubSubClient`
- Die eingebauten Fonts haben keine Umlaute; Texte werden als ae/oe/ue/ss dargestellt
- Das Plugin selbst ändert sich durch die Firmware nicht; das Protokoll steht in [Plugin-Anleitung](../../plugins-example/esp32-display/LIESMICH.md)
