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
- **Heizung, Auto (Leapmotor), Geofence mit dem iPhone, „Wo ist?“-Karte**
- **KI-Zugriff (MCP):** Claude kann Geräte lesen/steuern und Automationen entwerfen (neue Automationen und Flows starten immer ausgeschaltet)
- **Plugins:** Erweiterungen ohne Systemupdate – [docs/PLUGINS.md](docs/PLUGINS.md)
- **Komfort:** Dashboard bearbeiten, Verlauf, Backup/Wiederherstellung, Update per Klick, Übernahme aus Home Assistant

## Schnellstart
Voraussetzung: Node.js ≥ 22.
```bash
git clone https://github.com/friedlro/Homelite.git
cd Homelite
npm install --omit=dev
node server.js          # http://<server>:3100
```
Das erste Login-Passwort steht beim ersten Start in der Konsole bzw. im Log (`journalctl -u homelite | grep -i passwort`).
Dauerbetrieb (systemd), Raspberry Pi und Updates: [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Plugins (`plugins-example/`)
| Plugin | Zweck |
|---|---|
| `flows` | Visueller Flow-Editor (Node-RED/n8n-Stil), Webhooks, MQTT, Unterflows, Verlauf, eigene Knoten |
| `tuya` | Tuya / Smart Life, lokal (LAN) mit Cloud-Fallback |
| `siocs-heizung` | Fernwärme-Heizung über das SIOCS-Webportal (Sensoren, Betriebsart, Korrektur, Heizzeiten) |
| `claude` | Claude-Assistent im Chat (über Claude-Abo via Claude Code CLI), kann Automationen anlegen |
| `systemmonitor` | CPU, RAM, Temperatur, Datenträger des Servers inkl. Warnungen |
| `ssh` | SSH-Zugriff für den KI-Zugriff |
| `philips-hue` | Hue-Bridge |
| `muellkalender` | Müllkalender (CITIES-App) |
| `erreichbarkeit` | Erreichbarkeitsprüfung von Geräten/Adressen |
| `duckdns` | DuckDNS-Client |

Installation: Einstellungen → Erweiterungen → Plugins (Datei oder URL) oder Ordner nach `data/plugins/<id>` kopieren.

## Dokumentation
| Datei | Inhalt |
|---|---|
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Installation, systemd, Raspberry Pi, Update, Backup |
| [docs/HANDBUCH.md](docs/HANDBUCH.md) | Ausführliches Handbuch zu allen Funktionen |
| [docs/FLOWS.md](docs/FLOWS.md) | Flow-Plugin: Knoten, Ausdrücke, Fehlerbehandlung, Erweiterung |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Plugin-API (Server, Oberfläche, MQTT, Webhook, MCP) |
| [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) | Aufbau des Codes und Datenflüsse |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Änderungen je Version |

## Sicherheit
Login mit Passwort und signiertem Cookie, MCP und Webhooks nur mit geheimem Token. HomeLite gehört ins Heimnetz; für Zugriff von außen
ein VPN (z. B. Tailscale) oder einen Reverse-Proxy mit HTTPS verwenden. Plugins und Flows laufen mit den Rechten des HomeLite-Dienstes.
Persönliche Daten (`data/`, `import/ha-migration.json`) sind per `.gitignore` ausgeschlossen.

## Lizenz
MIT (siehe `package.json`).

## Unterstützen

HomeLite ist kostenlos und ohne Werbung. Wenn es dir gefällt, freut sich der Entwickler über eine freiwillige Spende: [paypal.me/RolandFriedl](https://paypal.me/RolandFriedl) (auch in HomeLite unter Einstellungen → Allgemein).
