# HomeLite

Leichte Hausautomatisierung. Geräte direkt über MQTT (Zigbee2MQTT, Tasmota, beliebige Topics) und Shelly per HTTP, eigene Automationen, Heizungssteuerung mit Zeitplan, Geofence fürs iPhone.

## Installation

Voraussetzungen: Node.js ≥ 22, Python 3 (nur für Plugins wie Leapmotor und Tuya), ein MQTT-Broker (z. B. Mosquitto).

```bash
cd homelite
npm install                      # installiert das Paket "mqtt"
pip install requests cryptography paho-mqtt   # nur für die Plugins Leapmotor und Tuya (optional: pyatv für Apple TV, pyicloud für „Wo ist?“) (ggf. --break-system-packages bzw. venv); außerdem muss curl installiert sein
PORT=3100 node server.js
```

Beim ersten Start wird ein Login-Passwort in der Konsole ausgegeben (später unter *Einstellungen* änderbar). Daten liegen in `data/` (`config.json`, `presence.json`); Ordner `HOMELITE_DATA` ändert den Pfad.

Als Dienst (systemd):

```ini
[Unit]
Description=HomeLite
After=network-online.target

[Service]
WorkingDirectory=/opt/homelite
ExecStart=/usr/bin/node server.js
Environment=PORT=3100
Restart=always
User=homelite

[Install]
WantedBy=multi-user.target
```

## Einrichtung

1. **Einstellungen → MQTT**: Broker-URL (`mqtt://192.168.1.10:1883`), Benutzer/Passwort, Zigbee2MQTT-Base-Topic (Standard `zigbee2mqtt`).
2. **Geräte → Hinzufügen**
   - *Entdeckt*: Zigbee2MQTT-Geräte (Lichter, Schalter, Thermostate, Sensoren, Kontakte, Taster) und Tasmota-Relais erscheinen automatisch zur Auswahl.
   - *Shelly per IP*: Gen 1 und Gen 2/3 (ohne Digest-Auth) per HTTP, Abfrage alle 10 s.
   - *Manuell*: beliebiges MQTT-Gerät. Beispiel Schalter:
     ```json
     {
       "stateTopics": ["mein/geraet/state"],
       "paths": { "on": "" },
       "cmd": { "topic": "mein/geraet/set", "on": "ON", "off": "OFF" }
     }
     ```
     `paths` sind Punkt-Pfade im JSON-Payload (`"on": "POWER1"`, `"value": "ENERGY.Power"`); `""` bedeutet ganzer Payload. In `cmd` steht `{{v}}` für Helligkeit/Solltemperatur.
   - *HTTP-Sensor*: JSON-Endpunkt wird zyklisch abgefragt (z. B. Ecowitt `http://<IP>/get_livedata_info`, Wert per Pfad mit Filter `common_list[id=0x0B].val`).
   - *Virtuell*: Software-Schalter (z. B. Hilfsschalter für Automationen), Zustand bleibt erhalten.
   - Typ *Rollo/Markise (cover)*: öffnen/schließen/stoppen/umschalten, bei Shelly im Rollo-Modus direkt per HTTP.
3. **Automationen**
   - Auslöser: Gerät, Uhrzeit, Sonnenauf-/untergang (mit Versatz, aus der Heimposition berechnet), Intervall, Start, Webhook, Geofence.
   - Bedingungen: Gerät (auch negiert), Zahlenvergleich, Differenz zweier Sensoren, Uhrzeit, Wochentag, Anwesenheit.
   - Aktionen: Gerät, Warten, *Voraussetzung*, *Wenn/Dann/Sonst* (verschachtelbar), Push, Heizung, Leapmotor (braucht das Plugin „Leapmotor“), MQTT, HTTP.
   - Modus: *einzeln* (neuer Lauf wird übersprungen), *neu starten* oder *Warteschlange*. „Still“ unterdrückt Log-Einträge.
   - Ohne Auslöser = Szene; mit Haken erscheint sie als Knopf im Dashboard.
4. **Heizung**: pro Raum ein Thermostat (z. B. Zigbee-Heizkörperventil) **oder** ein Schalter plus Temperatursensor (Zweipunktregelung ±0,3 °C), Komfort-/Absenktemperatur und Zeitfenster. Bei „niemand zuhause“ wird automatisch abgesenkt. ± im Raum = 2 Std. Boost.
5. **Push-Nachrichten**: Aktion „Push-Nachricht“ nutzt [ntfy](https://ntfy.sh) (kostenlose iPhone-App, auch selbst hostbar) – Topic unter *Einstellungen* eintragen und in der App abonnieren.

## Übernahme aus Home Assistant

*Einstellungen → Aus Home Assistant übernehmen* (oder Knopf bei leerem Dashboard) legt 59 Geräte, 41 Automationen und die Räume aus `import/ha-migration.json` an. Der Import ist wiederholbar und legt nichts doppelt an.

- Tasmota-Geräte werden über die MAC erkannt, sobald der Broker die `tasmota/discovery/…`-Meldung liefert (bis dahin „wartet“).
- Shelly-Geräte: IP eintragen (Gerät bearbeiten), dann sind sie aktiv.
- Tuya-Geräte (Elternbett, Streifen, Stimmungslichter, Keller-Sensoren u. a.) sind Platzhalter; Automationen darauf loggen „nicht verbunden“ und laufen sonst weiter.
- Ecowitt-Windsensor: URL und Schwellwerte prüfen.
- Nicht übernommen: SwitchBot-Schloss/Haustürmeldungen, Heizung, Victron, Sonos, Leapmotor-Entitäten. Heizung richtest du in HomeLite selbst ein, das Auto über das Plugin „Leapmotor“.
- Heimposition ist nur grob Leibnitz – unter *Geofence* genau eintragen.
- **NFC/Kurzbefehle**: Webhook `/trigger?key=<Geofence-Schlüssel>&name=nfc_markise` löst Automationen mit Webhook-Auslöser aus.

## Matter (SwitchBot-Schloss & Co.)

HomeLite ist Matter-Controller (matter.js, läuft als eigener Prozess). Einrichten unter *Einstellungen → Matter*:

1. **„Matter-Paket installieren“** (führt `npm install` im HomeLite-Ordner aus und lädt `@matter/main`; Node ≥ 22.13, Internetzugang des Servers nötig). Alternativ von Hand: `cd /opt/homelite && npm install`.
2. **Matter aktivieren.**
3. **SwitchBot-Schloss**: Es wird über einen Matter-fähigen SwitchBot Hub (Hub Mini Matter / Hub 2) eingebunden. In der SwitchBot-App: Hub → Matter → „Mit anderen Plattformen koppeln“ → Kopplungscode (11 Ziffern) erzeugen und in HomeLite bei *Gerät koppeln* einfügen. Das Schloss muss am Hub hängen und dort für Matter freigegeben sein. Andere Matter-Geräte (WLAN/Ethernet, bereits im Netzwerk, „Mit anderer App teilen“) gehen genauso.
4. Danach legt HomeLite die Geräte automatisch an: **Schloss** (Kachel 🔒 zum Auf-/Zusperren, Aktionen „Zusperren/Aufsperren“ in Automationen, Zustand `locked`/`unlocked` als Auslöser), Schalter, Lichter, Temperatur-, Feuchte-, Helligkeits-, Kontakt-, Anwesenheits- und Batteriesensoren.

Unterstützte Matter-Funktionen: Schloss, Schalter/Steckdose, Licht (dimmbar), Rollo/Vorhang (WindowCovering), Temperatur, Feuchte, Helligkeit, Kontakt, Anwesenheit, Batterie. Fehlt ein Gerät, zeigt *Matter → Diagnose anzeigen* alle Endpunkte und Cluster der gekoppelten Knoten; Endpunkte ohne unterstützte Funktion stehen außerdem im Protokoll („hat keine unterstützte Funktion“).

Die Matter-Zugangsdaten (Fabric) liegen in `data/matter` und sind im Backup enthalten. Nicht unterstützt: Koppeln über Bluetooth/Thread-Neuinstallation (nur Geräte, die schon im Netzwerk sind).

## Shelly Motion / Motion 2 (Batteriegeräte)

Der Sensor schläft und ist per IP meist nicht erreichbar. Deshalb läuft er über MQTT: Reset-Taste kurz drücken, im Browser `http://<IP-des-Sensors>/` öffnen, unter *Internet & Sicherheit → MQTT* den Broker von HomeLite eintragen und speichern. Sobald der Sensor das erste Mal sendet (Bewegung genügt), erscheint er in *Geräte → Hinzufügen → Entdeckt*. Alternativ unter *Shelly per IP* mit der Geräte-ID (`shellymotion2-<MAC>` oder nur die 12-stellige MAC) direkt hinzufügen – ohne dass der Sensor erreichbar sein muss. Angelegt werden Bewegung, Erschütterung, Helligkeit, Temperatur und Batterie (Topics `shellies/<ID>/info` bzw. `/status`).

## Wetterstation (Ecowitt)

*Einstellungen → Wetterstation (Ecowitt)*: IP des Gateways (GW1100, GW1000, GW2000 …) eintragen, „Verbinden & Sensoren anlegen“. HomeLite liest lokal `http://<IP>/get_livedata_info` (keine Cloud, nichts am Gateway einzustellen) und legt Sensoren für Außentemperatur, gefühlte Temperatur, Taupunkt, Feuchte, Wind (Richtung, Geschwindigkeit, Böen), Regen, Luftdruck, UV, Sonnenstrahlung, Innenfühler und Zusatzsensoren (Kanal-Temp/Feuchte, Boden, PM2.5, Leckage, Blitz) an. Einheiten werden auf °C, km/h, mm, hPa umgerechnet. Die Sensoren sind für Automationen nutzbar (*Geräte*) und erscheinen als Kachel „Wetter“ auf dem Dashboard (bei eigenem Layout: *Bearbeiten → + Kachel → Wetter*).

## Dashboard bearbeiten

Auf der Startseite „✎ Bearbeiten“: Blöcke (Szenen, Anwesenheit, Auto, Heizung, Energie, Favoriten, einzelne Räume, „Weitere“, einzelne Geräte) per Ziehen oder ▲▼ anordnen, mit ✕ entfernen, mit „+ Kachel“ hinzufügen, „Standard“ stellt die Ausgangsanordnung wieder her. Der Hinweis auf nicht verbundene Geräte steht jetzt unter *Geräte*.

## Energie (Victron & Co.)

Seite *Energie*: Flussdiagramm (Solar, Netz, Haus, Batterie), Tages-/7-/30-Tage-kWh, Autarkie und Eigenverbrauch, Leistungsverlauf (Tooltip, Tabellenansicht) und Einzelverbraucher. HomeLite integriert die Leistung selbst zu kWh (Daten in `data/energy.json`, im Backup enthalten).

- **Victron (Cerbo GX)**: *Energie → Victron …*. HomeLite verbindet sich direkt mit dem **eigenen MQTT-Broker des Cerbo** (am Cerbo: Einstellungen → Dienste → *MQTT im LAN* aktivieren, Port 1883). IP eintragen, „Portal-ID suchen“, speichern. Gelesen werden `N/<ID>/system/0/…` (PV DC/AC, Netz L1–L3, Batterie Leistung/SOC, Verbrauch); dafür entstehen ausgeblendete Sensoren. HomeLite sendet alle 30 s den Keepalive `R/<ID>/keepalive`. Verbindungsstatus siehe Energie-Seite und Log.
- **Beliebige Quellen**: *Energie → Quellen*: pro Rolle Sensoren wählen (W oder kW, mehrere werden addiert), Vorzeichen umkehrbar, Einzelverbraucher (z. B. Shelly-Leistung).
- Ohne Hausverbrauchs-Sensor gilt Verbrauch = Erzeugung + Netz − Batterie.

## Datenbank (SQLite)

Alle Daten liegen in **einer SQLite-Datei** `data/homelite.db` (in Node ≥ 22.13 eingebaut, keine zusätzliche Installation): Einstellungen, Geräte, Automationen, Anwesenheit sowie Energie-Tageswerte und der minütliche Leistungsverlauf (45 Tage). Beim ersten Start nach dem Update wird eine vorhandene `config.json` (und `presence.json`, `energy.json`) automatisch übernommen und als `*.migrated` aufbewahrt. Backups enthalten eine konsistente Momentaufnahme der Datenbank; ältere Backups mit `config.json` lassen sich weiterhin wiederherstellen. Mit `sqlite3 data/homelite.db` kannst du die Daten bei Bedarf direkt ansehen. Ist SQLite nicht verfügbar (Node < 22.13), arbeitet HomeLite wie bisher mit `config.json`.

## Backup & Wiederherstellung

Einstellungen → „Backup & Wiederherstellung“.

1. Externe Festplatte anschließen und einhängen, z. B. `mount /dev/sdb1 /mnt/backup` (für dauerhaft: `/etc/fstab`). Erkannte Laufwerke unter `/media`, `/mnt`, `/run/media` werden als Schaltflächen angeboten.
2. Zielordner eintragen (z. B. `/mnt/backup/homelite-backup`), Anzahl der aufzubewahrenden Backups und optional tägliches Auto-Backup einstellen, „Backup jetzt erstellen“.
3. Wiederherstellen: in der Liste „Wiederherstellen“ oder eine Backup-Datei hochladen. Vorher wird automatisch eine Sicherung in `data/backups/` angelegt; danach startet HomeLite neu (unter systemd automatisch).

Hinweise: Liegt der Zielordner auf derselben Platte wie HomeLite (Platte nicht eingehängt?), wird das Backup verweigert, außer „Auch auf derselben Festplatte erlauben“ ist aktiv. Die Backups enthalten Passwörter und Zugangsdaten unverschlüsselt – Platte sicher aufbewahren. Fehlgeschlagene Auto-Backups erzeugen einen Log-Eintrag und eine ntfy-Meldung.

## Aktualisieren

HomeLite prüft **einmal täglich** automatisch auf neue Versionen (Standard-Quelle: GitLite-Repository https://gitlite.bicolor-bull.ts.net/r/homelite, in „Software-Update“ änderbar; GitLite- und GitHub-Quellen werden automatisch geprüft. Für GitLite muss `git` installiert sein und der Server das Tailnet erreichen). Gibt es eine neue Version, erscheint oben der Chip „⬆ Update …“ mit den Neuerungen (aus `docs/CHANGELOG.md`) und es kommt eine Benachrichtigung. „Jetzt prüfen“ und das Abschalten der täglichen Prüfung findest du ebenfalls unter Software-Update.


**Per Klick:** *Einstellungen → Software-Update*. Entweder die neue `homelite.tar.gz` mit „Update-Datei wählen …“ hochladen oder eine Update-Quelle eintragen (Link zu einer .tar.gz oder ein GitLite- oder GitHub-Repository) und „Nach Update suchen“ wählen. HomeLite prüft das Paket, legt eine Sicherung an (unter „Zurücksetzen“ wiederherstellbar, die letzten 5 bleiben), ersetzt die Dateien und startet sich neu (bei systemd mit `Restart=always`); die Seite lädt danach von selbst. `data/` (Konfiguration, Geräte, Automationen) bleibt unberührt. Ändern sich die npm-Abhängigkeiten, läuft `npm install` automatisch; neue Python-Pakete musst du ggf. von Hand in `.venv` installieren.

**Von Hand:** Archiv über `/opt/homelite` entpacken (`data/` bleibt), `npm install`, `systemctl restart homelite`.

## MQTT-Monitor

*Einstellungen → MQTT-Monitor* hört einen Topic-Filter (z. B. `zigbee2mqtt/Radar Küche` oder `zigbee2mqtt/#`) bis zu 20 Sekunden mit und zeigt alle Felder der Nachricht. Einzelne Werte (Präsenz, Helligkeit, Entfernung …) lassen sich per Klick als Gerät übernehmen.

## Energie: Spitzen im Netzbezug

Auf der Energie-Seite zeichnet HomeLite pro Viertelstunde (volle :00/:15/:30/:45) die **kurze Spitze** (höchster Momentanwert mit genauer Uhrzeit, bei jeder Wertänderung des Netz-Sensors erfasst – auch Spitzen von nur 1–2 Sekunden) und das **Viertelstunden-Mittel** in kW (wie beim Smart Meter) auf; Umschalter „Kurze Spitze / Viertelstunden-Ø“ (Standard: kurze Spitze). Rückblick: Tage heute bis 5 Tage zurück als Knöpfe, „◀ weiter zurück“ bis 30 Tage, und eine zusammenhängende Ansicht „5 Tage“. Angezeigt werden die Viertelstunden von heute als Balken, die höchste Viertelstunde pro Tag (7/30 Tage), die zehn höchsten Viertelstunden sowie Spitze dieses Monats und des Vormonats. Optional: *⚙ Quellen → Leistungsgrenze (kW)* zeichnet eine Linie ein und markiert Überschreitungen rot. Aufbewahrung 400 Tage. Voraussetzung: ein Netz-Sensor ist in den Quellen eingetragen.

## Tuya / Smart Life (Plugin)

Seit 1.20.0 ist Tuya kein fester Bestandteil mehr, sondern das Plugin **„Tuya / Smart Life“** (`plugins-example/tuya`, Einstellungen → Erweiterungen → Plugins). **Beim Update werden vorhandene Tuya-Anmeldung und verknüpfte Geräte automatisch übernommen**: die Geräte behalten ihre ID (Automationen, Dashboard und Verlauf bleiben), das Plugin wird installiert und eingeschaltet. Neu einrichten: Plugin installieren und einschalten, dann Seite *Tuya*.

Seite *Tuya* (Plugin): Benutzercode aus der Smart-Life-App (Ich → Einstellungen → Konto und Sicherheit → Benutzercode) eintragen, QR-Code erzeugen und in der App über „Scannen“ bestätigen – wie bei Home Assistant, ohne Entwicklerkonto. Das offizielle `tuya-device-sharing-sdk` liegt im Plugin (`tuya/`). Danach erscheinen alle Geräte des Kontos; mit *Übernehmen* werden sie zu HomeLite-Geräten (Licht, Schalter, Sensor). Platzhalter aus der HA-Übernahme (z. B. „Stehlampe“) werden automatisch vorgeschlagen, sodass bestehende Automationen sofort greifen. Zustände kommen live per Tuya-MQTT, geschaltet wird über die Tuya-Cloud – **oder lokal** (siehe unten). Mehrere Messwerte eines Geräts (Temperatur und Feuchte) übernimmst du als getrennte Sensoren. Der Taupunkt wurde in HA berechnet – dafür gibt es in HomeLite keinen fertigen Sensor.

**Lokaler Modus (ab 1.19.10):** Mit dem Python-Paket `tinytuya` (`/opt/homelite/.venv/bin/pip install tinytuya`, danach HomeLite neu starten) verbindet HomeLite WLAN-Geräte direkt im Heimnetz (TCP 6668): Schalten ohne Cloud und ohne Internet, Zustandsänderungen (auch am Gerät) sofort. Der Local Key kommt automatisch aus dem Tuya-Konto; die IP findet HomeLite per Netzwerk-Scan (UDP 6666/6667) – bei Bedarf trägst du sie auf der Tuya-Seite per „IP“ von Hand ein (Protokoll 3.3/3.4/3.5). Pro Gerät zeigt die Spalte „Verbindung“ *lokal* oder *Cloud*. Läuft ein Gerät nicht lokal oder ist ein Befehl nicht direkt übertragbar (z. B. Farben), nimmt HomeLite automatisch die Cloud. Batteriegeräte (Sensoren, Türkontakte) schlafen und bleiben bei der Cloud. Feste IPs im Router reservieren; ändert sich der Local Key (Gerät neu eingelernt), „↻ Geräte neu laden“.

## Leapmotor (Plugin)

Seit 1.26.0 ist Leapmotor kein fester Bestandteil mehr, sondern das Plugin **„Leapmotor“** (`plugins-example/leapmotor`, Einstellungen → Erweiterungen → Plugins; Anleitung im Plugin-Ordner: `LIESMICH.md`). **Beim Update werden Zugangsdaten, Einstellungen und App-Zertifikate automatisch übernommen**, das Plugin wird installiert und – wenn Leapmotor vorher aktiv war – eingeschaltet. Die frühere Seite *Leapmotor* heißt jetzt *Auto* und kommt vom Plugin; das Dashboard-Widget „Auto“ entfällt, stattdessen liefert das Plugin Geräte (Ladestand, Reichweite, Kilometerstand, Innen-/Außentemperatur, Ladeleistung, Entfernung von Zuhause sowie Lädt, Ladestecker, Verriegelt, Klima) für Dashboard, Automationen und Verlauf. Die Automations-Aktion *Leapmotor* und die KI-Werkzeuge `get_car` und `car_command` bleiben (Entriegeln, Kofferraum und Ladestecker entriegeln sind im KI-Zugriff gesperrt).

Der Client in `plugins-example/leapmotor/leapmotor/` stammt aus [kerniger/leapmotor-ha](https://github.com/kerniger/leapmotor-ha) (MIT). Die App-Zertifikate aus [markoceri/leapmotor-certs](https://github.com/markoceri/leapmotor-certs) gehören nicht ins Repository: auf der Seite *Auto* genügt „Zertifikate laden“ (sie liegen dann in `data/plugin-data/leapmotor/certs`). Eintragen musst du App-E-Mail, Passwort und für Fernbefehle die Fahrzeug-PIN; eigene Zertifikate sind optional. Python braucht `requests` und `cryptography`, außerdem `curl`. Status alle 10 Min. (einstellbar). Befehle: ver-/entriegeln, Klima, Schnellheizen/-kühlen, Scheibe enteisen, Batterie vorheizen, Kofferraum, Ladestecker entriegeln, Lenkradheizung, Fenster schließen, finden. Laden starten/stoppen unterstützt die Vorlage nicht. Die Seite zeigt zusätzlich den **Reifendruck** aller vier Räder in bar (Warnung bei Fahrzeug-Alarm oder unter 2,0 bar). Inoffizielle Schnittstelle – kann sich jederzeit ändern.

HomeLite nutzt automatisch `.venv/bin/python3` im Projektordner (sonst `$PYTHON`, sonst `python3`). Bei Problemen zeigt `LEAP_CERT_DIR=/opt/homelite/data/plugin-data/leapmotor/certs /opt/homelite/.venv/bin/python3 /opt/homelite/data/plugins/leapmotor/leap_diag.py <E-Mail> <Passwort> [PIN]` Schritt für Schritt, was fehlt oder abgelehnt wird.

## Eingebauter MQTT-Broker

*Einstellungen → Erweiterungen → „Eingebauter MQTT-Broker“* einschalten: HomeLite startet einen eigenen MQTT-Server (MQTT 3.1/3.1.1, Port 1883, QoS 0/1, Retained-Werte, Last-Will, Wildcards) – ein separater Mosquitto ist nicht mehr nötig. Ohne Zusatzpakete.

1. Benutzer anlegen (anonyme Verbindungen sind standardmäßig verboten).
2. „HomeLite mit diesem Broker verbinden“ stellt HomeLites eigene MQTT-Verbindung automatisch um (eigener Benutzer „homelite“).
3. Zigbee2MQTT, Shelly, Tasmota usw. auf `mqtt://<Server-IP>:1883` mit einem der Benutzer umstellen.

Läuft noch ein Mosquitto auf Port 1883, meldet HomeLite „Port belegt“ – dann dort stoppen oder in HomeLite einen anderen Port wählen. Nicht unterstützt: MQTT 5, TLS (nur im vertrauenswürdigen LAN oder über Tailscale verwenden), persistente Sessions.

## ESP32-Display (Plugin)

Mit dem Plugin `esp32-display` (Seite **Displays**) stellst du Seiten und Kacheln zusammen, ein ESP32 mit Display zeichnet sie. HomeLite sendet nur Änderungen über den MQTT-Broker (kompaktes Textprotokoll), der ESP32 meldet Tippen zurück. Protokoll und Einstellungen: `plugins-example/esp32-display/LIESMICH.md`.

1. **Broker:** Den eingebauten MQTT-Broker (siehe oben) einschalten und einen Benutzer für das Display anlegen.
2. **Display anlegen:** *Displays → Display hinzufügen*, eine Display-ID vergeben (z. B. `flur`), Seiten (max. 8) und Kacheln (max. 12 je Seite) mit Gerät, Beschriftung und Art (*Wert*, *Schalter*, *Zustand*) anlegen; optional Mindeständerung Δ und Nachtabsenkung.
3. **Firmware:** `firmware/esp32-display` (eigener Ordner im Repository, nicht im Plugin) ist ein fertiges PlatformIO-Projekt für den ESP32 mit den gängigen SPI-Displays. Je Controller gibt es eine Umgebung: `waveshare35` (Standard), `ili9341`, `cyd` (ESP32-2432S028R), `ili9488`, `ili9486`, `st7796`, `st7789`. Gebaut und geflasht wird mit `pio run -e <Umgebung> -t upload`; Verdrahtung, Konfiguration, Drehung, optionaler Taster und Hintergrundlicht stehen in `firmware/esp32-display/README.md`. `include/config.example.h` nach `config.h` kopieren und WLAN, Broker-Zugang, Display-ID und Themenpräfix eintragen.

Die Firmware speichert das Layout im Flash (nach einem Neustart kommen nur noch Werte), kalibriert den Touch beim ersten Start und hat einen **Bildschirmschoner**: Nach `SAVER_AFTER_S` Sekunden (Standard 120) ohne Berührung zeigt der schwarze Bildschirm Uhrzeit und Datum, die über den Bildschirm wandern; eine Berührung weckt auf. Die Uhrzeit kommt per NTP, der ESP32 braucht dafür Internetzugang. Die Anzeige passt sich der Auflösung und Drehung an (Querformat mit 4 Spalten, Hochformat mit 3). Ist das Hintergrundlicht per PWM steuerbar (z. B. CYD), setzt die Firmware die Helligkeit und die Nachtabsenkung des Plugins um; bei fest verdrahtetem Licht (z. B. Waveshare) bleibt sie ohne Wirkung. Alle Umgebungen kompilieren, sind aber noch nicht auf echter Hardware getestet.

## KI-Zugriff (MCP)

*Einstellungen → Erweiterungen → „KI-Zugriff (MCP)“* einschalten: HomeLite wird zum MCP-Server (Streamable HTTP, Pfad `/mcp/<Token>` oder `/mcp` mit `Authorization: Bearer <Token>`). Claude kann dann Geräte, Räume, Energie, Heizung, Auto, Anwesenheit und das Protokoll abfragen und – wenn erlaubt – Geräte schalten und Szenen ausführen (Aufsperren von Schlössern nur mit zusätzlicher Freigabe). Eingebunden wird die auf der Einstellungsseite angezeigte Adresse:

* claude.ai: Einstellungen → Konnektoren → „Benutzerdefinierten Konnektor hinzufügen“
* Claude Code: `claude mcp add --transport http homelite https://dein-server/mcp/<Token>`

Der Server muss dafür per HTTPS aus dem Internet erreichbar sein (Tailscale Funnel, Cloudflare Tunnel o. ä.; nur den Pfad `/mcp` freigeben). Das Token wie ein Passwort behandeln; „Neues Token erzeugen“ macht die alte Adresse ungültig. Zusätzlich kann Claude **Automationen anlegen und ändern** (`create_automation`, `update_automation`, `get_automation` zum Lesen; Geräte per Name oder ID, Typen werden geprüft; abschaltbar mit „Automationen anlegen/ändern erlauben“). Löschen ist nicht möglich. Steuervorgänge und Automations-Änderungen der KI stehen mit 🤖 im Protokoll.

## System-Neustart

*Einstellungen → System*: „HomeLite neu starten“ (beendet den Prozess; systemd startet ihn mit `Restart=always` neu) und „Server neu starten“ (Reboot, nach Passwort-Abfrage). Der Reboot braucht Root-Rechte: Läuft HomeLite nicht als root, per `sudo visudo -f /etc/sudoers.d/homelite` eintragen:

```
<Dienst-Benutzer> ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
```

Nach dem Reboot lädt sich die Seite automatisch neu, sobald HomeLite wieder erreichbar ist (bis zu 10 Minuten Wartezeit).

## Shelly-Firmware-Updates

Auf der Seite *Geräte* (unten, sobald Shelly-Geräte mit IP existieren): „Auf Updates prüfen“ fragt jedes Shelly (Gen1 und Gen2/3) nach neuer Firmware. Mit „Update“ (oder „Alle aktualisieren“) wird das Update gestartet; HomeLite verfolgt den Neustart und zeigt dann **✓ Update erfolgreich** (alte → neue Version), **✕ fehlgeschlagen** (Version unverändert/Gerät nicht erreichbar nach 8 Minuten) oder **nicht erreichbar**. Geräte mit Passwort: Benutzer/Passwort am Gerät eintragen (nur Basic-Auth). Das Gerät braucht für den Download Internetzugang.

## Erweiterungen ein-/ausschalten

*Einstellungen → Erweiterungen*: Energie & Victron, Heizung, Ecowitt, Matter, Apple TV, Anwesenheit/Geofence und „Wo ist?“ lassen sich einzeln aktivieren. Ausgeschaltete Erweiterungen verschwinden aus Menü, Dashboard und Einstellungen und starten keine Hintergrundprozesse; Konfiguration und Geräte bleiben erhalten. Bei einem Update werden Erweiterungen, die du schon nutzt (konfiguriert), automatisch eingeschaltet; bei einer Neuinstallation sind alle aus.

## Taupunkt-Sensoren

Zu jedem Temperatur-/Feuchte-Paar desselben Geräts (Ecowitt, Zigbee2MQTT-Topic, Matter, Shelly-IP oder gleicher Namensstamm wie „Bad Temperatur“ / „Bad Feuchte“) legt HomeLite automatisch einen **eigenen Sensor „<Name> Taupunkt“** an (💧, Magnus-Formel, gleicher Raum wie der Temperatursensor). Er lässt sich wie jeder Sensor in Dashboard, Automationen und per MCP nutzen. Paare, für die es schon einen Taupunkt-Sensor gibt (z. B. Außen bei der Ecowitt-Station), werden übersprungen. Einen automatisch angelegten Sensor kannst du löschen – er wird dann nicht neu erzeugt. Abschalten: *Einstellungen → Erweiterungen → Taupunkt-Sensoren* (entfernt alle berechneten Sensoren).

## Apple TV (Status)

*Einstellungen → Apple TV (Status)*: Liest über `pyatv` den Zustand deines Apple TV – an/Standby, laufende App, Titel, Wiedergabestatus – und legt daraus Geräte an (Binär-/Sensor-Geräte, in Automationen als Auslöser/Bedingung nutzbar, z. B. „Apple TV startet Wiedergabe → Licht dimmen“). Nur Status, keine Fernbedienung.

```bash
/opt/homelite/.venv/bin/pip install pyatv "srptools<2"
```

Ablauf: „Apple TV suchen“ → *Companion* koppeln (PIN vom Fernseher; liefert Standby und App) → *AirPlay* koppeln (PIN; liefert Titel/Wiedergabe) → „Sensoren anlegen“. Der Server muss im gleichen Netz wie das Apple TV sein (mDNS).

## „Wo ist?“ (Karte, iCloud, Handy-Seite)

Seite **Karte**: alle Personen mit Position, Zonen als Kreise und dem Verlauf der letzten Tage (OpenStreetMap-Karte, der Browser braucht Internet für die Kacheln). Positionen speisen die Geofence-Logik: Zone betreten/verlassen löst die Automationen aus.

* **iCloud „Wo ist?“** – HomeLite fragt Standorte der iPhones/Familie bei Apple ab (inoffiziell, Paket `pyicloud`):
  ```bash
  /opt/homelite/.venv/bin/pip install pyicloud
  ```
  Anmeldung mit Apple-ID + Passwort + 2-Faktor-Code (einmalig; die Sitzung hält ca. 2 Monate, danach erneut anmelden). Geräte den Personen zuordnen, Abfrageintervall ab 30 s. Die Cookies liegen in `data/icloud`. Empfehlung: eigenes Apple-ID-Konto in der Familienfreigabe dafür verwenden.
* **Handy-Seite** `/where.html` – als Web-App aufs Home-Bildschirm legen; sendet die Position, solange sie offen ist (iOS erlaubt Webseiten keinen Hintergrund-Standort; für HTTPS siehe Tailscale Serve/Funnel). Der Link mit Schlüssel steht auf der Karten-Seite (mit QR-Code).
* OwnTracks/Kurzbefehle/Geofency über `/hook` funktionieren weiter und liefern ebenfalls Genauigkeit und Akku.

## Geofence mit dem iPhone (kostenlos)

Unter *Geofence → Zone* die Heimposition samt Radius eintragen und eine Person anlegen. Die Seite zeigt fertige URLs mit deinem geheimen Schlüssel:

- **Kurzbefehle-App** (schon auf dem iPhone): Automation „Ankunft“/„Verlassen“ → *Inhalte von URL abrufen*, `event=enter` bzw. `event=leave`; „Vor Ausführen fragen“ aus.
- **OwnTracks** (kostenlos): Modus *HTTP*, URL eintragen; Regionen wie die Zonen benennen oder Standort-Pings senden – der Server berechnet Zonen selbst.
- **Geofency**: Webhook (POST/JSON) mit der URL, Ortsnamen = Zonennamen.

Von unterwegs muss `/hook` aus dem Internet erreichbar sein (Tailscale Funnel, Cloudflare Tunnel oder Reverse-Proxy mit HTTPS). Den Rest der App besser nur im LAN/Tailnet lassen. Der Hook ist nur mit dem Schlüssel nutzbar (*Neu erzeugen* möglich).

## Sicherheit

Login per Passwort (scrypt), signiertes HttpOnly-Cookie, Login-Sperre nach Fehlversuchen, JSON-only-API gegen CSRF, strenge CSP. Zugangsdaten liegen unverschlüsselt in `data/config.json` (Rechte 600) – Server entsprechend absichern.

## Struktur

```
server.js          HTTP-API, SSE, Geofence-Hook
lib/devices.js     MQTT, Shelly, HTTP, virtuell; Discovery, Steuerung
lib/engine.js      Automationen (Trigger, Modi, Wenn/Dann)
lib/sun.js         Sonnenauf-/untergang
lib/importer.js    HA-Übernahme (import/ha-migration.json)
lib/heating.js     Heizlogik
lib/presence.js    Personen, Zonen, Events
lib/updater.js     Software-Update per Klick
plugins-example/leapmotor  Leapmotor-Plugin (index.js, leap_bridge.py, leapmotor/ = Client), lib/migrate_leapmotor.js = einmalige Übernahme
plugins-example/tuya  Tuya-Plugin (index.js, tuya_bridge.py, tuya/ = SDK), lib/migrate_tuya.js = einmalige Übernahme
public/            Weboberfläche (ohne Build-Schritt)
```

## Verlauf (Schalter-Historie)

Seite **Verlauf**: zeigt, wann und wie Schalter, Lichter, Rollos/Markisen, Schlösser und Taster betätigt wurden – nach Tagen gegliedert, live aktualisiert, filterbar nach Quelle, Gerät und Suchtext. Die Quelle wird dazugeschrieben:

- 👆 **App** (HomeLite-Oberfläche, mit Gerätehinweis wie „iPhone“)
- ⚙️ **Automation / Szene** (mit Namen und Auslöser)
- 🤖 **KI (Claude)** über MCP
- 🌡 **Heizung**
- 🔘 **Am Gerät / extern**: Zustand hat sich geändert, ohne dass HomeLite etwas gesendet hat (Wandschalter, Taster, Hersteller-App, Fernbedienung)

Gespeichert werden bis zu 5000 Einträge der letzten 120 Tage in der Datenbank (Backup enthalten). Dimm-Vorgänge werden zusammengefasst. Die erste Meldung eines Geräts nach dem Start zählt nicht als Betätigung. API: `GET /api/history?dev=&k=&q=&before=&limit=`, `DELETE /api/history`.

## Shelly CoIoT (Sofort-Meldungen, Gen1)

Shelly Gen1 melden Zustandsänderungen per CoIoT (CoAP über UDP) an einen „CoIoT-Peer“. HomeLite lauscht dafür auf **UDP 5683** und fragt das betroffene Gerät bei jeder geänderten Meldung sofort ab (Reaktionszeit unter einer Sekunde, auch bei Wandschalter oder Tasterbetätigung; in den Verlauf kommt das als „Am Gerät / extern“). Solange ein Gerät per CoIoT gehört wird, genügt eine Sicherheitsabfrage pro Minute statt alle 10 Sekunden.

Einrichtung: Seite **Geräte** → Abschnitt „Shelly CoIoT“ → **Einrichten** (oder „Alle einrichten“). HomeLite trägt `coiot_enable=true` und `coiot_peer=<HomeLite-IP>:5683` im Shelly ein (die passende eigene IP wird je Gerät automatisch ermittelt, manuell überschreibbar) und startet das Gerät neu. Gen2/Gen3 brauchen das nicht. Hinweise: Der UDP-Port 5683 muss auf dem HomeLite-Rechner frei sein (läuft dort noch Home Assistant, ist er belegt) und darf nicht von einer Firewall blockiert werden. Ein/Aus unter Einstellung `coiot` (Standard: ein), Port und Adresse änderbar.

## Bedingungen: „Ausgelöst durch“, ODER, UND

Neue Bedingungen für Automationen: **Ausgelöst durch** (prüft die optionale *Kennung* eines Geräte-Auslösers, z. B. „fernbedienung“), **ODER** (mindestens eine der enthaltenen Bedingungen) und **UND**. Damit lassen sich Home-Assistant-Automationen mit mehreren Auslösern und gemischten Bedingungen 1:1 abbilden. Beispiel: *Fernsehlicht aus* – Taste „Aus“ oder über 500 lx schalten immer aus, sonst nur wenn keine Präsenz **und** Apple TV aus.

Der Import („Aus Home Assistant übernehmen“) löst Geräte jetzt auch über ihren exakten Namen auf und kann ältere, feiner aufgeteilte Automationen ersetzen (Feld `replaces`). Die zwei Automationen **Fernsehlicht ein** und **Fernsehlicht aus** (inkl. „AppleTv WZ Status“) kommen deaktiviert an.

## Plugins
Erweiterungen lassen sich ohne Systemupdate als Plugin installieren (Einstellungen → Erweiterungen → Plugins, Datei oder URL). Plugins liegen in `data/plugins` und überstehen Updates. Details und API: [PLUGINS.md](PLUGINS.md). Beispiele: `plugins-example/erreichbarkeit`, `plugins-example/duckdns` (DuckDNS-Client), `plugins-example/claude` (Claude-Assistent im Chat), `plugins-example/flows` (visueller Flow-Editor im Stil von Node-RED/n8n), `plugins-example/systemmonitor` (CPU/RAM/Temperatur des Servers), `plugins-example/ssh` (SSH für den KI-Zugriff), `plugins-example/philips-hue` (Hue-Bridge), `plugins-example/muellkalender` (Müllkalender, CITIES-App).
