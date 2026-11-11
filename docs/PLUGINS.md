# HomeLite-Plugins (API-Version 1)

Plugins erweitern HomeLite **ohne Systemupdate und ohne Neustart**. Sie liegen in `data/plugins/<id>/` und bleiben bei Updates von HomeLite erhalten.

**Installieren:** Einstellungen → Erweiterungen → Plugins → „Plugin-Datei wählen (.tar.gz)“ oder „Von Adresse installieren“ (URL einer `.tar.gz` oder eines GitLite- oder GitHub-Repositories). Danach aktivieren und ggf. über „⚙ Einstellungen“ konfigurieren.

> **Sicherheit:** Plugins laufen mit allen Rechten im HomeLite-Prozess (Geräte, Zugangsdaten, Netzwerk). Nur Pakete aus vertrauenswürdiger Quelle installieren.

## Aufbau

```
mein-plugin/
  plugin.json   Pflicht
  index.js      Server-Code (main)
  client.js     optional: Oberfläche (eigene Seite im Menü)
  style.css     optional
```
Paket: `tar -czf mein-plugin-1.0.0.tar.gz mein-plugin` (max. 30 MB; keine Links, keine Pfade außerhalb des Ordners).

Hinweis: Wer ein Plugin installiert hat, kann dessen Seite unter Einstellungen → Erweiterungen → Plugins mit „Im Menü“ ein- oder ausblenden (das Plugin läuft weiter; „Öffnen“ ruft die Seite trotzdem auf).

## plugin.json

| Feld | Bedeutung |
|---|---|
| `id` | `^[a-z0-9][a-z0-9-]{1,40}$`, eindeutig |
| `name`, `version` (x.y.z), `description`, `author`, `icon` | Anzeige |
| `main` | Server-Datei (Standard `index.js`) |
| `client`, `style` | optionale Dateien der Oberfläche |
| `page` | `{ "label": "…", "icon": "…" }` – Seite im Menü |
| `minCore` | Mindestversion von HomeLite |
| `api` | benötigte Plugin-API-Version (1) |
| `config` | Einstellungsfelder: `{key,label,type,help,placeholder,default,options}`; Typen `text`, `textarea`, `number`, `bool`, `password`, `select` |

Optional: `"repo": "https://gitlite…/r/Repo[/tree?ref=Zweig&path=Pfad]"` oder `"https://github.com/Besitzer/Repo[/tree/Zweig/Pfad]"` – Quelle für Update-Hinweis und „Quelle ↗“-Link. Fehlt es, sucht HomeLite unter `plugins-example/<id>` im HomeLite-Repository (Standard: GitLite) nach einer neueren `plugin.json`.

Optional: `"changelog": {"1.2.0": "Was neu ist"}` – wird beim Update-Hinweis angezeigt (alle Versionen neuer als die installierte). Der Knopf „Jetzt aktualisieren“ lädt den Plugin-Ordner aus der Quelle (siehe `repo`) und behält Einstellungen und Geräte.

Plugins im Ordner `plugins-example/` des Repositories erscheinen automatisch im Katalog (Einstellungen → Erweiterungen); Voraussetzung: `plugin.json` mit `id` gleich Ordnername und gültiger `version`.

## Server-API (`index.js`)

```js
module.exports = async function (api) {
  // optional: return { stop() { … } }
};
```

`api.id`, `api.apiVersion`, `api.coreVersion`, `api.dataDir` (eigener Ordner), `api.log(level,msg)`, `api.config()` (aktuelle Einstellungen), `api.onConfig(cb)`, `api.kv.get/set`, `api.timer(fn,ms)` / `api.after(fn,ms)` (werden beim Stoppen automatisch beendet), `api.route(method, sub, fn)` → `/api/plugins/<id>/x/<sub>`, `api.emit(data)` (an die Oberfläche), `api.fire(name)` (Webhook-Auslöser), `api.notify(text)`.

KI-Zugriff (ab HomeLite 1.19): `api.mcp.tool({ name, description, inputSchema, readOnly, control, run(args) })` fügt dem MCP-Server ein Werkzeug hinzu (Name `^[a-z][a-z0-9_]{1,40}$`, darf kein Kern-Werkzeug überschreiben). Mit `control: true` ist es nur nutzbar, wenn „Steuern“ im KI-Zugriff erlaubt ist. Beim Stoppen des Plugins verschwindet es wieder. `api.mcp.endpoint(regenerate?)` liefert `{ path, token }` eines eigenen MCP-Servers nur für dieses Plugin (`/mcp-plugin/<id>/<token>`, nur dessen Werkzeuge, unabhängig vom globalen KI-Zugriff und dessen „Steuern“-Schalter; aktiv solange das Plugin läuft).

Eigene Einstellungen (ab HomeLite 1.25.0): Im `client.js` registriert `HL.settings('<id>', { title, render(el) })` eine eigene Einstellungsoberfläche, die unter *Einstellungen → Erweiterungen → Plugins → ⚙ Einstellungen* in einem Dialog erscheint (für Listen/Geräteauswahl, wo einfache `config`-Felder nicht reichen). Beispiel: `plugins-example/alarmzentrale`.

Geräte: `api.devices.ensure({key,name,type,room,unit,adopt,…})` (`adopt`: ID eines vorhandenen Geräts/Platzhalters, das übernommen wird), `setState(key, patch)`, `remove(key)`, `list()`, `onCommand((dev,action,value)=>…)`, `all()`, `get(ref)`, `control(ref,action,value)`, `onState(fn)`. Plugin-Geräte erscheinen überall (Regeln, Verlauf, KI-Zugriff).

Kernzugriff (ab HomeLite 1.19.8): Mit `"permissions": ["core"]` in `plugin.json` bekommt ein Plugin `api.core.tools()` (Liste der Kern-Werkzeuge wie list_devices, create_automation, get_logs) und `api.core.call(name, args)`. Es gelten dieselben Schalter wie beim KI-Zugriff (Steuern/Automationen). Das Recht wird in der Plugin-Liste angezeigt.

Erweiterte Schnittstellen (ab HomeLite 1.21.0):
- **MQTT:** `api.mqtt.subscribe(filter, (topic, payload)=>…)` (Filter mit `+`/`#`, Rückgabe = Abmelden), `api.mqtt.publish(topic, payload, {retain})`, `api.mqtt.connected()` – über die vorhandene Broker-Verbindung von HomeLite.
- **Öffentlicher Webhook:** `api.http.on(async ({method, sub, query, headers, body, ip}) => ({status, headers, body}))` beantwortet Aufrufe von `/hook/<id>/<geheimer-Token>/<sub>` (ohne Login, der Token ist das Passwort). `api.http.url()` liefert den Pfad, `api.http.regenerate()` erzeugt einen neuen Token.
- **Plugin-zu-Plugin:** `api.expose(objekt)` stellt eine Schnittstelle bereit; andere Plugins holen sie mit `api.use('<id>')` oder – auch wenn das Plugin später startet – mit `api.onUse('<id>', (obj)=>…)` (`obj` ist `null`, wenn das Plugin stoppt).
- **Sonne:** `api.sun(datum?)` → `{ sunrise, sunset }` (Date) für die Heimat-Zone, sonst `null`.

### Flows erweitern
Das Plugin **Flows** (`plugins-example/flows`) stellt per `expose` bereit: `registerNode(def, ownerId)`, `unregisterNodes(ownerId)`, `run(flowId, msg)`, `list()`. Ein anderes Plugin kann so eigene Knoten liefern:

```js
api.onUse('flows', (flows) => flows && flows.registerNode({
  type: 'meinplugin.preis', label: 'Strompreis', category: 'Daten', icon: '💶',
  fields: [{ key: 'zone', label: 'Zone', type: 'text', default: 'AT' }],
  async run(ctx, msg) { msg.payload = await holePreis(ctx.cfg.zone); return msg; },
}, api.id));
```
Alternativ legt man eine `.js`-Datei in `data/plugin-data/flows/nodes/` (siehe dort `_beispiel.js`). Felder-Typen: `text textarea number bool select combo device json code time weekdays list flowref`; Textfelder dürfen `{{ Ausdrücke }}` enthalten, `ctx.cfg` ist schon ausgewertet. Auslöser-Knoten haben statt `run` eine Funktion `start(ctx)` und rufen `ctx.emit(msg)`.

## Oberfläche (`client.js`)

Globales `HL`: `HL.page(id,{label,icon,render(el)})`, `HL.on(id, cb)` (Ereignisse aus `api.emit`), `HL.api(id, method, sub, body)`, `HL.rawApi`, `HL.h`, `HL.fill`, `HL.toast`, `HL.fail`, `HL.fmtTime`, `HL.fmtNum`, `HL.dev`, `HL.st`, `HL.S`.

## Beispiele
- `plugins-example/erreichbarkeit/` – prüft per TCP, ob Geräte erreichbar sind, legt Sensoren an und zeigt eine Live-Seite.
- `plugins-example/duckdns/` – DuckDNS-Client.
- `plugins-example/philips-hue/` – Philips-Hue-Bridge (Lampen, Steckdosen, Sensoren, Dimmer, Szenen; Koppeln per Link-Taste).
- `plugins-example/muellkalender/` – Müllabfuhr-Termine aus der CITIES-App (Sensoren, Vorabend-Erinnerung).
- `plugins-example/tuya/` – Tuya / Smart Life (Cloud per QR-Anmeldung, lokal im Heimnetz mit Cloud-Rückfall); ersetzt die frühere eingebaute Tuya-Anbindung, übernimmt Altdaten beim Update.
- `plugins-example/alarmzentrale/` – Alarmzentrale: beliebige Binär-Sensoren (Bewegung, Tür/Fenster …) und Sirenen/Lichter wählbar, Modi Zuhause/Abwesend, Ausgangs-/Eingangsverzögerung, Sirenendauer, PIN, Protokoll, Sirenentest; Geräte `Alarm Status/Zuhause/Abwesend/ausgelöst`, Webhook-Auslöser `alarm_ausgeloest`, KI-Werkzeuge. Tastenfeld mit PIN auf der Seite; Geräteauswahl in den Plugin-Einstellungen. Siehe `LIESMICH.md`.
- `plugins-example/tapo-kamera/` – TP-Link Tapo Kameras lokal über ONVIF (PullPoint-Ereignisse, PTZ, Positionen) und RTSP/ffmpeg (Standbild, Live-Ansicht): legt Bewegung/Person/Fahrzeug/Tier/Sabotage als Geräte an.
- `plugins-example/zigbee2mqtt/` – Zigbee über Zigbee2MQTT (MQTT-Broker von HomeLite): legt Lichter, Schalter, Thermostate, Schlösser, Sensoren, Binärmelder und Taster automatisch an, Anlernen/Umbenennen/Entfernen, Einrichtungs-Assistent für Sonoff ZBDongle-E/-P, ConBee II u. a. (erzeugt configuration.yaml und docker-compose.yml).
- `plugins-example/zwave/` – Z-Wave: WebSocket-Client für zwave-js-server (Z-Wave JS UI), legt Schalter, Dimmer, Schlösser, Thermostate, Sensoren, Zähler, Batterien, Binärmelder und Taster automatisch als Geräte an; Geräte anlernen/entfernen, Knotenliste. Siehe `LIESMICH.md`.
- `plugins-example/siocs-heizung/` – SIOCS Heizung (Fernwärme-Übergabestation, SCHNEID MR-12): Python-Brücke mit Playwright/Chromium bedient das Webportal; Sensoren, Thermostat, Schalter Absenkbetrieb/Partymodus, Heizzeiten, KI-Werkzeug. Voraussetzung: `pip install playwright` + `playwright install chromium`. Portiert aus `friedlro/ha-siocs-heizung`.
- `plugins-example/claude/` – Claude-Assistent: Chat und Systemcheck in HomeLite über das Claude-Abo (Claude Code auf dem Server, kein API-Schlüssel), legt Automationen immer ausgeschaltet an. Nutzt `scopeOnly`-Werkzeuge (nur über den Plugin-Endpunkt, nicht im globalen KI-Zugriff).
- `plugins-example/systemmonitor/` – Systemüberwachung des HomeLite-Rechners: CPU, RAM, Temperatur, Datenträger, Last; Sensoren, 24-h-Verlauf, Grenzwert-Warnungen, MCP-Tool `system_status`.
- `plugins-example/ssh/` – SSH für den KI-Zugriff: Tools `ssh_hosts` und `ssh_exec` (nur eingetragene Hosts, eigener Schlüssel, Verlauf) und ein Terminal auf der Seite „SSH“.
