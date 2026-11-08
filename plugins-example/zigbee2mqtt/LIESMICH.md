# Zigbee (Plugin, über Zigbee2MQTT)

Bindet Zigbee-Geräte über **[Zigbee2MQTT](https://www.zigbee2mqtt.io)** in HomeLite ein. Zigbee2MQTT betreibt den USB-Dongle und kennt mehr als 3000 Geräte; HomeLite verbindet sich über seinen eingebauten MQTT-Broker, legt jedes Gerät automatisch an und steuert es. Das Plugin braucht keine Zusatzpakete.

> Getestet gegen einen Nachbau von Zigbee2MQTT (Geräteliste, Zustände, Anlernen, Umbenennen, Entfernen). Mit echtem Dongle noch nicht ausprobiert – Rückmeldungen bitte mit dem Protokoll auf der Seite „Zigbee“.

## Unterstützte Dongles
| Dongle | Zigbee2MQTT-Adapter |
|---|---|
| **Sonoff ZBDongle-E** (EFR32MG21), Sonoff Dongle Max, SkyConnect / ZBT-1 | `ember` |
| **Sonoff ZBDongle-P** (CC2652P), andere TI-CC26xx/CC13xx | `zstack` |
| **ConBee II / ConBee III / RaspBee** (dresden elektronik) | `deconz` |
| nRF52840-Dongles | `zboss` |
| ältere EFR32-Dongles | `ezsp` |

Der Assistent auf der Seite „Zigbee“ erkennt am Server angeschlossene Dongles anhand ihres Namens unter `/dev/serial/by-id/` und schlägt den Adapter vor. Bitte die Auswahl prüfen: der Sonoff ZBDongle-E meldet sich als „ITEAD … Dongle_Plus_V2“, der ZBDongle-P als „Silicon_Labs_CP2102N …“.

## Einrichtung
1. **MQTT-Benutzer anlegen:** *Einstellungen → Eingebauter MQTT-Broker* → Benutzer hinzufügen (z. B. `zigbee`).
2. **Seite „Zigbee“ → 🔧 Einrichtung → Öffnen:** Dongle-Typ und Anschluss wählen, Server-IP und MQTT-Zugang eintragen, **Konfiguration erzeugen**. Das Passwort wird nicht gespeichert.
3. Auf dem Server einen Ordner anlegen (z. B. `~/zigbee2mqtt`), `docker-compose.yml` dort und `configuration.yaml` im Unterordner `data/` speichern, dann:
   ```bash
   docker compose up -d
   ```
   Nach etwa 30 Sekunden zeigt die Seite „Zigbee2MQTT online“. Die Zigbee2MQTT-Oberfläche ist auf Port 8080 erreichbar (Adresse in den Plugin-Einstellungen eintragen, dann erscheint ein Link).
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
