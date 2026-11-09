# Änderungen

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
