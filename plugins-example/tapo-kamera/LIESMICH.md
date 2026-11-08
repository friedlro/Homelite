# TP-Link Tapo Kameras (Plugin)

Bindet Tapo-Kameras (C100, C200, C210, C310, C320, C500, C510 …) **lokal** ein – ohne Cloud. Auch andere ONVIF-Kameras funktionieren, sofern sie ONVIF-Ereignisse (PullPoint) unterstützen.

> Getestet gegen einen Nachbau einer ONVIF-Kamera (Anmeldung, Ereignisse, Schwenken, Positionen) und mit Testbildern für die Bildfunktionen; an einer echten Tapo-Kamera noch nicht. Rückmeldungen bitte mit dem Protokoll von HomeLite.

## Einrichtung
1. **Kamerakonto anlegen:** Tapo-App → Kamera → Einstellungen (⚙) → Erweitert → **Kamerakonto** → Benutzername und Passwort festlegen. (Das ist nicht dein TP-Link-Konto.) Bei neuerer Firmware zusätzlich unter „Erweitert“ **ONVIF** aktivieren. Der Kamera am besten im Router eine feste IP-Adresse geben.
2. **ffmpeg installieren** (für Standbild und Live-Ansicht): `sudo apt install ffmpeg`. Ohne ffmpeg funktionieren Ereignisse und Schwenken trotzdem.
3. In HomeLite: Plugin einschalten → Seite **Kameras** → **➕ Kamera hinzufügen**: Name, IP-Adresse, Kamerakonto, **Verbindung testen**, **Speichern**.

## Funktionen
- **Geräte je Kamera** (für Regeln, Alarmzentrale, Verlauf): *Bewegung*, und sobald die Kamera es meldet *Person*, *Fahrzeug*, *Tier*, *Sabotage*, *Linie überschritten*, *Schreien*. Welche Erkennungen die Kamera meldet, stellst du in der Tapo-App ein (Erkennung & Alarm). Das Gerät „Bewegung“ ist immer da.
- **Standbild** (📷) und **Live-Ansicht** (▶, etwa 2 Bilder pro Sekunde) mit **Schwenken/Neigen** (▲◀▼▶, bei schwenkbaren Kameras) und **gespeicherten Positionen** (die in der Tapo-App angelegten „Lieblingsorte“).
- Bei Bewegung/Person wird automatisch ein Standbild aufgenommen (höchstens alle 20 s je Kamera) – so siehst du auf der Kachel, was ausgelöst hat. Abschaltbar in den Plugin-Einstellungen.
- Optional Benachrichtigung bei erkannter Person.
- KI-Zugriff: Werkzeuge `kameras` (Status, letzte Ereignisse) und `kamera_position` (Kamera auf eine Position schwenken).

## Hinweise
- **Arbeitsspeicher:** ffmpeg läuft nur während die Live-Ansicht offen ist (ca. 40–60 MB) und beendet sich ca. 12 s nach dem Schließen. Für wenig Last den **Zweitstream (SD)** wählen und die Live-Breite in den Plugin-Einstellungen verkleinern.
- Das Passwort des Kamerakontos wird in der HomeLite-Datenbank gespeichert und nie an die Oberfläche gesendet. Die Kamera sollte nicht aus dem Internet erreichbar sein.
- **Sonderfälle:** Kameras mit anderem Stream-Pfad: unter „RTSP-Adresse“ die vollständige Adresse eintragen (`rtsp://Benutzer:Passwort@IP:554/Pfad`). Tapo-Standard: `/stream1` (HD) und `/stream2` (SD) auf Port 554.
- Die Kamera-Uhr kann abweichen; das Plugin gleicht den Zeitunterschied bei der Anmeldung automatisch aus.
- Nicht enthalten: Ton, Aufnahmen/SD-Karte, Privatmodus und Sirene (diese nutzen bei Tapo ein eigenes, nicht dokumentiertes Cloud-Protokoll).
