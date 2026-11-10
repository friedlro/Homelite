# Änderungen

## 1.25.13
- **Firmware für die gängigen Display-Controller:** `firmware/esp32-display` baut jetzt mit einer Umgebung je Controller: `waveshare35` (Standard), `ili9341`, `cyd` (ESP32-2432S028R mit eigenem Touch-Bus und PWM-Hintergrundlicht), `ili9488`, `ili9486`, `st7796`, `st7789` (`pio run -e <Umgebung> -t upload`). Die Darstellung berechnet Kachelgrößen aus der Displaygröße (Querformat 4, Hochformat 3 Spalten), die Drehung ist einstellbar (`ROTATION`), der Touch wird je Drehung kalibriert (bei `cyd` mit eigener 3-Punkt-Kalibrierung). Neu: optionaler Taster (`BUTTON_PIN`) für Module ohne Touch, Umsetzung des `cfg`-Werts `b=` und optionales Dimmen im Bildschirmschoner (`SAVER_BACKLIGHT`), sofern das Board `TFT_BL` hat. Plugin `esp32-display` 1.1.2 (nur Anleitung). Alle Umgebungen kompilieren, sind aber noch nicht auf echter Hardware getestet.

## 1.25.12
- **Firmware-Ordner:** Die Firmware für das ESP32-Display liegt jetzt in einem eigenen Ordner `firmware/esp32-display` im Hauptverzeichnis des Repositorys statt im Plugin-Ordner (Plugin `esp32-display` 1.1.1). Sie wird dadurch bei Plugin-Installation und -Update nicht mehr mitgeladen. Dokumentation (README, Handbuch, Plugin-Anleitung, Firmware-README) angepasst; die Firmware selbst ist unverändert.

## 1.25.11
- **Firmware für das ESP32-Display:** Neues Plugin `esp32-display` 1.1.0 mit fertiger Firmware für ESP32 + Waveshare 3.5" RPi LCD (320×480, ILI9486, Touch XPT2046) als PlatformIO-Projekt im Ordner `plugins-example/esp32-display/firmware`. Zeichnet die in HomeLite angelegten Seiten und Kacheln, Schalter-Kacheln sind antippbar, Layout und Hash liegen im Flash. **Bildschirmschoner:** Nach einstellbarer Ruhezeit (Standard 120 s) schwarzer Bildschirm mit Uhrzeit und Datum (NTP, Zeitzone einstellbar), die über den Bildschirm wandern; Berührung weckt auf. Anleitung (Verdrahtung, Einrichtung, Grenzen) in `firmware/README.md`, `LIESMICH.md` des Plugins, README und Handbuch. Die Firmware kompiliert, ist aber noch nicht auf echter Hardware getestet; die Hintergrundbeleuchtung des Moduls ist nicht steuerbar (Nachtabsenkung ohne Wirkung).

## 1.25.10
- **Fertige SD-Karten-Images** für Orange Pi One (Armbian) und Raspberry Pi 2+ (Raspberry Pi OS Lite) sowie das Bauskript `images/build-image.sh`.
- **Plugin-Katalog:** Unter Einstellungen → Erweiterungen → Plugins gibt es den Bereich „Verfügbare Plugins (GitHub)“. Er listet alle Plugins aus dem Ordner `plugins-example` des HomeLite-Repositories (Name, Version, Beschreibung, Neuerungen, benötigte Rechte, Link) und installiert oder aktualisiert sie mit einem Klick. Bereits installierte Plugins sind markiert. Der Katalog wird 6 Stunden zwischengespeichert, „Katalog aktualisieren“ lädt neu. Quelle ist die Update-Adresse von HomeLite (Standard `github.com/friedlro/Homelite`).

## 1.25.9
- **Plugin-Update mit einem Klick:** Bei gefundenem Update zeigt das Plugin einen Kasten mit der neuen Version, der Änderungsbeschreibung und dem Knopf „⬆ Jetzt aktualisieren“. HomeLite lädt den Plugin-Ordner von GitHub und ersetzt ihn; Einstellungen, Geräte und Aktivierung bleiben erhalten, ein laufendes Plugin wird neu gestartet. Die Beschreibung stammt aus dem neuen Feld `changelog` der `plugin.json` (`{"1.2.0": "Text"}`); angezeigt werden alle Einträge neuer als die installierte Version. Alle Beispiel-Plugins haben jetzt einen Eintrag.

- Neues Plugin `tomons-wallbox` 1.0.0: Tomons / Inateck Mobile Wallbox (11/22 kW) über die Tomons-Cloud, inoffiziell nach Reverse-Engineering von Limo123123 (MIT). Messwerte, Kabelstatus, Ladestrom-Grenze; Start/Stopp optional und experimentell. Nicht an echter Hardware getestet.
- Neues Plugin `esp32-display` 1.0.0: Schnittstelle für ESP32 mit Display. Layout-Editor (Seiten, Kacheln), nur Änderungen werden per kompaktem MQTT-Textprotokoll gesendet (Mindestschwelle, Bündelung, Layout nur bei geändertem Hash), Tippen als Rückkanal, Nachtabsenkung, Statusanzeige. Ohne Firmware, nur mit simuliertem ESP32 getestet.

## 1.25.8
- **Update-Hinweise für Plugins:** Unter Einstellungen → Erweiterungen → Plugins zeigt jedes Plugin einen Hinweis „⬆ Update x.y.z“, sobald auf GitHub eine neuere Version liegt, plus einen Link „GitHub ↗“ zum passenden Ordner im Repository. Prüfung automatisch täglich (einmalige Benachrichtigung je neuer Version) oder per Knopf „🔄 Auf Updates prüfen“. Eigene Plugins können in `plugin.json` ein Feld `repo` setzen (`https://github.com/Besitzer/Repo` oder `…/tree/main/pfad`); ohne `repo` gilt `plugins-example/<id>` im HomeLite-Repository. Das Update selbst installierst du wie gewohnt über die Plugin-Datei.

## 1.25.7
- **Apple TV bleibt verbunden:** HomeLite findet ein gekoppeltes Apple TV jetzt auch nach einer geänderten IP-Adresse (DHCP) oder geänderten Kennung (private WLAN-Adresse) wieder – über alle bekannten Kennungen und den Gerätenamen. Die Kopplung bleibt gültig, neu koppeln ist nicht mehr nötig. Die neue Adresse wird gespeichert; der Fehlergrund erscheint in der Apple-TV-Liste.
- Plugin `tapo-kamera` 1.0.1: „socket hang up“-Meldungen behoben (neue Verbindung je Anfrage statt wiederverwendeter, von der Kamera bereits geschlossener Verbindung), Wiederholung mit wachsender Pause, Fehlermeldungen im Protokoll gedrosselt.

## 1.25.6
- **Automatisches Backup:** Ändert sich während der Sicherung eine Datei im Datenordner (Protokolle, Plugin-Daten), meldete tar „file changed as we read it“ (Exit-Code 1) und das Backup galt als fehlgeschlagen. Dieser Fall ist nicht mehr fatal; die Sicherung wird normal fertiggestellt. Die Datenbank wird weiterhin als konsistente Momentaufnahme gesichert.

## 1.25.5
- **App-Symbol repariert:** Die PNG-Symbole (Startbildschirm/Web-App, Favicon) waren durch einen Fehler beim Erzeugen weiß; sie zeigen jetzt wieder das HomeLite-Logo. Neu: eigenes Symbol für Android („maskable“). Falls das alte weiße Symbol bleibt: Web-App vom Startbildschirm entfernen und neu hinzufügen.

## 1.25.4
- **Zigbee-Werte beim Start laden:** Nach jeder (Wieder-)Verbindung mit dem MQTT-Broker fragt HomeLite die aktuellen Werte aller Zigbee2MQTT-Geräte an (`<Gerät>/get`, nur für Eigenschaften, die das Gerät auslesen kann, z. B. Lichter, Steckdosen, Thermostate, Helligkeit mancher Sensoren). Zusammen mit den gespeicherten Werten aus 1.25.3 haben Präsenz-, Helligkeits- und Kontaktsensoren sofort einen Wert.

## 1.25.3
- **Zigbee-/MQTT-Sensoren behalten ihren letzten Wert über einen Neustart:** Präsenz-, Helligkeits-, Kontakt- und Temperatursensoren, die nur bei Änderungen senden (Zigbee2MQTT), zeigten nach dem Start „leer“, bis sie sich wieder meldeten – Regeln mit Präsenz/Helligkeit griffen deshalb nicht. Der letzte Wert wird jetzt gespeichert und beim Start wiederhergestellt; die nächste echte Meldung ersetzt ihn.

## 1.25.2
- **Weniger Arbeitsspeicher:** Der Heap von HomeLite ist auf 256 MB begrenzt (eigene Vorgabe über `NODE_OPTIONS=--max-old-space-size=…` hat Vorrang), die Matter-Brücke auf 160 MB.
- Plugin `siocs-heizung` 1.2.0: **Sparmodus** – der Browser (Chromium, ca. 400–500 MB) wird nur noch für die Abfrage gestartet und danach geschlossen. Wirkt ab 120 s Abfrageintervall (empfohlen 300 s), abschaltbar in den Plugin-Einstellungen.

## 1.25.1
- **Regeln lösen beim Start nicht mehr fälschlich aus:** Der erste gemeldete Zustand eines Geräts nach Programmstart oder Verbindung (z. B. Schalter „aus“, Tuya noch nicht verbunden) zählt nicht mehr als Änderung. Echte Änderungen und Ereignisse (Taster) lösen wie bisher aus; für Aktionen beim Start gibt es den Auslöser „Systemstart“.

## 1.25.0
- **Plugin-Schnittstelle:** `HL.settings(id, {title, render})` – Plugins können eigene Einstellungsdialoge (Einstellungen → Erweiterungen → Plugins → ⚙) mitbringen.

## Plugins
- **Neu: Plugin „TP-Link Tapo Kameras“ 1.0.0** (`plugins-example/tapo-kamera`) – Tapo-/ONVIF-Kameras lokal: Bewegung, Person, Fahrzeug, Tier und Sabotage als Geräte, Standbild und Live-Ansicht (ffmpeg), Schwenken und Positionen. Nur gegen einen Nachbau getestet.
- **Neu: Plugin „Zigbee (Zigbee2MQTT)“ 1.0.0** (`plugins-example/zigbee2mqtt`) – Zigbee-Geräte über Zigbee2MQTT: automatische Geräteanlage, Anlernen/Umbenennen/Entfernen in HomeLite, Einrichtungs-Assistent für Sonoff ZBDongle-E/-P und ConBee II. Nur gegen einen Nachbau getestet.
- **Neu: Plugin „Z-Wave“ 1.0.0** (`plugins-example/zwave`) – Z-Wave-Geräte über zwave-js-server / Z-Wave JS UI, ohne Zusatzpakete. Noch nicht an echter Hardware getestet.
- `alarmzentrale` 1.1.0: **Tastenfeld** mit PIN (Sperre nach 5 Fehlversuchen) auf der Seite „Alarm"; Sensoren, Sirenen, Zeiten und PIN jetzt in den Plugin-Einstellungen.
- **Neu: Plugin „Alarmzentrale“ 1.0.0** (`plugins-example/alarmzentrale`) – zentrale Alarmanlage mit frei wählbaren Sensoren und Sirenen, Zuhause-/Abwesend-Modus, Verzögerungen, PIN, Benachrichtigung und Protokoll.

## 1.24.0
- **Neues Logo und Symbol:** Seitenleiste, Anmeldeseite, Favicon, iPhone-Home-Bildschirm-Symbol und `manifest.webmanifest` (Installation als App). Logos liegen in `assets/`. Auf GitHub: Spenden-Button am Repository (`.github/FUNDING.yml`) und Badge im README.

## 1.23.0
- **Einstellungen → Allgemein:** Abschnitt „HomeLite unterstützen“ mit Spenden-Button (PayPal, freiwillig). Dazu `siocs-heizung` 1.1.0 (Raumsolltemperatur) und `siocs-heizung` 1.0.0 (neues Plugin).

## 1.22.0
- **Tägliche Update-Prüfung:** HomeLite fragt einmal am Tag das GitHub-Repository ab (Standard-Quelle `friedlro/Homelite`), zeigt oben den Chip „⬆ Update x.y.z“ und sendet eine Benachrichtigung. Ein Klick zeigt die Neuerungen aus dem Changelog; beim Installieren erscheinen sie ebenfalls. Abschaltbar unter Software-Update, dort auch „Jetzt prüfen“.

## 1.21.1
- Plugin-Installation „Von Adresse“ (GitHub): akzeptiert jetzt auch Ordner-Adressen wie `https://github.com/friedlro/Homelite/tree/main/plugins-example/philips-hue`; bei einem Repository mit mehreren Plugins erscheint eine Liste statt eines Fehlers, Nicht-Archive werden verständlich gemeldet.

## 1.21.0
- **Neu: Plugin „Flows“ 1.0.0** – visueller Editor (Node-RED/n8n-Stil), ca. 35 Knoten, Ausdrücke `{{ }}`, Fehlerbehandlung mit Wiederholung, Unterflows, Verlauf, eigene Knoten, KI-Werkzeuge `flows_*`.
- Plugin-API: `api.mqtt`, `api.http` (öffentlicher Webhook `/hook/<plugin>/<token>/…`), `api.expose/use/onUse` (Plugin-zu-Plugin), `api.sun()`.

## 1.20.4 – 1.20.1 (Energie)
- Netzbezug-Spitzen je Viertelstunde mit Kurzspitzen (1.20.1/1.20.2), Rückblick über 5 Tage (1.20.4), Grenzwert-Linie.
- 1.20.3: Kacheln „springen“ beim Darüberfahren nicht mehr (Hover ohne Transform).

## 1.20.0
- **Tuya ist ein Plugin** (`tuya` 1.0.0); vorhandene Anmeldung und Geräte werden beim Update automatisch übernommen (Geräte-IDs bleiben).

## 1.19.10
- Tuya lokal im LAN (tinytuya) mit Cloud-Fallback.

## 1.19.9 / 1.19.8
- Plugin „Claude“ (Chat-Assistent über Claude-Abo / Claude Code CLI); Plugin-Berechtigung `core` (Zugriff auf Kern-Werkzeuge).

## 1.19.7 / 1.19.6
- Apple TV: Standby-Anzeige bei eingeschaltetem Gerät behoben (Statuslogik und Wiederverbindung).

## Plugins
- `systemmonitor` 1.0.0 (CPU/RAM/Temperatur/Datenträger), `claude` 1.1.0, `tuya` 1.0.0, `flows` 1.0.0.

Frühere Versionen: siehe [HANDBUCH.md](HANDBUCH.md).
