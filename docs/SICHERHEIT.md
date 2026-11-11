# Sicherheit

## Was HomeLite selbst schützt
- **Anmeldung:** Passwort als scrypt-Hash, Vergleich in konstanter Zeit, mindestens 8 Zeichen. Nach 8 Fehlversuchen ist die Adresse 10 Minuten gesperrt (Protokolleintrag und Benachrichtigung).
- **Sitzung:** signiertes Cookie (`HttpOnly`, `SameSite=Strict`, hinter HTTPS-Proxy zusätzlich `Secure` und HSTS). Passwortwechsel und „Überall abmelden“ machen alle Sitzungen ungültig.
- **Webhooks, Auslöser, KI-Zugriff:** zufällige 128-Bit-Schlüssel, Vergleich in konstanter Zeit, Sperre nach 20 Fehlversuchen je Adresse.
- **Browser:** strenge Content-Security-Policy, kein Einbetten in fremde Seiten, API nimmt nur JSON an (Schutz vor Cross-Site-Anfragen).
- **Dateien:** Archive (Update, Plugin, Backup) werden vor dem Entpacken auf Pfade außerhalb des Ziels und Verknüpfungen geprüft; die Datenbank ist nur für den Dienstbenutzer lesbar.

## Was du tun solltest
1. **Port 3100 nie direkt ins Internet freigeben.** Zugriff von außen über VPN (Tailscale, WireGuard) oder einen Reverse-Proxy mit HTTPS.
2. **HTTPS im Heimnetz**, wenn andere im WLAN sind: Reverse-Proxy (Caddy, nginx) vor HomeLite; ohne HTTPS geht das Passwort im Klartext übers Netz.
3. **Starkes Passwort** für HomeLite, eigenes Passwort für MQTT (kein anonymer Zugriff am Broker).
4. **Plugins nur aus vertrauenswürdiger Quelle.** Ein Plugin läuft mit allen Rechten von HomeLite; das SSH-Plugin kann Befehle auf anderen Rechnern ausführen.
5. **Dienst nicht als root betreiben** (siehe unten) und das System aktuell halten (`apt upgrade`).
6. **Backups schützen:** Sie enthalten Zugangsdaten (MQTT, Cloud-Konten). Nicht unverschlüsselt in eine Cloud legen.
7. Nach Verlust eines Geräts: Einstellungen → „Überall abmelden“, Webhook-Schlüssel und KI-Token neu erzeugen.

## Dienst ohne root (empfohlen)
```ini
# /etc/systemd/system/homelite.service
[Unit]
Description=HomeLite
After=network-online.target
[Service]
User=homelite
Group=homelite
WorkingDirectory=/opt/homelite
ExecStart=/usr/bin/node server.js
Restart=always
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/homelite
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
[Install]
WantedBy=multi-user.target
```
Einrichten: `sudo useradd -r -s /usr/sbin/nologin homelite && sudo chown -R homelite: /opt/homelite`, Datei speichern, `sudo systemctl daemon-reload && sudo systemctl restart homelite`.
Einschränkungen: Der Neustart des Rechners aus der Oberfläche braucht dann eine sudoers-Regel (Handbuch, „System-Neustart“); Bluetooth/USB-Geräte brauchen ggf. zusätzliche Gruppen (`dialout`, `bluetooth`); mit `NoNewPrivileges` funktioniert `sudo` aus HomeLite nicht.

## Bekannte Grenzen
- Kein eingebautes HTTPS, keine Mehrbenutzer-Rechte, keine Zwei-Faktor-Anmeldung.
- Updates und Plugins von GitLite (per Git über das Tailnet) bzw. GitHub (HTTPS) werden geladen, aber nicht signiert geprüft.
