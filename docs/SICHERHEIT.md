# Sicherheit

## Was HomeLite selbst schützt
- **Anmeldung:** Passwort als scrypt-Hash, Vergleich in konstanter Zeit, mindestens 8 Zeichen. Nach 8 Fehlversuchen ist die Adresse 10 Minuten gesperrt (Protokolleintrag und Benachrichtigung).
- **Sitzung:** signiertes Cookie (`HttpOnly`, `SameSite=Strict`, hinter HTTPS-Proxy zusätzlich `Secure` und HSTS). Passwortwechsel und „Überall abmelden“ machen alle Sitzungen ungültig.
- **Webhooks, Auslöser, KI-Zugriff:** zufällige 128-Bit-Schlüssel, Vergleich in konstanter Zeit, Sperre nach 20 Fehlversuchen je Adresse.
- **Browser:** strenge Content-Security-Policy, kein Einbetten in fremde Seiten, API nimmt nur JSON an (Schutz vor Cross-Site-Anfragen).
- **Dateien:** Archive (Update, Plugin, Backup) werden vor dem Entpacken auf Pfade außerhalb des Ziels und Verknüpfungen geprüft; die Datenbank ist nur für den Dienstbenutzer lesbar.

## Schutz vor Zugriffen von außen (ab 1.27.0, standardmäßig an)
- **Nur Schlüssel-Pfade von außen:** Anfragen aus dem Internet (nicht aus LAN, Tailnet 100.64.0.0/10, lokal oder IPv6-ULA; erkannt an der Client-Adresse und am Header `Tailscale-Funnel-Request`) erreichen nur `/mcp`, `/hook`, `/trigger` und die Handy-Seite `/where.html`. Oberfläche, Anmeldung und API antworten von außen mit „Nicht gefunden“. Das gilt für Tailscale Funnel, Cloudflare Tunnel und Portfreigaben, solange der Proxy auf demselben Rechner läuft (Header `X-Forwarded-For` wird nur von dort akzeptiert).
- **Tailscale Funnel wird akzeptiert** (Einstellung „Tailscale Funnel akzeptieren“, Standard an): Anfragen, die der eigene `tailscaled` mit dem Header `Tailscale-Funnel-Request` weiterreicht, gelten als vertrauenswürdiger Zugang – auch die Oberfläche ist dann über die Funnel-Adresse erreichbar. Weiterhin gelten Anfragenbegrenzung, Sperre nach Fehlversuchen und die Meldung bei Anmeldung. Das Plugin Tailscale warnt, solange Funnel aktiv ist. Ausschalten, wenn nur `/mcp`, `/hook` und `/trigger` per Funnel erreichbar sein sollen (dann am besten auch `tailscale funnel` auf diese Pfade beschränken).
- **Begrenzung:** höchstens 120 Anfragen pro Minute und Adresse von außen; wer 30 Pfade abfragt, die es nicht gibt (Scanner), wird 10 Minuten gesperrt.
- **Meldung:** erfolgreiche Anmeldung von außen erzeugt Protokolleintrag und Push.
- **Server:** Zeitlimit für Anfragen (60 s), höchstens 400 gleichzeitige Verbindungen.
- **Einstellung:** Einstellungen → Allgemein → „Schutz vor Zugriffen von außen“ (ausschalten, weitere Pfade freigeben). Notfall: Umgebungsvariable `HOMELITE_ALLOW_EXTERNAL=1` hebt die Sperre auf.
- **Grenze:** Läuft der Reverse-Proxy auf einem *anderen* Rechner im LAN, sieht HomeLite nur dessen private Adresse und kann „außen“ nicht erkennen – dann den Proxy selbst auf die erlaubten Pfade beschränken (oder das Plugin Tailscale mit Serve statt Funnel nutzen).

## Was du tun solltest
1. **Port 3100 nie direkt ins Internet freigeben** (die Außen-Sperre ist ein zweiter Schutz, kein Ersatz). Zugriff von außen über VPN (Tailscale, WireGuard) oder einen Reverse-Proxy mit HTTPS.
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
