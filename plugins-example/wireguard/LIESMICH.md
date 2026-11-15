# WireGuard-Plugin

Eigener VPN-Server auf dem HomeLite-Rechner: Benutzer mit **Rechten**, **Geräte/Zugangspunkte** mit eigenen Schlüsseln und **Download der Client-Konfiguration** (Datei für die WireGuard-App bzw. zum Kopieren). Die Adresse, unter der sich die Geräte verbinden, kommt aus dem **DuckDNS-Plugin** (mehrere Domains = mehrere Zugangspunkte, pro Gerät wählbar). Weitere Adressen lassen sich in den Einstellungen ergänzen.

## Voraussetzungen

- Linux mit `wireguard` (`wg`, `wg-quick`) und `iptables`: `sudo apt install wireguard iptables`. HomeLite muss als root laufen (Standard bei der Installation).
- DuckDNS-Plugin eingerichtet (ab Version 1.1.0) **oder** eine eigene Adresse unter „Weitere Zugangspunkte“.
- Im Router: UDP-Port (Standard 51820) auf den HomeLite-Rechner weiterleiten.
- In den Plugin-Einstellungen das **Heimnetz** (z. B. 192.168.50.0/24) und ggf. DNS eintragen.

## Benutzung

1. Seite **WireGuard** → **➕ Benutzer**, Rechte wählen.
2. Beim Benutzer **➕ Gerät** (z. B. „iPhone“), Zugangspunkt wählen. Die Konfiguration wird angezeigt; **⬇ Konfiguration** lädt die `.conf`-Datei herunter. In der WireGuard-App „Tunnel aus Datei importieren“.
3. Rechte oder Geräte ändern: gilt sofort, der Server wird ohne Unterbrechung der anderen Verbindungen aktualisiert.

## Rechte

| Recht | Wirkung |
|---|---|
| Heimnetz | Zugriff auf das eingetragene Heimnetz |
| Internet über den Heimanschluss | gesamter Datenverkehr des Geräts läuft über dein Zuhause (Client bekommt `0.0.0.0/0`) |
| andere VPN-Geräte | Verbindung zu anderen Geräten im VPN-Netz |
| Einzelne Ziele | z. B. `192.168.50.10` oder `192.168.50.10:tcp:8123` – auch ohne Heimnetz-Recht |

Die Rechte werden **auf dem Server per Firewall** (eigene iptables-Kette `HL_WG`) durchgesetzt und nicht nur in der Client-Datei; ein Gerät kann sich also nicht durch Ändern seiner Datei mehr Zugriff geben. Ein gesperrter Benutzer oder ein gesperrtes Gerät wird sofort aus dem Server entfernt.

## Sensoren

Pro Gerät entsteht ein Gerät „VPN <Name>“ (an = in den letzten 3 Minuten verbunden) für Automationen. KI-Werkzeug `wireguard_status` (ohne Schlüssel).

## Hinweise und Grenzen

- Nur **IPv4**. Bei „Internet“ sollte auf dem Client IPv6 im Mobilfunknetz bedacht werden (kann am VPN vorbei laufen).
- Die privaten Schlüssel der Geräte liegen im Plugin-Speicher von HomeLite (damit die Datei erneut heruntergeladen werden kann). Wer Zugriff auf die HomeLite-Datenbank hat, kann sie lesen. „Neu schlüsseln“ macht eine alte Datei ungültig.
- Die Datei `/etc/wireguard/<Name>.conf` wird vom Plugin geschrieben und bei jeder Änderung überschrieben. Nicht von Hand ändern.
- Läuft bereits ein eigener WireGuard-Server mit demselben Schnittstellennamen, anderen Namen oder Port wählen.
- Bei aktiver Firewall (ufw) den UDP-Port erlauben und Weiterleitung zulassen (`DEFAULT_FORWARD_POLICY` bzw. `ufw route`); die Regeln des Plugins stehen in der Kette `HL_WG` vor den übrigen.
- Nicht auf echter Hardware getestet (nur mit simulierten Befehlen); Schlüsselerzeugung und Konfigurationsdateien entsprechen dem WireGuard-Format.
