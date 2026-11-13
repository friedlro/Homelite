# Installation

## Voraussetzungen
Node.js ≥ 22 (benötigt `node:sqlite`). Optional: Python 3 mit `pip` für Apple TV, die Plugins Leapmotor und Tuya (lokal) und „Wo ist?“; `@matter/main` für Matter.

## Manuell
```bash
git clone https://github.com/friedlro/homelite.git /opt/homelite
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

## Fertige SD-Karten-Images
HomeLite ist als fertiges Image für **Orange Pi One** (Armbian) und **Raspberry Pi 2 und neuer** (Raspberry Pi OS Lite, 32 Bit) verfügbar: auf SD-Karte schreiben (z. B. Balena Etcher), starten, Einrichtungsassistenten des Betriebssystems durchlaufen, dann `http://<IP-Adresse>:3100` öffnen. Node.js und HomeLite liegen unter `/opt`, der Dienst `homelite` startet automatisch. Die Images baut `images/build-image.sh` aus dem offiziellen Basis-Image (siehe Kopf des Skripts). Nicht vorinstalliert: ffmpeg und Python-Pakete für Apple TV.

## Raspberry Pi (ab Pi 2)
```bash
git clone https://github.com/friedlro/homelite.git && cd homelite
sudo ./raspberry-pi/install.sh
```
Der Installer richtet Node.js (passend zur Architektur), Swap, Dienst und alle Plugins aus `plugins-example/` ein. Details: `raspberry-pi/LIESMICH.txt`.

## Plugins aus GitLite oder GitHub installieren
Einstellungen → Erweiterungen → Plugins → „Von Adresse installieren“, z. B.
`https://github.com/friedlro/Homelite/tree/main/plugins-example/philips-hue` (Ordner eines Plugins) oder die Adresse eines Repositorys, das genau ein Plugin im Hauptordner enthält.

## Erster Start
Das Start-Passwort steht im Log. Danach: Einstellungen → Passwort ändern, Räume und Geräte anlegen, ggf. HA-Import (Handbuch).

## Update
- Per Klick: Einstellungen → Update (Standard-Quelle: GitHub-Repository `https://github.com/friedlro/homelite`; als eigene Quelle geht auch ein GitLite-Repository, dafür ist `sudo apt install git` nötig, weil GitLite kein Archiv anbietet und HomeLite die Dateien per `git clone --depth 1` holt). Vorher `data/` sichern (Einstellungen → Backup).
- Per Git: `git pull && sudo systemctl restart homelite`.
Plugins unter `data/plugins` und alle Daten bleiben erhalten; neue Plugin-Versionen aus `plugins-example/` bei Bedarf neu installieren.

## Backup
Die gesamte Konfiguration liegt in `data/homelite.db` (+ `data/plugins`, `data/plugin-data`). Backup/Wiederherstellung in der Oberfläche oder durch Kopieren von `data/`.

## Leapmotor (Plugin)
Die App-Zertifikate gehören nicht ins Repository: Auf der Plugin-Seite „Auto“ → „Zertifikate laden“ (siehe `plugins-example/leapmotor/LIESMICH.md`). Bei einem Update von HomeLite ≤ 1.25 werden Zugangsdaten und vorhandene Zertifikate automatisch in das Plugin übernommen.
