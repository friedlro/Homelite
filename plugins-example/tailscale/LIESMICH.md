# Tailscale (Plugin)

Zeigt, was Tailscale auf dem HomeLite-Rechner macht – nur lesend, es ändert nichts an Tailscale.

- **Status:** Zustand, Tailscale-IP, Tailnet, Version, Hinweise von Tailscale.
- **Geräte im Tailnet:** online/offline, IP, System, direkte Verbindung oder Relay, zuletzt gesehen.
- **Sensoren:** In den Einstellungen Rechnernamen eintragen (z. B. `iphone-roland, nas` oder `*`): pro Gerät entsteht „Tailscale <Name>“ (an = online) für Automationen, Verlauf und Anwesenheit.
- **Funnel-Prüfung:** liest `tailscale serve status --json`. Ist **Funnel** aktiv (Internet-Freigabe), erscheint eine rote Warnung mit den freigegebenen Pfaden und eine Push-Nachricht, sobald Funnel neu aktiv wird oder sich die Pfade ändern. Optional Warnung, wenn ein überwachtes Gerät offline geht.
- **KI-Werkzeug:** `tailscale_status` (lesen).

Voraussetzung: `tailscale` ist auf dem Rechner installiert und HomeLite darf es abfragen (HomeLite als root, oder `sudo tailscale set --operator=<benutzer>`).

## Empfohlene Freigabe von außen
Von außen brauchst du nur `/mcp` (KI-Zugriff), `/hook` (iPhone-Geofence) und `/trigger`. Alles andere sperrt HomeLite für Anfragen aus dem Internet selbst (Einstellungen → Schutz vor Zugriffen von außen, ab HomeLite 1.27.0). Die Oberfläche am besten nur im Tailnet nutzen (`tailscale serve`, ohne Funnel).
