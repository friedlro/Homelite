#!/usr/bin/env python3
"""Zeilenbasierte JSON-Brücke zwischen HomeLite (Node) und iCloud „Wo ist?“ (pyicloud).

Anfragen (stdin, je Zeile): {"id": 1, "cmd": ..., ...}
Antworten (stdout): {"id": 1, "ok": true, ...} / {"id": 1, "ok": false, "error": "..."}

Befehle:
  login   {apple, password, cookie_dir, china}  -> {state: "ok" | "2fa" | "2sa", trusted: [...]}
  verify  {code, device}                        -> {state: "ok"}   (2FA-Code bzw. 2SA-Code)
  poll    {}                                    -> {devices: [{id,name,model,battery,lat,lon,acc,ts,owner}]}
  logout  {}
"""
import json
import logging
import sys

REAL_OUT = sys.stdout
sys.stdout = sys.stderr
logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

try:
    from pyicloud import PyiCloudService
except Exception as exc:  # noqa: BLE001
    print("pyicloud nicht ladbar (pip install pyicloud): %r" % exc, file=sys.stderr, flush=True)
    sys.exit(3)

api = None
creds = {}


def emit(obj):
    REAL_OUT.write(json.dumps(obj, default=str) + "\n")
    REAL_OUT.flush()


def call(x, *a):
    return x(*a) if callable(x) else x


def state_of(a):
    """ok / 2fa / 2sa"""
    try:
        if a.requires_2fa:
            return "2fa"
    except Exception:  # noqa: BLE001
        pass
    try:
        if a.requires_2sa:
            return "2sa"
    except Exception:  # noqa: BLE001
        pass
    return "ok"


def trusted_list(a):
    try:
        return [
            {"i": i, "name": d.get("deviceName") or d.get("phoneNumber") or "Gerät %d" % (i + 1)}
            for i, d in enumerate(a.trusted_devices or [])
        ]
    except Exception:  # noqa: BLE001
        return []


def handle(req):
    global api, creds
    cmd = req.get("cmd")
    try:
        if cmd == "login":
            creds = {"apple": req["apple"], "password": req.get("password") or None, "dir": req.get("cookie_dir"), "china": bool(req.get("china"))}
            kwargs = {"cookie_directory": creds["dir"]} if creds["dir"] else {}
            if creds["china"]:
                kwargs["china_mainland"] = True
            api = PyiCloudService(creds["apple"], creds["password"], **kwargs)
            st = state_of(api)
            out = {"ok": True, "state": st}
            if st == "2sa":
                out["trusted"] = trusted_list(api)
                if out["trusted"]:
                    api.send_verification_code(api.trusted_devices[0])
            return out
        if cmd == "verify":
            if api is None:
                return {"ok": False, "error": "Nicht angemeldet"}
            code = str(req.get("code", "")).strip()
            st = state_of(api)
            if st == "2fa":
                if not api.validate_2fa_code(code):
                    return {"ok": False, "error": "Code falsch"}
                try:
                    if not api.is_trusted_session:
                        api.trust_session()
                except Exception:  # noqa: BLE001
                    pass
            elif st == "2sa":
                dev = api.trusted_devices[int(req.get("device", 0))]
                if not api.validate_verification_code(dev, code):
                    return {"ok": False, "error": "Code falsch"}
            return {"ok": True, "state": state_of(api)}
        if cmd == "poll":
            if api is None:
                return {"ok": False, "error": "Nicht angemeldet"}
            st = state_of(api)
            if st != "ok":
                return {"ok": False, "error": "Sitzung abgelaufen – bitte neu anmelden", "relogin": True}
            out = []
            for dev in api.devices:
                c = getattr(dev, "content", None) or getattr(dev, "data", None) or {}
                loc = c.get("location") or {}
                if not isinstance(loc, dict):
                    loc = {}
                try:
                    batt = c.get("batteryLevel")
                except Exception:  # noqa: BLE001
                    batt = None
                out.append({
                    "id": c.get("id") or c.get("baUUID") or c.get("name"),
                    "name": c.get("name") or "?",
                    "model": c.get("deviceDisplayName") or c.get("modelDisplayName") or "",
                    "battery": None if batt is None else round(float(batt) * 100),
                    "lat": loc.get("latitude"), "lon": loc.get("longitude"),
                    "acc": loc.get("horizontalAccuracy"),
                    "ts": loc.get("timeStamp"),
                    "owner": c.get("prsId") or "",
                })
            return {"ok": True, "devices": out}
        if cmd == "logout":
            api = None
            return {"ok": True}
        return {"ok": False, "error": "Unbekannter Befehl: %s" % cmd}
    except Exception as exc:  # noqa: BLE001
        msg = "%s: %s" % (type(exc).__name__, exc)
        if "password" in msg.lower() or "Invalid email" in msg:
            msg = "Anmeldung abgelehnt (Apple-ID/Passwort prüfen; ggf. App-spezifisches Passwort ist NICHT nötig): " + msg
        return {"ok": False, "error": msg}


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
    emit(response)
