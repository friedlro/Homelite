# SIOCS Heizung (Plugin)

Bindet eine Fernwärme-Übergabestation mit **SIOCS-Webportal** (SCHNEID, Regler MR-12) in HomeLite ein. Portiert aus der Home-Assistant-App [friedlro/ha-siocs-heizung](https://github.com/friedlro/ha-siocs-heizung) (MIT). Das Portal hat keine offene Schnittstelle, deshalb bedient ein Chromium-Browser (Playwright) es wie ein Mensch.

> Inoffiziell, ohne Gewähr. Befehle wirken auf die echte Anlage. Prüfe, ob automatisierter Zugriff beim Betreiber erlaubt ist, und frage nicht öfter ab als nötig.

## Voraussetzungen (auf dem HomeLite-Server, einmalig)

```bash
/opt/homelite/.venv/bin/pip install playwright
/opt/homelite/.venv/bin/playwright install --with-deps chromium   # ca. 300 MB Arbeitsspeicher beim Betrieb
```

(ohne `.venv`: `pip install --break-system-packages playwright`). Dann Plugin installieren, einschalten, unter *Einstellungen → Erweiterungen → Plugins → SIOCS Heizung* Adresse, Benutzer und Passwort eintragen. Auf einem Raspberry Pi mit wenig RAM ist Chromium knapp; empfohlen ab 2 GB.

## Geräte

| Gerät | Typ | Inhalt |
|---|---|---|
| Heizung Raumtemperatur / Raumsoll / Korrektur | Sensor | °C / °C / K |
| Heizung Außentemperatur (Regelung) | Sensor | gemittelt, °C |
| Heizung Leistung / Spreizung | Sensor | kW / K |
| Heizung Wärmemenge / Volumen | Sensor | kWh / m³ |
| Heizung Status / Betriebsart | Sensor (Text) | Anzeige im Portal / gewählte Betriebsart |
| Heizung | Thermostat | Ist = Raumtemperatur, Soll = Raumsoll; „Soll setzen“ verschiebt die **Korrektur** (−5…+5 K) |
| Heizung Absenkbetrieb, Heizung Partymodus | Schalter | an = Betriebsart setzen, aus = zurück auf Automatik |

Seite *Heizung (SIOCS)*: Messwerte, Betriebsart wählen, Korrektur setzen, Wochenplan (Heizzeiten, nur Anzeige, alle 6 h gelesen). KI-Werkzeug `heizung_betriebsart` (nur mit erlaubtem „Steuern“).

## Betriebsarten

`auto` Automatik · `off` Aus/Frostschutz · `setback` Absenkbetrieb · `heat` Heizbetrieb · `schedule` Zeitprogramm · `party` Partymodus. Manuelle Betriebsarten bleiben aktiv, bis auf `auto` zurückgestellt wird. Im Original getestet: `auto`, `setback` (gezielt), `heat`, `party` (beobachtet); `off`, `schedule` nicht.

## Zeitverhalten

Messwerte alle *Abfrage*-Sekunden (Standard 60), gewählte Betriebsart alle 15 min, Heizzeiten alle 6 h, Neuanmeldung spätestens alle 30 min. Das Portal zeigt Änderungen nach 10–30 s. Schnelle Folgebefehle werden zusammengefasst (es zählt der neueste).

## Fehlersuche

Protokoll des Plugins ansehen; `GET /api/plugins/siocs-heizung/x/debug` zeigt Seitentext (ohne Zugangsdaten). „Werte nicht gefunden“ = Layout weicht ab → `LABELS`/`EXTRACT_JS` in `siocs_bridge.py` anpassen. Entwickelt und getestet an **einer** Anlage (HK0).

## Sicherheit

Das Passwort liegt in den Plugin-Einstellungen von HomeLite und wird per stdin an die Brücke übergeben (nicht in Argumenten/Protokoll). Lizenz der Vorlage: MIT, © Roland Friedl.
