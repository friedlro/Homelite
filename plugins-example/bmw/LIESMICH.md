# BMW-Plugin (BMW CarData)

Zeigt dein BMW (oder MINI) in HomeLite: Ladestand, Reichweite, Laden/Stecker, Verriegelung, Türen/Klappen/Fenster, Reifendruck, Standort mit Karte, Tank, Service und **alle** weiteren Werte, die BMW liefert. Dazu Sensoren (Ladestand, Reichweite, Kilometerstand, lädt, Stecker, verriegelt, Tür offen …) für Automationen und das KI-Werkzeug `bmw_status`.

## Was geht – und was nicht

- **Nur lesend.** BMW CarData bietet keine Fernbefehle (kein Ver-/Entriegeln, keine Klimatisierung, kein Ladestart). Die frühere MyBMW-Schnittstelle (`bimmer_connected`) ist seit 29.09.2025 gesperrt.
- **Nur Fahrzeuge, die BMW CarData unterstützt** (BMW/MINI mit BMW-ID, vor allem Europa).
- **Daten kommen per Datenstrom** – BMW sendet nur, wenn sich im Fahrzeug etwas ändert (Fahrt, Laden, Türen, Schloss). Direkt nach der Einrichtung kann die Seite leer sein; der erste Wert erscheint mit der nächsten Änderung. Das Plugin merkt sich die letzten Werte dauerhaft.
- Nur die Datenpunkte, die du im BMW-Portal auswählst, werden gesendet. Die Seite ist deshalb nur so vollständig wie deine Auswahl – gib möglichst alle frei.
- REST-Abfragen (Modellname, Stammdaten) sind auf 50 pro Tag begrenzt; das Plugin nutzt nur 2 pro Tag.
- **Nicht mit einem echten BMW-Konto getestet** (nur mit einer simulierten BMW-Schnittstelle). Rückmeldungen willkommen.

## Einrichtung

1. In **MyBMW** (App oder Web, mit deiner BMW-ID) → *Mein Profil* → *Fahrzeug* → **BMW CarData** → Fahrzeug aktivieren/verknüpfen.
2. Im CarData-Kundenportal **Client-ID erstellen**; die Berechtigungen `cardata:api:read` und `cardata:streaming:read` anhaken. Kommt ein Fehler, ein paar Sekunden warten und den zweiten Bereich erneut anhaken.
3. Unter *Datenstrom* alle gewünschten **Datenpunkte (Deskriptoren)** auswählen und speichern.
4. In HomeLite: Plugin „BMW“ installieren und aktivieren, in den Einstellungen die **Client-ID** eintragen.
5. Seite **BMW** öffnen → **Bei BMW anmelden**. Es erscheint ein Code und ein Link; dort mit der BMW-ID bestätigen. Danach verbindet HomeLite den Datenstrom selbst.

Die Anmeldung gilt, bis BMW sie beendet (Refresh-Token). Das Plugin erneuert die Zugangsdaten automatisch (der Strom wird dabei etwa stündlich neu aufgebaut). Die Zugangsdaten liegen nur im Plugin-Speicher von HomeLite, werden nie angezeigt oder protokolliert; „Abmelden“ löscht sie.

## Hinweise

- Pro BMW-Konto ist nur **eine** Stromverbindung erlaubt. Läuft derselbe Zugang zusätzlich in einem anderen Programm (z. B. Home Assistant), trennen sich beide gegenseitig.
- Ausgewählte Datenpunkte werden anhand ihres Namens zugeordnet (z. B. `…batteryManagement.header` = Ladestand). Unbekannte Werte erscheinen unter „Alle Werte“ mit ihrem Originalnamen, Texte wie `CHARGINGACTIVE` sind eingedeutscht.
- Kartenkacheln kommen von openstreetmap.org (dein Browser lädt sie).
- Umgebungsvariablen nur für Tests: `BMW_AUTH_BASE`, `BMW_API_BASE`, `BMW_MQTT_URL`.
