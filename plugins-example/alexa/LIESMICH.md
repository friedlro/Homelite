# Alexa (Hue-Emulation)

HomeLite gibt sich im Heimnetz als Philips-Hue-Bridge aus (SSDP auf UDP 1900 + Hue-API v1 auf Port 80).

1. Plugin installieren, Seite **Alexa** öffnen, Geräte freigeben, Namen vergeben.
2. Alexa-App → Geräte → + → Gerät hinzufügen → Licht → Philips Hue (oder „Alexa, suche neue Geräte“).
3. Sprachbefehle: „Alexa, schalte Stehlampe ein“, „… auf 50 Prozent“.

Voraussetzungen: Echo und HomeLite im selben Netz/VLAN (Multicast erlaubt), Port 80 und UDP 1900 frei. Unterstützt: Ein/Aus und Dimmen. Keine Sensoren, Thermostate, Rollos.
