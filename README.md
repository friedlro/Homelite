<p align="center">
  <img src="assets/homelite-logo.svg" alt="HomeLite" width="520">
</p>

<p align="center">
  <a href="https://paypal.me/RolandFriedl"><img alt="Spenden via PayPal" src="https://img.shields.io/badge/Spenden-PayPal-0070ba?logo=paypal&logoColor=white"></a>
</p>

Leichte, eigenständige Hausautomatisierung in **Node.js** – gedacht als schlanke alternative zu Home Assistant auf einem
Heimserver oder Raspberry Pi (ab Pi 2). Keine Cloud-Pflicht, keine Build-Schritte, Daten in einer SQLite-Datei.

## Funktionen
- **Geräte:** MQTT (mit eingebautem Broker), Shelly (Gen1 CoIoT, Gen2+), HTTP-Sensoren, Matter (z. B. SwitchBot), Apple TV (Status), Ecowitt-Wetterstation, Taupunkt-Berechnung, virtuelle Geräte
- **Automationen:** Auslöser, Bedingungen (UND/ODER, „ausgelöst durch“), Modi, Sonnenauf-/-untergang, Webhooks
- **Flows (Plugin):** visueller Editor im Stil von Node-RED und n8n für komplexe Abläufe – siehe [docs/FLOWS.md](docs/FLOWS.md)
- **Energie:** Victron & Co., Tages-/Monatswerte, Netzbezug-Spitzen in Viertelstunden mit Kurzspitzen und 5-Tage-Rückblick
- **Heizung, Geofence mit dem iPhone, „Wo ist?“-Karte;** Auto (Leapmotor) als Plugin
- **KI-Zugriff (MCP):** Claude kann Geräte lesen/steuern und Automationen entwerfen (neue Automationen und Flows starten immer ausgeschaltet)
- **Plugins:** Erweiterungen ohne Systemupdate – [docs/PLUGINS.md](docs/PLUGINS.md)
- **Komfort:** Dashboard bearbeiten, Verlauf, Backup/Wiederherstellung, Update per Klick, Übernahme aus Home Assistant

## Schnellstart
Voraussetzung: Node.js ≥ 22.
```bash
git clone https://github.com/friedlro/homelite.git
cd homelite
npm install --omit=dev
node server.js          # http://<server>:3100
```
Das erste Login-Passwort steht beim ersten Start in der Konsole bzw. im Log (`journalctl -u homelite | grep -i passwort`).
Dauerbetrieb (systemd), Raspberry Pi und Updates: [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Plugins (`plugins-example/`)
| Plugin | Zweck |
|---|---|
| `esp32-display` | ESP32 mit Display (z. B. Waveshare): Seiten/Kacheln in HomeLite, nur Änderungen per MQTT-Textprotokoll, Tippen zurück. Mit Firmware für ESP32 und gängige SPI-Displays (Waveshare 3.5", ILI9341, ILI9486, ILI9488, ST7796, ST7789, CYD; PlatformIO) inkl. Bildschirmschoner mit Uhr: [firmware/esp32-display](firmware/esp32-display/README.md) |
| `tomons-wallbox` | Tomons / Inateck Mobile Wallbox über die Tomons-Cloud (inoffiziell, experimentell): Leistung, Energie, Kabelstatus, Ladestrom-Grenze |
| `flows` | Visueller Flow-Editor (Node-RED/n8n-Stil), Webhooks, MQTT, Unterflows, Verlauf, eigene Knoten |
| `tuya` | Tuya / Smart Life, lokal (LAN) mit Cloud-Fallback |
| `alarmzentrale` | Alarmanlage: Sensoren und Sirenen frei wählbar, Zuhause/Abwesend, Verzögerungen, PIN, Protokoll |
| `tapo-kamera` | TP-Link Tapo Kameras lokal (ONVIF/RTSP): Bewegung/Person als Geräte, Standbild, Live-Ansicht, Schwenken und Positionen |
| `zigbee2mqtt` | Zigbee über Zigbee2MQTT (Sonoff ZBDongle-E/-P, ConBee II …): Geräte automatisch anlegen, anlernen/umbenennen/entfernen, Einrichtungs-Assistent |
| `zwave` | Z-Wave über zwave-js-server (Z-Wave JS UI): Schalter, Dimmer, Schlösser, Thermostate, Sensoren, Taster; Geräte anlernen/entfernen |
| `siocs-heizung` | Fernwärme-Heizung über das SIOCS-Webportal (Sensoren, Betriebsart, Korrektur, Heizzeiten) |
| `claude` | Claude-Assistent im Chat (über Claude-Abo via Claude Code CLI), kann Automationen anlegen |
| `systemmonitor` | CPU, RAM, Temperatur, Datenträger des Servers inkl. Warnungen |
| `ssh` | SSH-Zugriff für den KI-Zugriff |
| `philips-hue` | Hue-Bridge |
| `muellkalender` | Müllkalender (CITIES-App) |
| `erreichbarkeit` | Erreichbarkeitsprüfung von Geräten/Adressen |
| `duckdns` | DuckDNS-Client |
| `tailscale` | Tailscale: Status, Geräte im Tailnet, Sensoren, Serve-/Funnel-Prüfung mit Warnung bei Internet-Freigabe |
| `bmw` | BMW/MINI über BMW CarData: Ladestand, Reichweite, Laden, Türen, Standort mit Karte, Reifen, Service und alle Werte wie in der App (nur lesend) |
| `leapmotor` | Leapmotor-Auto über die Leapmotor-Cloud (inoffiziell): Ladestand, Reichweite, Reifendruck, Standort mit Karte, Sensoren als Geräte, Fernbefehle, Automations-Aktion, KI-Werkzeuge; früher fest eingebaut, Daten werden beim Update übernommen |

Der Bereich „Verfügbare Plugins“ (Einstellungen → Erweiterungen) listet alle Plugins des Repositories zur Installation mit einem Klick. Fertige SD-Karten-Images für Orange Pi One und Raspberry Pi 2+: siehe [docs/INSTALLATION.md](docs/INSTALLATION.md).

Installation: Einstellungen → Erweiterungen → Plugins (Datei oder URL) oder Ordner nach `data/plugins/<id>` kopieren. Neue Plugin-Versionen werden dort mit „⬆ Update“ und Link zur Quelle angezeigt. Standard-Quelle für Updates und Plugins ist das GitHub-Repository `https://github.com/friedlro/homelite`; ein GitLite-Repository ist als Quelle ebenfalls möglich (dafür muss `git` auf dem Gerät installiert sein).

## Firmware (`firmware/`)
Firmware für eigene Geräte, die mit HomeLite zusammenarbeiten (getrennt von den Plugins, wird nicht mit ihnen installiert).

| Ordner | Zweck |
|---|---|
| [`firmware/esp32-display`](firmware/esp32-display/README.md) | ESP32 + gängige SPI-Displays (PlatformIO, eine Umgebung je Controller: Waveshare 3.5" RPi LCD, ILI9341, CYD/ESP32-2432S028R, ILI9488, ILI9486, ST7796, ST7789) für das Plugin `esp32-display`: Seiten und Kacheln aus HomeLite, Tippen schaltet, Bildschirmschoner mit wanderndem Datum und Uhrzeit |

## Dokumentation
| Datei | Inhalt |
|---|---|
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Installation, systemd, Raspberry Pi, Update, Backup |
| [docs/SICHERHEIT.md](docs/SICHERHEIT.md) | Schutzmaßnahmen, Empfehlungen, Betrieb ohne root |
| [docs/HANDBUCH.md](docs/HANDBUCH.md) | Ausführliches Handbuch zu allen Funktionen |
| [docs/FLOWS.md](docs/FLOWS.md) | Flow-Plugin: Knoten, Ausdrücke, Fehlerbehandlung, Erweiterung |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Plugin-API (Server, Oberfläche, MQTT, Webhook, MCP) |
| [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) | Aufbau des Codes und Datenflüsse |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Änderungen je Version |

## Sicherheit
Login mit Passwort und signiertem Cookie, MCP und Webhooks nur mit geheimem Token. HomeLite gehört ins Heimnetz; für Zugriff von außen
ein VPN (z. B. Tailscale) oder einen Reverse-Proxy mit HTTPS verwenden. Von außen (Internet, Tunnel, Portfreigabe) erreichbar sind nur die per Schlüssel geschützten Pfade `/mcp`, `/hook`, `/trigger` und `/where.html` (Tailscale Funnel wird akzeptiert, abschaltbar); dazu Anfragenbegrenzung und Scanner-Sperre – Details in [docs/SICHERHEIT.md](docs/SICHERHEIT.md). Plugins und Flows laufen mit den Rechten des HomeLite-Dienstes.
Persönliche Daten (`data/`, `import/ha-migration.json`) sind per `.gitignore` ausgeschlossen.

## Lizenz
MIT (siehe `package.json`).

## Unterstützen

HomeLite ist kostenlos und ohne Werbung. Wenn es dir gefällt, freut sich der Entwickler über eine freiwillige Spende: [paypal.me/RolandFriedl](https://paypal.me/RolandFriedl) (auch in HomeLite unter Einstellungen → Allgemein).

### Einrichtung und individuelle Plugins

Du möchtest HomeLite nicht selbst aufsetzen oder brauchst die Anbindung eines bestimmten Geräts? Auf Anfrage gibt es gegen Bezahlung:

- **Einrichtung und Migration** – Installation auf Heimserver oder Raspberry Pi, Umstieg von Home Assistant
- **Individuelle Plugins** – Anbindung deines Geräts oder Dienstes; das Plugin wird danach offen in diesem Repository veröffentlicht
- **Support** – Hilfe bei Fehlersuche und Automationen auf Stundenbasis

Anfragen bitte über ein [GitHub-Issue](https://github.com/friedlro/Homelite/issues/new) mit dem Titel „Anfrage".
