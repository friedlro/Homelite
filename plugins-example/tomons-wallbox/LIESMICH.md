# Tomons Wallbox (Plugin)

Bindet die **Tomons / Inateck Mobile Wallbox** (11 kW, 22 kW; Tomons-App) in HomeLite ein.

> **Inoffiziell und experimentell.** Der Hersteller (Shenzhen Licheng Technology) bietet keine öffentliche Schnittstelle. Das Plugin nutzt dasselbe Verfahren wie die App (Cloud-Anmeldung + MQTT-Broker, verschlüsselte Pakete). Grundlage ist das Reverse-Engineering von [Limo123123](https://github.com/Limo123123/tomons-reverse-engineering) (MIT-Lizenz). Der Hersteller kann das jederzeit ändern. **Nicht an echter Hardware getestet** – bitte erst beobachten, dann steuern.

## Einrichtung
1. Plugin installieren (Einstellungen → Erweiterungen → Plugins) und in den Einstellungen **E-Mail** und **Passwort** der Tomons-App eintragen (das Passwort geht nur als MD5-Hash an die Tomons-Cloud, wie in der App).
2. **MQTT-Passwort:** Der Cloud-Broker verlangt ein gemeinsames App-Passwort. Liefert die Cloud es bei der Anmeldung nicht mit, trage es im Feld „MQTT-Passwort“ ein. Du findest es in der Dokumentation des Referenzprojekts (Abschnitt Cloud/MQTT).
3. „Höchster Ladestrom“ passend setzen (11 kW = 16 A, 22 kW = 32 A) und Plugin aktivieren.
4. Seite **Wallbox**: Werte erscheinen, sobald die Wallbox Daten sendet (Abfrage alle 30 s; im Standby kann es etwas dauern).

## Geräte
Leistung, Spannung, Strom, Gesamtenergie, Ladeenergie (Vorgang), Temperatur, Ladestrom-Grenze, Lademodus, Kabelstatus, *Fahrzeug angesteckt*, *Lädt*, *Verbindung* und der Schalter *Wallbox Laden*. Alle nutzbar in Regeln, Verlauf und KI-Zugriff.

## Steuerung
- **Ladestrom-Grenze** (6, 8, 10, 13, 16, 20, 24, 32 A, begrenzt durch „Höchster Ladestrom“): Seite „Wallbox“ oder KI-Werkzeug `wallbox_ladestrom`. Der Befehl entspricht dem aus dem Referenzprojekt.
- **Start/Stopp**: standardmäßig **aus**. Der Befehl ist im Referenzprojekt nicht bestätigt. Erst über „Start/Stopp erlauben“ freischalten, wenn du es bewusst testen willst; wirkt dann auch der Schalter *Wallbox Laden*.

## Hinweise
- Ohne Internet gibt es keine Werte und keine Steuerung (Cloud-Verbindung, kein lokaler Zugriff).
- Die Wallbox erfasst Ladevorgänge erst ab 1 kWh in der App-Statistik.
- Protokollierte Zugangsdaten werden aus Fehlermeldungen entfernt. Das Passwort steht nur in den Plugin-Einstellungen.
