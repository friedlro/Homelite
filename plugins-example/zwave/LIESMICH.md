# Z-Wave (Plugin)

Bindet Z-Wave-Geräte über **zwave-js-server** in HomeLite ein. Den USB-Stick verwaltet [Z-Wave JS UI](https://github.com/zwave-js/zwave-js-ui) (oder der eigenständige `zwave-js-server`); HomeLite verbindet sich per WebSocket, legt jedes Gerät automatisch an und steuert es. Das Plugin braucht keine zusätzlichen Pakete (nutzt den WebSocket-Client von Node ≥ 22).

> Ungetestet an echter Hardware: entwickelt nach der Dokumentation von zwave-js-server und getestet gegen einen Nachbau des Servers. Rückmeldungen bitte mit dem Protokoll des Plugins.

## Voraussetzungen
1. Z-Wave-USB-Stick (z. B. Aeotec Z-Stick, Zooz ZST39, Nabu Casa ZWA-2) am HomeLite-Server oder einem anderen Rechner im Netz.
2. **Z-Wave JS UI** installieren, z. B. mit Docker:
   ```bash
   docker run -d --name zwave-js-ui --restart unless-stopped \
     --device=/dev/serial/by-id/DEIN-STICK:/dev/zwave -p 8091:8091 -p 3000:3000 \
     -v zwave-config:/usr/src/app/store zwavejs/zwave-js-ui:latest
   ```
   Oberfläche auf Port 8091 öffnen → *Settings → Z-Wave*: Seriellen Port `/dev/zwave` wählen, Sicherheitsschlüssel (S0/S2) erzeugen und **sichern**. Unter *Settings → Home Assistant* den Schalter **„WS Server“** aktivieren (Port 3000), den MQTT-Teil nicht nötig.
3. In HomeLite: *Erweiterungen → Plugins → Z-Wave → ⚙ Einstellungen*: Adresse `ws://<Rechner>:3000` eintragen, Plugin einschalten.

## Bedienung (Seite „Z-Wave“)
- **➕ Gerät hinzufügen** (Anlernmodus 60 s) und **➖ Gerät entfernen**: danach am Gerät die Anlerntaste drücken (meist 3× schnell). Strategie: *Ohne Verschlüsselung* (einfach, Lampen/Sensoren), *Sicher S0* (z. B. Türschlösser) oder *Standard (S2)* – bei S2 verlangt der Stick eine PIN-Eingabe, die in Z-Wave JS UI erfolgt; für S2-Geräte darum besser dort anlernen, HomeLite übernimmt sie automatisch.
- Knotenliste mit Status, Batterie, letztem Kontakt; **Ping**, **↻ neu einlesen**, **Entfernen** für ausgefallene Knoten.
- Geräte erscheinen überall in HomeLite (Räume, Regeln, Verlauf, KI-Zugriff). Namen und Räume, die du in HomeLite änderst, bleiben erhalten; Name/Ort aus Z-Wave JS UI gelten für neue Geräte.

## Unterstützte Funktionen
| Z-Wave | HomeLite-Gerät |
|---|---|
| Multilevel-Schalter (CC 38) | Licht mit Helligkeit |
| Binärschalter (CC 37) | Schalter |
| Türschloss (CC 98) | Schloss (`lock`/`unlock`) |
| Thermostat-Sollwert Heizen (CC 67) | Thermostat (Soll setzen, Istwert aus „Lufttemperatur“) |
| Multilevel-Sensor (CC 49) | Sensor mit Einheit (Temperatur, Helligkeit, Feuchte …) |
| Zähler (CC 50) | Sensor (W, kWh, V, A) |
| Binärsensor (CC 48) und Meldungen (CC 113) | Binär: Bewegung, Tür/Fenster, Rauch, CO, Wasser, Sabotage |
| Batterie (CC 128) | Sensor in % (abschaltbar) |
| Zentrale Szene (CC 91) | Ereignis-Gerät „Taster“, Werte wie `1_pressed`, `1_held`, `1_double`, `2_released` (Taste_Aktion) |

Nicht enthalten: Jalousien/Rollläden, RGB-Farben, Alarm-Codes, Konfigurationsparameter (dafür Z-Wave JS UI). Geräte mit mehreren Kanälen erhalten die Kanalnummer im Namen.

## Fehlersuche
„Keine Verbindung“: WS-Server in Z-Wave JS UI aktiv? Port 3000 erreichbar (Firewall)? Batteriegeräte reagieren erst beim Aufwachen (Taste am Gerät drücken). „ausgefallen“ = Knoten antwortet nicht; Ping, ggf. Batterie prüfen.
