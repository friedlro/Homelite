#!/usr/bin/env python3
"""Zeilenbasierte JSON-Brücke zwischen HomeLite (Node) und dem Tuya/Smart-Life
Device-Sharing-SDK (lib/tuya/tuya_sharing, MIT).

Anfragen (stdin, je Zeile): {"id": 1, "cmd": ..., ...}
Antworten (stdout): {"id": 1, "ok": true, ...} / {"id": 1, "ok": false, "error": "..."}
Ereignisse (stdout): {"event": "update"|"token"|"devices", ...}
"""
import json
import logging
import os
import sys
import threading

REAL_OUT = sys.stdout
sys.stdout = sys.stderr
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tuya"))
logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

try:
    from tuya_sharing import LoginControl, Manager, SharingDeviceListener, SharingTokenListener
except Exception as exc:  # noqa: BLE001
    print("Tuya-SDK nicht ladbar (pip install requests cryptography paho-mqtt): %r" % exc, file=sys.stderr, flush=True)
    sys.exit(3)

try:
    import tinytuya  # lokales Tuya-Protokoll (optional: pip install tinytuya)
except Exception:  # noqa: BLE001
    tinytuya = None
import time

try:
    from tuya_sharing.strategy import strategy as _strategy
except Exception:  # noqa: BLE001
    _strategy = None

CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
SCHEMA = "haauthorize"
OUT_LOCK = threading.Lock()


def emit(obj):
    with OUT_LOCK:
        REAL_OUT.write(json.dumps(obj, default=str) + "\n")
        REAL_OUT.flush()


ON_CODES = ("switch_led", "switch_1", "switch", "led_switch", "switch_led_1")
BRIGHT_CODES = ("bright_value_v2", "bright_value", "bright_value_1")


def rng(dev, code):
    r = (getattr(dev, "status_range", None) or {}).get(code) or (getattr(dev, "function", None) or {}).get(code)
    if not r:
        return {}
    try:
        v = json.loads(r.values) if isinstance(r.values, str) and r.values else {}
    except ValueError:
        v = {}
    return {"type": r.type, "scale": v.get("scale", 0), "unit": v.get("unit", ""), "min": v.get("min"), "max": v.get("max")}


def describe(dev):
    status = dict(dev.status or {})
    codes = list(status.keys())
    ranges = {c: rng(dev, c) for c in codes}
    on = next((c for c in ON_CODES if c in status), None)
    br = next((c for c in BRIGHT_CODES if c in status), None)
    return {
        "id": dev.id,
        "name": dev.name,
        "category": dev.category,
        "product": getattr(dev, "product_name", ""),
        "online": bool(getattr(dev, "online", False)),
        "status": status,
        "ranges": ranges,
        "guess": {
            "on": on,
            "brightness": br,
            "brightnessMax": (ranges.get(br) or {}).get("max") or 1000 if br else None,
        },
    }


# ---------------------------------------------------------------------------
# Lokaler Modus: direkte TCP-Verbindung (Port 6668) zu Geräten im Heimnetz. Die Cloud bleibt als Rückfallebene.
# ---------------------------------------------------------------------------
LOCAL = {"enabled": True, "devices": {}}     # devices: {id: {"ip": "...", "version": 3.4}} – manuelle Angaben
links = {}                                   # id -> LocalLink
found = {}                                   # id -> {"ip", "version"} aus dem Netzwerk-Scan
scan_lock = threading.Lock()


def emit_local(did, state, **kw):
    emit({"event": "local", "id": did, "state": state, **kw})


def convertible(dev, dp_id):
    """DP direkt (ohne Umrechnung) les-/schreibbar?"""
    it = (getattr(dev, "local_strategy", None) or {}).get(dp_id)
    return bool(it) and it.get("value_convert") == "default"


class LocalLink(threading.Thread):
    def __init__(self, dev_id):
        super().__init__(daemon=True)
        self.dev_id = dev_id
        self.stop_flag = False
        self.lock = threading.Lock()
        self.d = None
        self.ok = False
        self.ip = ""
        self.version = 0
        self.fails = 0                    # aufeinanderfolgende Fehlversuche
        self.wake = threading.Event()     # weckt die Wartezeit, sobald der Scan eine (neue) IP kennt

    def device(self):
        return manager.device_map.get(self.dev_id) if manager else None

    def target(self):
        man = LOCAL["devices"].get(self.dev_id) or {}
        fnd = found.get(self.dev_id) or {}
        # Manuelle IP gilt, solange sie funktioniert. Hat sich die Adresse geändert (Router-Neustart/DHCP),
        # nimmt das Gerät nach 2 Fehlversuchen die per Scan gefundene IP – die Geräte-ID ist eindeutig.
        mip, fip = man.get("ip") or "", fnd.get("ip") or ""
        if mip and fip and mip != fip and self.fails >= 2:
            ip, ver = fip, fnd.get("version") or man.get("version") or 3.3
        else:
            ip = mip or fip
            ver = man.get("version") or fnd.get("version") or 3.3
        return ip, float(ver)

    def apply(self, dps):
        dev = self.device()
        if dev is None or not dps:
            return
        codes = []
        for k, v in dps.items():
            try:
                dp_id = int(k)
            except ValueError:
                continue
            it = (dev.local_strategy or {}).get(dp_id)
            if not it or _strategy is None:
                continue
            try:
                code, value = _strategy.convert(it["value_convert"], (it["status_code"], v), it["config_item"])
            except Exception:  # noqa: BLE001
                continue
            dev.status[code] = value
            codes.append(code)
        if codes:
            emit({"event": "update", "id": dev.id, "status": dict(dev.status or {}), "online": True, "changed": codes, "local": True})

    def set_state(self, ok, ip="", ver=0, reason=""):
        if ok != self.ok or ip != self.ip:
            self.ok, self.ip, self.version = ok, ip, ver
            emit_local(self.dev_id, "ok" if ok else "off", ip=ip, version=ver, reason=reason)

    def run(self):
        wait = 10
        while not self.stop_flag:
            dev = self.device()
            ip, ver = self.target()
            if dev is None or not getattr(dev, "local_key", "") or not getattr(dev, "support_local", False):
                self.set_state(False, reason="Gerät unterstützt lokal nicht")
                time.sleep(60)
                continue
            if not ip:
                self.set_state(False, reason="Im Netzwerk nicht gefunden")
                time.sleep(30)
                continue
            try:
                d = tinytuya.Device(dev.id, ip, dev.local_key, version=ver, persist=True, connection_timeout=5)
                d.set_socketRetryLimit(1) if hasattr(d, "set_socketRetryLimit") else None
                d.set_socketTimeout(1.5) if hasattr(d, "set_socketTimeout") else None
                st = d.status()
                if not isinstance(st, dict) or "dps" not in st:
                    raise RuntimeError((st or {}).get("Error") or "keine Antwort (Local Key/Version prüfen)")
                self.d = d
                self.apply(st["dps"])
                self.set_state(True, ip, ver)
                self.fails = 0
                wait = 10
                last_hb = time.time()
                while not self.stop_flag:
                    with self.lock:
                        data = d.receive()
                    if isinstance(data, dict):
                        if "dps" in data and data["dps"]:
                            self.apply(data["dps"])
                        elif data.get("Err") and str(data.get("Err")) not in ("904", "905"):
                            raise RuntimeError(data.get("Error") or "Fehler %s" % data.get("Err"))
                    if time.time() - last_hb > 8:
                        with self.lock:
                            d.heartbeat(nowait=True)
                        last_hb = time.time()
                    time.sleep(0.05)
            except Exception as exc:  # noqa: BLE001
                self.fails += 1
                self.set_state(False, ip, ver, str(exc)[:120])
                request_scan()            # vielleicht hat das Gerät eine neue IP bekommen
            finally:
                try:
                    if self.d is not None:
                        self.d.close()
                except Exception:  # noqa: BLE001
                    pass
                self.d = None
            if not self.stop_flag:
                self.wake.wait(wait)
                self.wake.clear()
                wait = min(wait * 2, 60)

    def send(self, dps):
        if not self.ok or self.d is None:
            raise RuntimeError("lokal nicht verbunden")
        with self.lock:
            r = self.d.set_multiple_values(dps) if len(dps) > 1 else self.d.set_value(list(dps)[0], dps[list(dps)[0]])
        if isinstance(r, dict) and r.get("Err"):
            raise RuntimeError(r.get("Error") or "Fehler %s" % r.get("Err"))


def scan_network():
    if tinytuya is None:
        return
    if not scan_lock.acquire(blocking=False):
        return
    try:
        res = tinytuya.deviceScan(False, 12, color=False, poll=False)
        for ip, info in (res or {}).items():
            gid = info.get("gwId") or info.get("id")
            if gid:
                new_ip = info.get("ip") or ip
                old = found.get(gid) or {}
                found[gid] = {"ip": new_ip, "version": info.get("version") or 3.3}
                lk = links.get(gid)
                if lk is not None and (old.get("ip") != new_ip or not lk.ok):
                    lk.wake.set()         # sofort mit der gefundenen IP verbinden
        emit({"event": "scan", "found": {k: v for k, v in found.items()}})
    except Exception as exc:  # noqa: BLE001
        print("Tuya-Scan: %r" % exc, file=sys.stderr, flush=True)
    finally:
        scan_lock.release()


_last_scan_req = 0.0


def request_scan():
    """Nach einem Verbindungsfehler sofort (höchstens alle 20 s) im Netzwerk nach der neuen IP suchen."""
    global _last_scan_req
    now = time.time()
    if now - _last_scan_req < 20 or tinytuya is None or not LOCAL.get("enabled"):
        return
    _last_scan_req = now
    threading.Thread(target=scan_network, daemon=True).start()


def local_start():
    """Netzwerk-Scan und je ein Verbindungs-Thread pro Gerät mit Local Key."""
    local_stop()
    if tinytuya is None:
        emit({"event": "local_info", "available": False})
        return
    emit({"event": "local_info", "available": True})
    if not LOCAL.get("enabled") or manager is None:
        return
    for did, dev in manager.device_map.items():
        if getattr(dev, "local_key", "") and getattr(dev, "support_local", False):
            l = LocalLink(did)
            links[did] = l
            l.start()
    threading.Thread(target=_scan_loop, daemon=True).start()


def _scan_loop():
    gen = id(links)
    while LOCAL.get("enabled") and links and gen == id(links):
        scan_network()
        for _ in range(180):          # alle 3 Minuten erneut suchen
            if gen != id(links) or not LOCAL.get("enabled"):
                return
            time.sleep(1)


def local_stop():
    global links
    for l in links.values():
        l.stop_flag = True
    links = {}


def try_local(device_id, commands):
    """Befehle lokal senden, wenn möglich. True = erledigt."""
    l = links.get(device_id)
    dev = manager.device_map.get(device_id) if manager else None
    if l is None or not l.ok or dev is None:
        return False
    code2dp = {it["status_code"]: dp for dp, it in (dev.local_strategy or {}).items()}
    dps = {}
    for c in commands:
        dp = code2dp.get(c.get("code"))
        if dp is None or not convertible(dev, dp):
            return False
        dps[str(dp)] = c.get("value")
    if not dps:
        return False
    l.send(dps)
    for c in commands:
        dev.status[c["code"]] = c["value"]
    emit({"event": "update", "id": dev.id, "status": dict(dev.status or {}), "online": True, "changed": [c["code"] for c in commands], "local": True})
    return True


class Listener(SharingDeviceListener):
    def update_device(self, device, updated_status_properties=None, dp_timestamps=None):
        emit({"event": "update", "id": device.id, "status": dict(device.status or {}), "online": bool(device.online), "changed": updated_status_properties})

    def add_device(self, device):
        emit({"event": "devices", "devices": all_devices()})

    def remove_device(self, device_id):
        emit({"event": "devices", "devices": all_devices()})


class TokenListener(SharingTokenListener):
    def update_token(self, token_info):
        emit({"event": "token", "token": token_info})


manager = None
login = LoginControl()
listener = Listener()


def all_devices():
    return [describe(d) for d in (manager.device_map.values() if manager else [])]


def do_connect(req):
    global manager
    disconnect()
    auth = req["auth"]
    manager = Manager(CLIENT_ID, req["userCode"], auth["terminal_id"], auth["endpoint"], auth["token_info"], TokenListener())
    manager.update_device_cache()
    manager.add_device_listener(listener)
    manager.refresh_mq()
    lc = req.get("local") or {}
    LOCAL["enabled"] = lc.get("enabled", True) is not False
    LOCAL["devices"] = lc.get("devices") or {}
    local_start()
    return {"ok": True, "devices": all_devices(), "localAvailable": tinytuya is not None}


def disconnect():
    global manager
    local_stop()
    if manager is not None:
        try:
            if manager.mq is not None:
                manager.mq.stop()
        except Exception:  # noqa: BLE001
            pass
    manager = None


def handle(req):
    cmd = req.get("cmd")
    try:
        if cmd == "qr":
            r = login.qr_code(CLIENT_ID, SCHEMA, req["userCode"])
            if not r.get("success"):
                return {"ok": False, "error": "Tuya: %s" % (r.get("msg") or r.get("errorMsg") or json.dumps(r)[:200])}
            token = r["result"]["qrcode"]
            return {"ok": True, "token": token, "qr": "tuyaSmart--qrLogin?token=" + token}
        if cmd == "qr_poll":
            ok, info = login.login_result(req["token"], CLIENT_ID, req["userCode"])
            if not ok:
                return {"ok": True, "done": False}
            return {"ok": True, "done": True, "auth": {
                "token_info": {k: info.get(k) for k in ("t", "uid", "expire_time", "access_token", "refresh_token")},
                "terminal_id": info.get("terminal_id"), "endpoint": info.get("endpoint"), "username": info.get("username"),
            }}
        if cmd == "connect":
            return do_connect(req)
        if cmd == "devices":
            return {"ok": True, "devices": all_devices()}
        if cmd == "refresh":
            if manager is None:
                return {"ok": False, "error": "Nicht verbunden"}
            manager.update_device_cache()
            manager.refresh_mq()
            return {"ok": True, "devices": all_devices()}
        if cmd == "control":
            if manager is None:
                return {"ok": False, "error": "Tuya nicht verbunden"}
            via = "cloud"
            try:
                if try_local(req["device"], req["commands"]):
                    via = "local"
            except Exception as exc:  # noqa: BLE001
                print("Tuya lokal: %s – Cloud wird verwendet" % exc, file=sys.stderr, flush=True)
            if via == "cloud":
                manager.send_commands(req["device"], req["commands"])
            return {"ok": True, "via": via}
        if cmd == "local_config":
            LOCAL["enabled"] = req.get("enabled", True) is not False
            LOCAL["devices"] = req.get("devices") or {}
            local_start()
            return {"ok": True, "localAvailable": tinytuya is not None}
        if cmd == "local_scan":
            threading.Thread(target=scan_network, daemon=True).start()
            return {"ok": True}
        if cmd == "disconnect":
            try:
                if manager is not None:
                    manager.unload()
            except Exception:  # noqa: BLE001
                pass
            disconnect()
            return {"ok": True}
        return {"ok": False, "error": "Unbekannter Befehl: %s" % cmd}
    except Exception as exc:  # noqa: BLE001
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
    emit(response)
