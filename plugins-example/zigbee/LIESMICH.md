# Zigbee direkt (Plugin, ZHA-Kern – ohne Zigbee2MQTT)

Eigenständige Zigbee-Anbindung: HomeLite steuert den Funk-Dongle **selbst**, es wird weder Zigbee2MQTT noch Home Assistant noch ein MQTT-Broker gebraucht. Technisch läuft im Hintergrund der **ZHA-Kern** (die Python-Bibliotheken `zha`, `zigpy`, `bellows` und `zha-quirks` – dieselbe Software, die auch Home Assistants „Zigbee Home Automation“ benutzt) als Brücke; HomeLite legt die erkannten Entitäten als eigene Geräte an.

> **Status: nicht mit echter Hardware getestet.** Geprüft wurde nur ohne Dongle: Installation der Pakete, Start der Brücke bis zum Funkchip, Geräte-Zuordnung, Steuerung, Taster, Backup-Dateien und die Seite mit simulierten Daten. Ob die Verbindung zum Sonoff Dongle Max, das Anlernen echter Geräte, Kanalwechsel und Restore funktionieren, ist offen. Bitte mit dem Protokoll (Seite „Zigbee direkt“, ganz unten) zurückmelden, was nicht klappt.

## Wichtig vorab
- **Der Dongle kann nur von einem Programm gehalten werden.** Zigbee2MQTT (und das Plugin „Zigbee (Zigbee2MQTT)“), Home Assistant/ZHA, deCONZ usw. müssen beendet sein, sonst kommt kein Verbindungsaufbau zustande. Beim Dongle Max erlaubt Port 6638 genau eine Verbindung.
- **Bestehendes Netz übernehmen:** Das Plugin legt ein **neues** Zigbee-Netz an, wenn auf dem Dongle keines ist. Die Geräte aus Zigbee2MQTT sind damit nicht automatisch dabei: entweder neu anlernen oder vorher das Netz übernehmen (Backup aus Zigbee2MQTT bzw. „Open Coordinator Backup“-JSON hochladen und „Restore“, siehe unten – nicht getestet).
- Das Plugin braucht **Python 3.12 oder neuer** auf dem Server und für die Installation Internetzugang zu pypi.org (ca. 100 MB).

## Einrichten
1. Plugin installieren und aktivieren, in den Einstellungen **Anschluss** wählen:
   - **Netzwerk** (Dongle Max per LAN/PoE/WLAN): IP-Adresse des Dongles, Port 6638. Der Dongle muss in seiner Weboberfläche im Modus **„Zigbee Coordinator“** (TCP) laufen. Funkchip `EZSP`, Baudrate `115200`, Flusskontrolle `keine`.
   - **USB**: Gerätepfad, am besten `/dev/serial/by-id/…`. Der Benutzer, unter dem HomeLite läuft, braucht Zugriff (Gruppe `dialout`). Dongle Max und ZBDongle-E: `EZSP` (oft 115200, ältere Firmware 460800), ZBDongle-P: `Z-Stack/znp`.
2. Seite **Zigbee direkt** öffnen → **⬇ Installieren** (legt im Plugin-Ordner eine eigene Python-Umgebung an; dauert einige Minuten; ändert nichts am System).
3. Nach der Installation verbindet sich das Plugin automatisch. Anzeige „verbunden“ mit Kanal, PAN-ID, Firmware und Koordinator-Adresse. Bei einem Fehler steht die Meldung dort und es wird alle 30 s neu versucht.
4. **Gerät anlernen**: „120 s öffnen“, dann am Gerät den Pairing-Modus starten (meist Reset-Taste ~5 s oder 5× ein-/ausschalten). Das Gerät erscheint mit Hersteller, Modell, Treiber (Quirk) und seinen Entitäten, passende HomeLite-Geräte werden automatisch angelegt.

## Sonoff Dongle Max (Dongle-M)
- Hat USB, Ethernet (PoE) und WLAN und kann auch Thread. Für dieses Plugin: Modus **Zigbee Coordinator**.
- Adresse als **IP** eintragen. Namen wie `dongle-m.local` löst das Plugin zwar auf, in manchen Umgebungen klappt das aber nicht. **✔ Port testen** prüft, ob Port 6638 antwortet.
- Es steht in den Einstellungen `EZSP` – der Dongle Max (EFR32MG24) wird über das EmberZNet-Protokoll angesprochen, das die Bibliothek `bellows` kann. Ob die mitgelieferte Dongle-Firmware dazu passt, ist ungeprüft; falls die Verbindung mit „Zeitüberschreitung“ scheitert, in der Weboberfläche des Dongles die Firmware/den Modus prüfen oder Baudrate testen (115200 ↔ 460800).

## Welche Geräte werden unterstützt?
„Alle auf dem Markt erhältlichen Zigbee-Geräte“ kann **kein** Programm garantieren – aber die Abdeckung ist sehr breit:
- Jedes Gerät nach Zigbee-Standard (ZCL/Zigbee 3.0 und Zigbee Home Automation) wird über die **Standard-Cluster** erkannt: Lampen (an/aus, Helligkeit, Farbtemperatur, Farbe), Schalter/Steckdosen, Rollos, Schlösser, Thermostate, Temperatur-/Feuchte-/Helligkeits-/Druck-Sensoren, Bewegung/Präsenz, Tür-/Fenster-/Wasser-/Rauchmelder, Leistungsmessung, Fernbedienungen/Taster u. a.
- Für Geräte mit Herstellerbesonderheiten (viele IKEA-, Philips-, Aqara/Xiaomi-, Tuya-, Sonoff-, Legrand-, Bosch-, Danfoss-, Schneider-Geräte …) liefert **zha-quirks** Treiber, die das Gerät in Standard-Entitäten übersetzen. Das sind mehrere Tausend Geräte; welcher Treiber greift, zeigt die Gerätekarte („Treiber (Quirk)“).
- Neue oder exotische Geräte ohne Treiber erscheinen, soweit sie Standard-Cluster sprechen, trotzdem mit den passenden Entitäten; sonst bleibt das Gerät ohne Entitäten. In dem Fall hilft das Aktualisieren der Software (Installieren-Knopf aktualisiert alle Pakete) oder ein eigener Treiber im Ordner `quirks` im Plugin-Datenordner (ZHA-Custom-Quirk). Hersteller/Modell bitte an die zha-quirks-Entwickler melden.
- Nicht abgebildet als HomeLite-Gerät, aber auf der Seite bedienbar: Konfigurations-Entitäten (number/select/button/switch mit Kategorie „config“), z. B. Fensterkontakt-Empfindlichkeit, Dimm-Verhalten.
- Weitere Funkchips über die Einstellung „Funkchip“: Z-Stack (ZBDongle-P u. ä.), ConBee/RaspBee, XBee, ZiGate – ungetestet.

### Zuordnung
| ZHA-Entität | HomeLite-Gerät |
|---|---|
| light | Licht (an/aus, Helligkeit in %; Farbe und Weißton, wenn die Lampe es kann) |
| switch, siren, fan, valve | Schalter |
| cover | Rollo (öffnen/schließen/stopp/Position) |
| lock | Schloss |
| climate | Thermostat (Ist-/Solltemperatur) |
| sensor | Sensor (Batterie, LQI und Diagnose nur, wenn in den Einstellungen aktiviert) |
| binary_sensor | Binärsensor (Bewegung, Kontakt …) |
| event, Fernbedienungs-Befehle | Ereignis-Gerät „Taster“ (z. B. `remote_button_short_press`) für Automationen |

Kontakt-Sensoren („Tür/Fenster“) sind **an = offen** (wie in ZHA).

## Bestehende Geräte von Zigbee2MQTT übernehmen
Geräte, die vorher über Zigbee2MQTT liefen (z. B. Couchlicht), sind in HomeLite noch mit dem Zigbee2MQTT-Plugin verknüpft. Sobald sich das Gerät im neuen Netz meldet, erscheint es hier als neues Gerät. In der aufgeklappten Gerätekarte steht bei der Entität (z. B. „light“) der Knopf **⇄ Altes Gerät zuordnen**: das alte HomeLite-Gerät auswählen (nur gleicher Typ wird angeboten). Es behält ID, Name, Raum und alle Automationen und steuert ab dann den neuen Zigbee-Eintrag; ein schon angelegtes neues Gerät dafür wird entfernt. Braucht HomeLite ab 1.29.9. Das Zigbee2MQTT-Plugin muss deaktiviert bleiben, sonst legt es seine Geräte wieder neu an. Nicht an echten Geräten geprüft.

## Farben bei Lichtern
Kann die Lampe Farbe (xy) und/oder Weißton, zeigt die Kachel in HomeLite Farbfelder, einen Farbwähler, Weißtöne (Kerze bis Kaltweiß) und einen Kelvin-Regler. Der Weißton wird auf den Bereich der Lampe begrenzt. Für Automationen gibt es die Aktionen „Farbe (Licht, #rrggbb)“ und „Weißton (Licht, Kelvin)“. Braucht HomeLite 1.30.0. Nicht an einer echten Lampe geprüft; die tatsächlich gezeigte Farbe hängt vom Farbumfang der Lampe ab.

## Funkkanal ändern
Auf der Seite beim Dongle: Kanal wählen, „Wechseln“. Es wird vorher ein Backup erstellt; dann sendet der Koordinator die Kanalumschaltung an alle Geräte. Netzbetriebene Geräte folgen sofort, batteriebetriebene Geräte brauchen manchmal Minuten bis Stunden – einzelne müssen eventuell neu angelernt werden. „📶 Kanäle prüfen“ zeigt die Funk-Auslastung je Kanal (nur bei Dongles, die einen Energie-Scan können). Der Wechsel gilt auch nach Neustart (die Einstellung „Funkkanal“ wirkt nur beim Neuanlegen eines Netzes).

## Backup und Restore
- **Backup**: Knopf oder täglich automatisch. Gespeichert wird im Standardformat „Open Coordinator Backup“ (JSON) im Plugin-Datenordner (`backups`, Dateirechte 600). Es enthält den Netzwerkschlüssel – geheim halten, nicht in Chats/öffentlich teilen.
- **Restore**: schreibt Netzwerkschlüssel, Kanal, PAN-ID und Koordinator-Adresse auf den angeschlossenen Dongle (z. B. neuer Dongle nach Defekt, oder Dongle zurückgesetzt) und startet die Verbindung neu; die Geräte finden das Netz wieder und müssen nicht neu angelernt werden. Vorher wird der aktuelle Stand als „vor Restore“ gesichert. Auch Backups, die aus Zigbee2MQTT/ZHA im selben Format stammen, lassen sich hochladen. **Nicht an echter Hardware ausprobiert.**
- **Zigbee2MQTT-Backup übernehmen:** Im Block Backup „⬆ Zigbee2MQTT-Backup (.zip) einlesen“ die ZIP aus Zigbee2MQTT wählen (Backup-Knopf der Zigbee2MQTT-Oberfläche; es genügt auch eine ZIP mit `coordinator_backup.json`, optional `configuration.yaml`, maximal ca. 600 kB). Das Plugin liest `coordinator_backup.json` (Netzwerkschlüssel, Kanal, PAN-ID), legt es als Backup „aus Zigbee2MQTT“ ab und übernimmt die Gerätenamen. Danach „Restore“ (wird direkt angeboten). Die Geräte kennen den Netzwerkschlüssel und melden sich wieder; die Geräteliste selbst wird nicht übernommen, Batteriegeräte erscheinen erst, wenn sie wach sind (Taste drücken). Zigbee2MQTT muss beendet sein. Nicht an echter Hardware geprüft.
- **Datenbank zurücksetzen** („♻“ beim Dongle): wenn der Dongle auf Werkseinstellungen zurückgesetzt oder getauscht wurde und das Plugin deshalb einen Netz-Konflikt meldet. Die alte Datenbank wird als `zigbee.db.bak-…` beiseitegelegt, danach verbindet das Plugin neu (bei einem zurückgesetzten Dongle entsteht ein neues Netz) und ein Backup kann eingespielt werden. HomeLite-Geräte bleiben erhalten (gleiche Adresse = gleiches Gerät).
- Die Geräteliste (zigpy-Datenbank `zigbee.db`) liegt im Plugin-Datenordner; sie gehört bei einer Datensicherung des Servers dazu.

## MCP/Assistent
`zha_geraete` (Liste) und `zha_anlernen` (Anlernmodus für N Sekunden).

## Grenzen
- Kein Gerät wird „automatisch erfunden“: ohne Standard-Cluster oder Treiber keine Entitäten.
- Gruppen, Szenen, Bindings (Taster direkt mit Lampe koppeln) und OTA-Firmware-Updates der Geräte werden nicht über die Seite bedient (OTA läuft, wenn aktiviert, im Hintergrund über zigpy).
- Beim ersten Start nach der Installation kann das Auslesen aller Geräte einige Minuten dauern; batteriebetriebene Geräte melden sich erst, wenn sie wach sind (Taste drücken).
