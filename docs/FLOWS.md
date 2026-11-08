# Flows – visuelle Automationen (Node-RED- und n8n-Stil)

Für alles, was eine einfache Regel nicht kann: Verzweigungen, Schleifen, Warten auf Ereignisse, mehrere Quellen
zusammenführen, Webhooks, HTTP-Abfragen, Fehlerbehandlung und Unterflows.

## Grundprinzip
Ein **Auslöser** startet einen Lauf mit einer Nachricht `msg` (`msg.payload` = Inhalt). Jeder **Knoten** verarbeitet sie
und gibt sie über einen oder mehrere **Ausgänge** an die nächsten Knoten weiter (auch parallel). Läufe werden mit allen
Zwischenwerten im **Verlauf** gespeichert.

## Knoten (Auszug)
- Auslöser: Manuell · Gerät ändert sich (mit „muss N Sekunden anhalten“) · Zeitplan (täglich, Intervall, Cron, Sonne) · Webhook · MQTT · HomeLite startet · Unterflow-Eingang · Fehler abfangen
- Logik: Wenn · Weiche · Zeitfenster (auch „nur bei Dunkelheit“) · Schleife · Nur Änderungen
- Daten: Werte setzen · Code (JavaScript, abgeschottet) · Text-Vorlage · JSON · Aufteilen · Zusammenführen · Zweige vereinen
- Fluss: Warten · Entprellen · Drosseln · Auf Gerät warten · Flow aufrufen · Unterflow-Ergebnis · Fehler auslösen · Notiz · Debug
- Aktion: Gerät steuern/lesen · Virtuelles Gerät · Benachrichtigen · MQTT senden · HTTP-Anfrage · Webhook-Antwort · HomeLite-Werkzeug · Automation starten

## Ausdrücke
In jedem Textfeld: `{{ payload.temp > 25 }}`, `{{ $device("Wohnzimmer").power }}`, `{{ $node["Gerät lesen"].payload }}`,
`{{ flow.zaehler }}`, `{{ global.modus }}`, `{{ $fmt($now, "HH:mm") }}`, `{{ $sun.sunset }}`.
Hilfen: `$round $sum $avg $min $max $num $fmt $minutes $device $node $now $sun`.

## Fehler
Pro Knoten: Zweig abbrechen · weitermachen (`msg.error`) · eigener Fehler-Ausgang, dazu 0–5 Wiederholungen und Zeitlimit.
Flowweit: Knoten „Fehler abfangen“, optional Benachrichtigung.

## Sicherheit
- Code und Ausdrücke laufen in einer abgeschotteten VM ohne Zugriff auf Dateien/Prozess; Endlosschleifen werden nach kurzer Zeit abgebrochen.
- Webhook-Adressen enthalten einen geheimen Token; zusätzlich pro Auslöser ein Passwort möglich.
- Die KI (Werkzeuge `flows_*`) legt Flows immer **ausgeschaltet** an und kann Knoten „Code“ und „HomeLite-Werkzeug“ nicht verwenden. Abschaltbar in den Plugin-Einstellungen.
- Wer Flows bearbeiten darf, hat praktisch Admin-Rechte in HomeLite (Geräte schalten, HTTP-Anfragen im Heimnetz).

## Erweitern
Eigene Knoten als Datei in `data/plugin-data/flows/nodes/*.js` (Beispiel `_beispiel.js` liegt dort) oder aus einem anderen Plugin
über `api.onUse('flows', …)` – siehe PLUGINS.md. Die Oberfläche baut das Formular aus der Feldbeschreibung automatisch.

## Grenzen
Wartezeiten und laufende Flows überstehen keinen Neustart (Zeitpläne starten danach wieder normal). Höchstens 5000 Schritte pro Lauf, 50 parallele Läufe je Flow.
