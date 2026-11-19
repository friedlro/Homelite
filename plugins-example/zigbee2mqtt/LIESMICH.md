# Zigbee (Plugin, über Zigbee2MQTT)

Bindet Zigbee-Geräte über **[Zigbee2MQTT](https://www.zigbee2mqtt.io)** in HomeLite ein. Zigbee2MQTT betreibt den USB-Dongle und kennt mehr als 3000 Geräte; HomeLite verbindet sich über seinen eingebauten MQTT-Broker, legt jedes Gerät automatisch an und steuert es. Das Plugin braucht keine Zusatzpakete.

> Getestet gegen einen Nachbau von Zigbee2MQTT (Geräteliste, Zustände, Anlernen, Umbenennen, Entfernen). Mit echtem Dongle noch nicht ausprobiert – Rückmeldungen bitte mit dem Protokoll auf der Seite „Zigbee“.

## Unterstützte Dongles
| Dongle | Zigbee2MQTT-Adapter |
|---|---|
| **Sonoff Dongle Max** (Dongle-M, EFR32MG24; USB, LAN/PoE oder WLAN) | `ember` (Netzwerk: `tcp://<Adresse>:6638`) |
| **Sonoff ZBDongle-E** (EFR32MG21), SkyConnect / ZBT-1 | `ember` |
| **Sonoff ZBDongle-P** (CC2652P), andere TI-CC26xx/CC13xx | `zstack` |
| **ConBee II / ConBee III / RaspBee** (dresden elektronik) | `deconz` |
| nRF52840-Dongles | `zboss` |
| ältere EFR32-Dongles | `ezsp` |

Der Assistent auf der Seite „Zigbee“ erkennt am Server angeschlossene Dongles anhand ihres Namens unter `/dev/serial/by-id/` und schlägt den Adapter vor. Bitte die Auswahl prüfen: der Sonoff ZBDongle-E meldet sich als „ITEAD … Dongle_Plus_V2“, der ZBDongle-P als „Silicon_Labs_CP2102N …“.

### Sonoff Dongle Max (Dongle-M)
- Er hat USB, Ethernet (PoE) und WLAN und kann auch Thread. Für Zigbee muss in seiner Weboberfläche der Betriebsmodus **„Zigbee Coordinator“** eingestellt sein (nicht Thread/RCP).
- **USB:** Im Assistenten „Sonoff Dongle Max“ und „USB“ wählen; Anschluss wie bei den anderen Dongles.
- **Netzwerk:** „Netzwerk“ wählen und die Adresse des Dongles eintragen (z. B. `192.168.50.60` oder `dongle-m.local`). Mit **🔎 Im Netzwerk suchen** findet der Assistent Geräte mit offenem Port 6638 im eigenen Subnetz (die Adresse lässt sich per Klick übernehmen). Der Assistent erzeugt `port: tcp://<Adresse>:6638` samt `baudrate: 115200` und `rtscts: false` (wie vom Dongle vorgegeben); Namen wie `dongle-m.local` löst er in eine IP auf, weil Zigbee2MQTT im Docker-Container mDNS-Namen oft nicht findet. **✔ Verbindung testen** prüft, ob Port 6638 antwortet. und lässt in der `docker-compose.yml` die USB-Freigabe weg. Der Dongle erlaubt nur **eine** Verbindung auf Port 6638 – ZHA oder Home Assistant dürfen nicht gleichzeitig verbunden sein; antwortet der Port nicht mehr, den Dongle über seine Weboberfläche neu starten.
- Bei „Waiting for RSTACK“ im Zigbee2MQTT-Protokoll hilft meist: Dongle kurz auf Thread/RCP und wieder auf Zigbee Coordinator stellen, dann Zigbee2MQTT neu starten.
- Nicht mit einem echten Dongle Max ausprobiert; Quelle der Angaben: Sonoff-Anleitung und Nutzerberichte.

## Backup und Restore
Der Block **💾 Backup & Restore** erstellt ein Backup von Zigbee2MQTT (ZIP mit Geräteliste, Konfiguration, Zustand und den Netzwerkdaten des Koordinators) und legt es im Plugin-Ordner von HomeLite ab. Zusätzlich läuft täglich automatisch eines, solange Zigbee2MQTT online ist (abschaltbar, Anzahl der behaltenen Backups einstellbar). Backups lassen sich herunterladen, löschen und – bis ca. 700 kB – hochladen.
**Restore:** Zigbee2MQTT hat keine Schnittstelle zum Einspielen und überschreibt seine Dateien beim Beenden. Der Knopf „Restore“ liefert deshalb ein Skript (`restore-zigbee2mqtt.sh`) für den Rechner, auf dem Zigbee2MQTT läuft: Es hält den Container an, sichert den aktuellen Stand in einen Ordner `…vor-restore-…`, entpackt das Backup und startet neu. Daten-Ordner und Container-Name stehen in den Plugin-Einstellungen. Bei einem neuen Dongle baut Zigbee2MQTT das Netz aus `coordinator_backup.json` wieder auf. Nicht an einer echten Installation ausprobiert; ein Backup ist nicht möglich, wenn der Adapter es nicht unterstützt.

## Funkkanal ändern
Der Block **📶 Funkkanal** zeigt den aktuellen Kanal und lässt einen neuen wählen (11–26; 15, 20 und 25 sind empfohlen). **Kanal ändern & neu starten** speichert den Kanal in Zigbee2MQTT, startet es neu und prüft danach, ob das Netz wirklich auf dem neuen Kanal läuft; das Ergebnis (✅ / ⚠) steht im Block, darunter die Kanal-Meldungen aus dem Zigbee2MQTT-Protokoll. Zigbee2MQTT stellt den Kanal beim Start um (nur Adapter „ember“ und „zstack“) und schickt einen Wechselbefehl an die Geräte. Batteriegeräte folgen erst, wenn sie aufwachen (kurz auslösen); manche folgen nie und müssen neu angelernt werden – vorher ein Backup anlegen. Nicht an einem echten Zigbee-Netz ausprobiert.

## Dongle-Status
Auf der Seite zeigt der Block **📡 Funk-Dongle**, ob der Dongle verbunden ist: „verbunden“ heißt, Zigbee2MQTT ist online und meldet den Koordinator (Typ, Firmware, IEEE-Adresse). Sonst steht dort „nicht verbunden“ mit der letzten Fehlermeldung aus dem Zigbee2MQTT-Protokoll. Trägst du bei einem Netzwerk-Dongle die Adresse ein (wird bei der Einrichtung übernommen, sonst unter „Adresse speichern & prüfen“), prüft HomeLite zusätzlich alle 30 Sekunden, ob Port 6638 antwortet – solange Zigbee2MQTT nicht online ist.

## Einrichtung
Zigbee2MQTT wird außerhalb von HomeLite betrieben (z. B. Docker) und mit dem MQTT-Broker von HomeLite verbunden; einen Konfigurationsgenerator gibt es nicht mehr.
1. **MQTT-Benutzer anlegen:** *Einstellungen → Eingebauter MQTT-Broker* → Benutzer hinzufügen (z. B. `zigbee`).
2. In der `configuration.yaml` von Zigbee2MQTT den MQTT-Server (`mqtt://<Server-IP>:1883`, Benutzer/Passwort) und den Dongle eintragen, z. B. für den Sonoff Dongle Max im Netzwerk:
   ```yaml
   serial:
     port: tcp://192.168.50.60:6638
     adapter: ember
     baudrate: 115200
     rtscts: false
   ```
   (Namen wie `dongle-m.local` finden Docker-Container oft nicht – besser die IP-Adresse verwenden.) Dann Zigbee2MQTT starten; nach etwa 30 Sekunden zeigt die Seite „Zigbee2MQTT online“. Die Oberfläche von Zigbee2MQTT liegt meist auf Port 8080 (Adresse in den Plugin-Einstellungen eintragen, dann erscheint ein Link).
3. Beim Netzwerk-Dongle die Adresse im Block **📡 Funk-Dongle** eintragen („Adresse speichern & prüfen“); mit „Im Netzwerk suchen“ lässt sie sich finden.
4. **➕ Anlernen** drücken und am Gerät die Anlerntaste betätigen bzw. es zurücksetzen. Fertig eingelesene Geräte erscheinen automatisch in HomeLite (Benachrichtigung „Neues Gerät eingelesen“).

**ConBee II:** Der Dienst `deconz` / Phoscon darf nicht gleichzeitig laufen (`sudo systemctl disable --now deconz`). Die Firmware sollte aktuell sein (GCFFlasher).
**Ohne Docker:** Zigbee2MQTT nach der [offiziellen Anleitung](https://www.zigbee2mqtt.io/guide/installation/01_linux.html) installieren und die erzeugte `configuration.yaml` verwenden.
**Läuft Zigbee2MQTT bereits?** Dann nur dessen MQTT-Server auf den HomeLite-Broker umstellen und das Base-Topic in den Plugin-Einstellungen angleichen.

## Bedienung (Seite „Zigbee“)
- Status von Zigbee2MQTT, Version und Dongle-Typ; **Anlernen** (254 s oder 60 s) mit Countdown.
- Geräteliste mit Modell, Batterie, Verbindungsqualität (LQI), letztem Kontakt; **✎ Umbenennen**, **🗑 Entfernen**, **↻ neu einlesen** bei fehlgeschlagenem Einlesen.
- Ereignisse (Beitritt, Einlesen, Austritt) und das Zigbee2MQTT-Protokoll.
- Namen und Räume, die du in HomeLite änderst, bleiben erhalten; beim Umbenennen in Zigbee2MQTT behalten die HomeLite-Geräte ihre Verknüpfung (feste Zuordnung über die IEEE-Adresse).

## Zuordnung
| Zigbee2MQTT | HomeLite-Gerät |
|---|---|
| Licht (an/aus, Helligkeit) | Licht bzw. Schalter |
| Schalter / Steckdose | Schalter |
| Thermostat (Solltemperatur, Ist) | Thermostat |
| Schloss | Schloss |
| Zahlenwerte (Temperatur, Feuchte, Helligkeit, Leistung, Energie, Batterie …) | Sensor mit Einheit |
| Bewegung, Präsenz, Wasser, Rauch, Vibration, Sabotage, Gas, CO, Kontakt | Binärsensor (bei „Kontakt“ bedeutet *an* = geöffnet) |
| `action` (Taster, Drehregler) | Ereignis-Gerät (Wert z. B. `single`, `on`, `brightness_move_up`) |

Nicht enthalten: Rollläden/Vorhänge, Farblichter (nur Ein/Aus und Helligkeit), Gruppen und Szenen von Zigbee2MQTT.

## Hinweise
- **Doppelte Geräte vermeiden:** HomeLite kann Zigbee2MQTT-Geräte auch ohne Plugin unter *Geräte → hinzufügen → Entdeckt* übernehmen. Beides gleichzeitig führt zu doppelten Geräten – bitte eines von beiden nutzen.
- Die Verbindungsqualität als Sensor ist standardmäßig aus (Plugin-Einstellungen), die Batterie an.
- KI-Zugriff: Werkzeuge `zigbee_geraete` (Liste) und `zigbee_anlernen` (Anlernmodus).
- Funkkanal: Standard 11; bei WLAN auf Kanal 1 stört 11 am wenigsten. Den Kanal nachträglich zu ändern erfordert, alle Geräte neu anzulernen.
