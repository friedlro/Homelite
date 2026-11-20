# Tomons Wallbox (Plugin)

Bindet die **Tomons / Inateck Mobile Wallbox** (11 kW, 22 kW; Tomons-App) in HomeLite ein.

> **Inoffiziell und experimentell.** Der Hersteller (Shenzhen Licheng Technology) bietet keine öffentliche Schnittstelle. Das Plugin nutzt dasselbe Verfahren wie die App (Cloud-Anmeldung + MQTT-Broker, verschlüsselte Pakete). Grundlage ist das Reverse-Engineering von [Limo123123](https://github.com/Limo123123/tomons-reverse-engineering) (MIT-Lizenz). Der Hersteller kann das jederzeit ändern. **Nicht an echter Hardware getestet** – bitte erst beobachten, dann steuern.

## Einrichtung
1. Plugin installieren (Einstellungen → Erweiterungen → Plugins) und in den Einstellungen **E-Mail** und **Passwort** der Tomons-App eintragen (das Passwort geht nur als MD5-Hash an die Tomons-Cloud, wie in der App).
2. **MQTT-Passwort:** Die Cloud vergibt Benutzer und Passwort für den Broker bei jeder Anmeldung selbst. Das Feld „MQTT-Passwort“ normalerweise leer lassen (nur nötig, wenn das Protokoll „kein MQTT-Passwort geliefert“ meldet).
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

## App und HomeLite gleichzeitig nutzen (Freigabecode)
Die Cloud vergibt die MQTT-Zugangsdaten pro Anmeldung: Meldet sich die App mit demselben Konto an, verliert HomeLite die Verbindung (Fehler „Bad username or password“) und umgekehrt. Lösung: HomeLite bekommt ein **eigenes Tomons-Konto**.
1. Zweites Konto in der Tomons-App registrieren (andere E-Mail).
2. In deinem Hauptkonto: Gerät → „Teilen-Management“ → Freigabecode erzeugen (24 h gültig, ändert sich jedes Mal).
3. In den Plugin-Einstellungen E-Mail/Passwort des **zweiten** Kontos eintragen, dann auf der Seite „Wallbox“ den Code unter „Freigabecode“ einlösen.
4. Das Plugin nutzt dieselbe Route wie die Tomons-App (`device/add-by-share-code`). Falls die Cloud den Code trotzdem ablehnt, steht die Antwort im Protokoll; alternativ einmal in der Tomons-App mit dem zweiten Konto anmelden, „Per Freigabecode hinzufügen“ wählen, danach in der App wieder mit dem Hauptkonto anmelden.
Bei Anmeldefehlern versucht das Plugin nur noch alle 30 Minuten neu (jede Anmeldung kann sonst die App abmelden).

## Offenes Problem: verschlüsselte MQTT-Zugangsdaten
Die Cloud liefert die MQTT-Zugangsdaten inzwischen AES-256-CBC-verschlüsselt (Feld `mqtt_credentials`) statt im Klartext. Der Schlüssel dafür ist in der App nicht als lesbarer Text zu finden (vermutlich berechnet, nicht fest hinterlegt) und wurde hier nicht weiter rückentwickelt. Ohne ihn liefert das Plugin keine Messwerte. Falls jemand den Schlüssel kennt oder aus einem Netzwerk-Mitschnitt ableiten kann, bitte im Plugin (`tryDecrypt` in `index.js`) ergänzen. **Nicht an echter Hardware getestet.**

## Freigabe-Verwaltung (Plugin 1.2.0)
Auf der Seite „Wallbox“ unter „Freigabe-Verwaltung“ (einklappbar):
- **Mit anderen geteilt:** Nutzer, die deine Wallbox sehen können, mit Knopf zum Entfernen.
- **Mit mir geteilt:** Wallboxen anderer Konten, die mit dem Plugin-Konto geteilt wurden.
- **Freigabecode erzeugen:** Erstellt einen neuen Code für diese Wallbox (z. B. für ein weiteres Konto).
Alle Routen stammen aus der Tomons-App 1.1.5 (`device/my-shared-devices`, `device/share-users/<id>`, `device/delete-share`, `device/share-code/generate`), nicht an echter Hardware getestet.

## Was (noch) nicht geht: Lademodus-Zeitpläne, NFC-Karten, Start/Stopp
Peak/Valley-Zeitpläne (Tarifzonen), NFC-Karten verwalten und der Start/Stopp-Befehl werden in der App als „Tags“ über dieselbe verschlüsselte Geräteverbindung gesendet wie die Messwerte (device/{id}/send, AES-256-CBC). Solange das Plugin die MQTT-Zugangsdaten der Cloud nicht entschlüsseln kann (siehe Abschnitt oben), lassen sich auch diese Funktionen nicht zuverlässig nachbauen. Start/Stopp ist im Plugin als experimenteller Versuch vorhanden, der Rest fehlt bewusst.
