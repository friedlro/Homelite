# ESP32-Display (Plugin)

Schnittstelle für einen **ESP32 mit Display** (z. B. Waveshare LCD): Du stellst in HomeLite Seiten und Kacheln zusammen, der ESP32 zeichnet sie. HomeLite sendet **nur Änderungen** – der ESP32 braucht weder JSON noch HTTP noch Geräte-Wissen.

Dieses Plugin enthält **keine Firmware**; es beschreibt das Protokoll, das die Firmware sprechen muss. Es ist nur mit einem simulierten ESP32 getestet.

## Einrichtung
1. Plugin installieren und aktivieren, Seite **Displays** → *Display hinzufügen*.
2. **Display-ID** vergeben (Buchstaben/Ziffern, z. B. `flur`) – dieselbe ID steht in der Firmware.
3. Seiten (max. 8) und Kacheln (max. 12 je Seite) anlegen: Gerät, Beschriftung, Art (*Wert*, *Schalter*, *Zustand*), Einheit, Nachkommastellen, Mindeständerung **Δ**.
4. Optional Nachtabsenkung (Helligkeit zwischen zwei Uhrzeiten).

Der ESP32 nutzt denselben MQTT-Broker wie HomeLite. Themenpräfix: Plugin-Einstellung (Standard `hl`).

## Protokoll (Text, alle Themen `<Präfix>/<ID>/…`)
**ESP32 → HomeLite**
| Thema | Inhalt |
|---|---|
| `status` | `online` (beim Verbinden, retained) / `offline` (Last Will, retained) |
| `hello` | Layout-Hash, den der ESP32 gespeichert hat (leer, wenn keiner). Beim Start senden. |
| `tap` | Kachel-Nummer (`tid`), die angetippt wurde. HomeLite schaltet bei Art *Schalter* das Gerät um. |

**HomeLite → ESP32**
| Thema | Inhalt |
|---|---|
| `layout/<n>` | Seite *n* (`n` ab 0). Nur wenn der Hash im `hello` nicht passt oder das Layout geändert wurde. Seite 0 beginnt mit `H|<Hash>|<Seitenzahl>`, dann `P|<n>|<Seitenname>` und je Kachel `T|<tid>|<Art>|<Beschriftung>|<Einheit>`. Hash speichern (Flash/NVS) und beim nächsten `hello` mitsenden. |
| `v` | Werte, eine Zeile je Änderung: `<tid>=<Wert>`. Zahlen fertig formatiert, Schalter/Zustand `1`/`0`, unbekannt `-`. Eine Nachricht ist höchstens ca. 480 Byte. |
| `cfg` | `b=<Helligkeit 0–100>` (retained), nur beim Wechsel (Nachtabsenkung). |

**Ablauf:** ESP32 verbindet → `status online` → `hello <Hash>` → HomeLite sendet (falls nötig) `layout/*`, dann einmal alle `v`-Werte und `cfg` → danach nur noch geänderte `v`-Zeilen. Pro Kachel nur neu zeichnen, wenn ihre Zeile eintrifft.

## Einsparung
- Unveränderte Werte und Änderungen unter **Δ** werden nicht gesendet.
- Mehrere Änderungen innerhalb von 500 ms (einstellbar) werden zu einer Nachricht gebündelt.
- Layout wird nur übertragen, wenn sich der Hash geändert hat.
- Die Seite zeigt je Display gesendete Nachrichten, Bytes und übersprungene Änderungen.

## Hinweise für die Firmware
- PubSubClient: Puffer vergrößern (`setBufferSize(1024)`), sonst gehen längere Nachrichten verloren.
- Last Will auf `<Präfix>/<ID>/status` mit `offline` (retained) setzen.
- Beim Wiederverbinden erneut `hello` senden, damit der aktuelle Stand kommt.
