# Alarmzentrale (Plugin)

Zentrale Alarmanlage für HomeLite: beliebige Sensoren und Sirenen frei auswählen.

## Einrichten
1. Plugin installieren und einschalten, Seite **Alarm** öffnen.
2. **Sensoren:** alle Geräte vom Typ „Binär“ (Bewegungsmelder, Tür-/Fensterkontakte, Rauch, Erschütterung …) stehen zur Auswahl. Pro Sensor festlegen: 🏠 *Zuhause* (zählt im Modus „Zuhause“, z. B. Türen/Fenster als Außenhaut), 🔒 *Abwesend* (zählt im Modus „Abwesend“, normalerweise alles) und ⏱ *verzögert* (Eingangstür: Zeit zum Unscharfschalten).
3. **Sirenen & Licht:** Schalter/Lichter wählen, die bei Alarm EIN gehen. Sirenen gehen nach der Sirenendauer wieder AUS, Licht beim Unscharfschalten bzw. Ende (nur wenn es vorher aus war).
4. Zeiten (Ausgangs-/Eingangsverzögerung, Sirenendauer), optionaler **PIN** und Benachrichtigung einstellen, *Einstellungen speichern*, mit *Sirene testen* prüfen.

## Ablauf
Unscharf → (Abwesend: Ausgangsverzögerung) → Scharf (Zuhause/Abwesend) → Sensor löst aus → bei „verzögert“ Eingangsverzögerung (Benachrichtigung) → **Alarm** (Sirenen, Licht, Benachrichtigung, Webhook-Auslöser `alarm_ausgeloest`) → nach der Sirenendauer wieder scharf. Beim Scharfschalten bereits offene Sensoren (z. B. gekipptes Fenster) werden ignoriert, bis sie schließen; die Namen stehen im Protokoll und in der Meldung. Nach einem Neustart von HomeLite bleibt der scharfe Zustand erhalten.

## Geräte & Automationen
- `Alarm Status` (Text), `Alarm Zuhause` und `Alarm Abwesend` (Schalter: an = scharf, aus = unscharf), `Alarm ausgelöst` (Binär; an bei Eingangsverzögerung und Alarm).
- In Automationen: Auslöser „Webhook `alarm_ausgeloest`“ oder das Gerät `Alarm ausgelöst`; „Alarm Abwesend“ lässt sich z. B. beim Verlassen des Hauses (Geofence) einschalten.
- KI-Zugriff: `alarm_status` (lesen) und `alarm_scharf` (scharf schalten, nur mit erlaubtem „Steuern“). Unscharf schalten ist per KI bewusst nicht möglich.

## Sicherheit / Grenzen
- Der PIN schützt „Unscharf“ in der Oberfläche (gespeichert als scrypt-Hash). Geräte-Schalter und Automationen schalten ohne PIN – wer HomeLite bedienen darf, kann also auch ohne PIN unscharf schalten.
- Kein Ersatz für eine zertifizierte Alarmanlage: Batterie-/Funkausfall von Sensoren und ein Ausfall von HomeLite/Server werden nicht gemeldet. Wichtig: Sirene und Sensoren über zuverlässige Verbindungen betreiben.
