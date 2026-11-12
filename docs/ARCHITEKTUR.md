# Architektur

```
server.js            HTTP-API, SSE (Live-Updates), Login/Cookie, Webhooks (/hook/…), MCP-Einbindung
lib/store.js         Konfiguration in SQLite (node:sqlite), Key-Value-Speicher, Energie-Viertelstunden
lib/devices.js       Geräte-Treiber (MQTT, Shelly, HTTP, virtuell, Plugin), Zustände, Steuerung, MQTT-Abos
lib/engine.js        Automationen (Auslöser, Bedingungen, Modi, Aktionen)
lib/plugins.js       Plugin-Laufzeit und Schnittstelle (api.*), Webhook-Weiterleitung, Plugin-zu-Plugin
lib/mcp.js           MCP-Server (KI-Zugriff) + Werkzeuge der Plugins
lib/energy.js        Energiebilanz, Netzbezug-Spitzen (Viertelstunden, Kurzspitzen)
lib/heating.js, presence.js, history.js, dew.js, sun.js, broker.js, matter.js, appletv.js, …
lib/migrate_tuya.js  einmalige Übernahme alter Tuya-Daten ins Tuya-Plugin
public/              Weboberfläche ohne Build-Schritt (core.js, pages-*.js, style.css)
plugins-example/     mitgelieferte Plugins
raspberry-pi/        Installer für den Raspberry Pi
docs/                Dokumentation
```

## Datenfluss
1. Treiber melden Zustände an `devices` → Ereignis `state` (Oberfläche per SSE, Automationen, Verlauf, Energie, Plugins via `api.devices.onState`).
2. `engine` wertet Automationen aus; Plugins (z. B. Flows) reagieren unabhängig auf dieselben Ereignisse.
3. Steuerbefehle laufen über `devices.control`, auch aus Plugins (`api.devices.control`) und der KI (MCP).

## Plugins
Ein Plugin ist ein Ordner mit `plugin.json`, `index.js` (Server), optional `client.js`/`client.css`. Es läuft im selben Prozess,
bekommt das Objekt `api` (Konfiguration, Speicher, Timer, Routen, Geräte, MQTT, Webhook, MCP-Werkzeuge, Kernzugriff mit Berechtigung `core`)
und wird beim Stoppen automatisch aufgeräumt. Siehe [PLUGINS.md](PLUGINS.md).

## Flows
`plugins-example/flows`: `lib/engine.js` (Ausführung, Verlauf, Fehler), `lib/nodes.js` (Knotenbibliothek), `lib/registry.js` (Knoten-Register mit Datei-/Plugin-Erweiterungen),
`lib/expr.js` (abgeschottete VM nur mit JSON-Daten), `lib/cron.js`, `client.js` (SVG-Editor). Siehe [FLOWS.md](FLOWS.md).

## Tests
Es gibt keine Build-Pipeline; geprüft wird mit `node --check` und Playwright gegen einen Testserver mit eigenem `HOMELITE_DATA`.
