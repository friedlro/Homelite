#!/usr/bin/env python3
"""Zeilenbasierte JSON-Brücke zwischen HomeLite (Node) und dem mitgelieferten
Leapmotor-Client (Ordner leapmotor, Basis: github.com/kerniger/leapmotor-ha, MIT).

Die App-Zertifikate (markoceri/leapmotor-certs) liegen im Datenordner des Plugins (cfg.certDir) bzw. leapmotor/certs.

Protokoll: pro Zeile ein JSON-Objekt auf stdin
  {"id": 1, "cmd": "status"|<Befehl>, "cfg": {username, password, pin, certPath, keyPath, certDir, vin}}
Antwort pro Zeile auf stdout: {"id": 1, "ok": true, ...} oder {"id": 1, "ok": false, "error": "..."}
Logausgaben gehen nach stderr.
"""
import json
import logging
import os
import sys

REAL_OUT = sys.stdout
sys.stdout = sys.stderr  # Prints dürfen das Protokoll nicht stören
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

try:
    from leapmotor.api import LeapmotorApiClient
except Exception as exc:  # noqa: BLE001
    print("Leapmotor-Client nicht ladbar (pip install requests cryptography): %s" % exc, file=sys.stderr, flush=True)
    sys.exit(3)

CERT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "leapmotor", "certs")

# HomeLite-Befehl -> Methode des Clients
COMMANDS = {
    "lock": "lock_vehicle",
    "unlock": "unlock_vehicle",
    "ac_on": "ac_on",
    "ac_off": "ac_off",
    "quick_heat": "quick_heat",
    "quick_cool": "quick_cool",
    "windshield_defrost": "windshield_defrost",
    "battery_preheat": "battery_preheat",
    "battery_preheat_off": "battery_preheat_off",
    "find": "find_vehicle",
    "open_trunk": "open_trunk",
    "close_trunk": "close_trunk",
    "unlock_charger": "unlock_charger",
    "steering_wheel_heat_on": "steering_wheel_heat_on",
    "steering_wheel_heat_off": "steering_wheel_heat_off",
    "windows_close": "close_windows",
}

client = None
client_key = None


def ensure(cfg):
    global client, client_key
    key = json.dumps([cfg.get(k) for k in ("username", "password", "pin", "certPath", "keyPath", "certDir")])
    if client is None or key != client_key:
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
        client = LeapmotorApiClient(
            username=cfg.get("username"),
            password=cfg.get("password"),
            operation_password=cfg.get("pin") or None,
            static_cert_dir=(cfg.get("certDir") or CERT_DIR),
            history_timezone="Europe/Vienna",
        )
        cp, kp = (cfg.get("certPath") or "").strip(), (cfg.get("keyPath") or "").strip()
        if cp and kp:  # eigene Zertifikate überschreiben die mitgelieferten
            client.static_cert, client.static_key = cp, kp
        client_key = key
    return client


def pick_vehicle(data, vin):
    vehicles = (data or {}).get("vehicles") or {}
    if not vehicles:
        raise RuntimeError("Kein Fahrzeug im Konto gefunden")
    vin = (vin or "").strip()
    if vin and vin in vehicles:
        return vin, vehicles[vin]
    first = next(iter(vehicles))
    return first, vehicles[first]


from leap_bridge_view import flatten, status_dict  # noqa: E402


def handle(req):
    global client
    cfg = req.get("cfg") or {}
    cmd = req.get("cmd")
    try:
        c = ensure(cfg)
        if cmd == "status":
            data = c.fetch_data()
            vin, v = pick_vehicle(data, cfg.get("vin"))
            return {"ok": True, "vin": vin, "status": status_dict(v)}
        name = COMMANDS.get(cmd)
        if not name:
            return {"ok": False, "error": "Unbekannter Befehl: %s" % cmd}
        if not cfg.get("pin"):
            return {"ok": False, "error": "Für Fernbefehle ist die Fahrzeug-PIN nötig"}
        vin = (cfg.get("vin") or "").strip()
        if not vin:
            if not c.token:
                c.login()
            vehicles = c.get_vehicle_list()
            if not vehicles:
                raise RuntimeError("Kein Fahrzeug im Konto gefunden")
            vin = vehicles[0].vin
        getattr(c, name)(vin)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        client = None  # beim nächsten Aufruf neu anmelden
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except ValueError:
        continue
    response = handle(request)
    response["id"] = request.get("id")
    REAL_OUT.write(json.dumps(response, default=str) + "\n")
    REAL_OUT.flush()
