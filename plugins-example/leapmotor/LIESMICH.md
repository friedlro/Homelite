# Leapmotor (Plugin)

Zeigt dein Leapmotor-Auto in HomeLite: Ladestand, Reichweite, Verriegelung, Klima, Reifendruck, Kilometerstand und Standort (Adresse + Karte, Entfernung von Zuhause). Fernbefehle: ver-/entriegeln, Klima, Schnellheizen/-kühlen, Scheibe enteisen, Batterie vorheizen, Kofferraum, Ladestecker entriegeln, Lenkradheizung, Fenster schließen, Fahrzeug finden. Laden starten/stoppen unterstützt die Vorlage nicht. **Inoffizielle Schnittstelle** (Leapmotor-Cloud) – kann sich jederzeit ändern.

## Einrichtung
1. Plugin installieren und aktivieren (Einstellungen → Erweiterungen → Plugins).
2. ⚙ Einstellungen: App-E-Mail und Passwort, für Fernbefehle die Fahrzeug-PIN.
3. Seite „Auto“ öffnen. Fehlen die App-Zertifikate, dort **Zertifikate laden** wählen (aus dem öffentlichen Repository markoceri/leapmotor-certs). Ein bestehendes HomeLite ≤ 1.25 übernimmt Zugangsdaten **und** Zertifikate beim Update automatisch.

Voraussetzungen auf dem Rechner: Python 3 mit `requests` und `cryptography` (`pip install requests cryptography`, HomeLite nutzt `.venv/bin/python3` im Projektordner, sonst `$PYTHON`, sonst `python3`) sowie `curl`.

## Was das Plugin bereitstellt
- **Geräte:** Ladestand, Reichweite, Kilometerstand, Innen-/Außentemperatur, Ladeleistung, Entfernung von Zuhause (Sensoren); Lädt, Ladestecker angesteckt, Verriegelt, Klima an (binär) – nutzbar in Automationen, Verlauf und Dashboard.
- **Automations-Aktion „Leapmotor“** (Befehl senden) – funktioniert, solange das Plugin läuft.
- **KI-Zugriff:** `get_car` (lesen) und `car_command` (Befehle; Entriegeln, Kofferraum öffnen und Ladestecker entriegeln sind dort gesperrt).

## Diagnose
`python3 leap_diag.py <E-Mail> <Passwort> [PIN]` im Plugin-Ordner zeigt Schritt für Schritt, was fehlt oder abgelehnt wird (Zertifikatsordner dort: `leapmotor/certs`, im Betrieb `data/plugin-data/leapmotor/certs`).

Der Client stammt aus [kerniger/leapmotor-ha](https://github.com/kerniger/leapmotor-ha) (MIT, Lizenz im Ordner `leapmotor`).
