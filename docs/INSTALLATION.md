# Installation

## Voraussetzungen
Node.js ≥ 22 (benötigt `node:sqlite`). Optional: Python 3 mit `pip` für Apple TV, Leapmotor, Tuya (lokal) und „Wo ist?“; `@matter/main` für Matter.

## Manuell
```bash
git clone https://github.com/friedlro/Homelite.git /opt/homelite
cd /opt/homelite && npm install --omit=dev
node server.js
```
Port 3100 (Umgebungsvariablen `PORT`, `HOST`; Datenordner `HOMELITE_DATA`, Standard `./data`).

## Dauerbetrieb mit systemd
```ini
# /etc/systemd/system/homelite.service
[Unit]
Description=HomeLite
After=network-online.target
[Service]
WorkingDirectory=/opt/homelite
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now homelite`. Läuft der Dienst ohne Root-Rechte, braucht der System-Neustart in der Oberfläche eine sudoers-Regel (siehe Handbuch, „System-Neustart“).

## Raspberry Pi (ab Pi 2)
```bash
git clone https://github.com/friedlro/Homelite.git && cd Homelite
sudo ./raspberry-pi/install.sh
```
Der Installer richtet Node.js (passend zur Architektur), Swap, Dienst und alle Plugins aus `plugins-example/` ein. Details: `raspberry-pi/LIESMICH.txt`.

## Plugins von GitHub installieren
Einstellungen → Erweiterungen → Plugins → „Von Adresse installieren“, z. B.
`https://github.com/friedlro/Homelite/tree/main/plugins-example/philips-hue` (Ordner eines Plugins) oder die Adresse eines Repositorys, das genau ein Plugin im Hauptordner enthält.

## Erster Start
Das Start-Passwort steht im Log. Danach: Einstellungen → Passwort ändern, Räume und Geräte anlegen, ggf. Übernahme aus Home Assistant (Handbuch).

## Update
- Per Klick: Einstellungen → Update (Quelle ist dieses GitHub-Repository). Vorher `data/` sichern (Einstellungen → Backup).
- Per Git: `git pull && sudo systemctl restart homelite`.
Plugins unter `data/plugins` und alle Daten bleiben erhalten; neue Plugin-Versionen aus `plugins-example/` bei Bedarf neu installieren.

## Backup
Die gesamte Konfiguration liegt in `data/homelite.db` (+ `data/plugins`, `data/plugin-data`). Backup/Wiederherstellung in der Oberfläche oder durch Kopieren von `data/`.

## Leapmotor
Die App-Zertifikate gehören nicht ins Repository: siehe `lib/leapmotor/certs/README.md`.
