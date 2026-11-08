# Änderungen

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
