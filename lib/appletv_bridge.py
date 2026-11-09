#!/usr/bin/env python3
"""JSON-Zeilen-Brücke zwischen HomeLite (Node) und pyatv (Apple TV, nur Status).

Anfragen (stdin): {"id": 1, "cmd": ..., ...}   Antworten: {"id": 1, "ok": true, ...}
Ereignisse: {"event": "state", "id": <apple-tv-id>, "online": bool, "power": "on"|"off"|"unknown",
             "state": "playing"|"paused"|"idle"|..., "app": str, "appId": str, "title": str,
             "artist": str, "media": str}

Befehle:
  scan                                  -> {devices: [{id,name,address,model,protocols}]}
  pair_begin {atv, protocol, address}             -> {pin: bool}    (protocol: companion | airplay)
  pair_pin   {pin}                      -> {credentials}
  connect    {devices: [{id,address,creds:{companion,airplay}}]}
  disconnect
"""
import asyncio
import json
import sys
import threading

REAL_OUT = sys.stdout
sys.stdout = sys.stderr

try:
    import pyatv
    from pyatv.const import Protocol, PowerState, DeviceState
    from pyatv.interface import PushListener, DeviceListener, PowerListener
except Exception as exc:  # noqa: BLE001
    print("pyatv nicht ladbar (pip install pyatv): %r" % exc, file=sys.stderr, flush=True)
    sys.exit(3)



def patch_srptools():
    """srptools 2.0 macht 'private'/'password_verifier' keyword-only, pyatv übergibt sie noch positionell
    (pyatv-Issue #2934: „SRPClientSession.__init__() takes 2 positional arguments but 3 were given“).
    Diese Hülle nimmt beide Schreibweisen an und funktioniert mit srptools 1.x und 2.x."""
    try:
        import importlib
        import srptools

        class _Client(srptools.SRPClientSession):
            def __init__(self, context, private=None, **kw):
                super().__init__(context, private=private, **kw)

        for mod in ("pyatv.auth.hap_srp", "pyatv.protocols.airplay.srp"):
            try:
                m = importlib.import_module(mod)
            except Exception:  # noqa: BLE001
                continue
            if hasattr(m, "SRPClientSession"):
                m.SRPClientSession = _Client
    except Exception as exc:  # noqa: BLE001
        print("srptools-Anpassung nicht möglich: %r" % exc, file=sys.stderr, flush=True)


patch_srptools()

OUT_LOCK = threading.Lock()
PROTO = {"companion": Protocol.Companion, "airplay": Protocol.AirPlay}


def emit(obj):
    with OUT_LOCK:
        REAL_OUT.write(json.dumps(obj, default=str) + "\n")
        REAL_OUT.flush()


def name_of(x):
    return getattr(x, "name", None) if x is not None else None


class Watch(PushListener, DeviceListener, PowerListener):
    def __init__(self, dev):
        self.dev = dev
        self.atv = None
        self.task = None
        self.cur = {"online": False, "power": "unknown", "state": "idle", "app": "", "appId": "", "title": "", "artist": "", "media": ""}
        self.stop = False

    def push(self):
        emit({"event": "state", "id": self.dev["id"], **self.cur})

    def set(self, **kw):
        changed = any(self.cur.get(k) != v for k, v in kw.items())
        self.cur.update(kw)
        if changed:
            self.push()

    # PushListener
    def playstatus_update(self, updater, playstatus):
        try:
            self.set(
                state=(playstatus.device_state.name if playstatus.device_state else "idle").lower(),
                title=playstatus.title or "",
                artist=playstatus.artist or "",
                media=(playstatus.media_type.name if playstatus.media_type else "").lower(),
            )
            self.read_app()
        except Exception as exc:  # noqa: BLE001
            print("playstatus: %r" % exc, file=sys.stderr, flush=True)

    def playstatus_error(self, updater, exception):
        print("playstatus_error: %r" % exception, file=sys.stderr, flush=True)

    # PowerListener
    def powerstate_update(self, old_state, new_state):
        print("%s: Power %s -> %s" % (self.dev.get("id"), old_state, new_state), file=sys.stderr, flush=True)
        self.set(power="on" if new_state == PowerState.On else "off" if new_state == PowerState.Off else "unknown")
        if new_state == PowerState.Off:
            self.set(state="idle", app="", appId="", title="", artist="", media="")

    # DeviceListener
    def connection_lost(self, exception):
        self.set(online=False)

    def connection_closed(self):
        self.set(online=False)

    def read_app(self):
        try:
            app = self.atv.metadata.app
            if app is not None:
                self.set(app=app.name or "", appId=app.identifier or "")
        except Exception:  # noqa: BLE001
            pass

    async def locate(self, loop):
        """Gerät finden – auch wenn sich IP-Adresse oder Kennung (private WLAN-Adresse) geändert haben."""
        dev = self.dev
        ids = {dev["id"], *(dev.get("ids") or [])}
        host = [dev["address"]] if dev.get("address") else None
        res = await pyatv.scan(loop, identifier=ids, hosts=host, timeout=5)
        if not res and host:                      # IP-Adresse geändert (DHCP)
            res = await pyatv.scan(loop, identifier=ids, timeout=5)
        if not res:                               # Kennung geändert: über andere Kennungen oder den Namen suchen
            allr = await pyatv.scan(loop, timeout=6)
            res = [c for c in allr if ids & set(c.all_identifiers)]
            if not res and dev.get("name"):
                same = [c for c in allr if c.name == dev["name"]]
                res = same if len(same) == 1 else []
        if not res:
            raise RuntimeError("nicht im Netzwerk gefunden (mDNS/Standby?)")
        c = res[0]
        ident = list(c.all_identifiers)
        if str(c.address) != dev.get("address") or c.identifier != dev["id"] or set(ident) - set(dev.get("ids") or []):
            emit({"event": "found", "id": dev["id"], "address": str(c.address), "ident": c.identifier, "ids": ident})
            dev["address"] = str(c.address)
            dev["ids"] = ident
        return res

    async def run(self):
        loop = asyncio.get_running_loop()
        wait = 5
        while not self.stop:
            try:
                res = await self.locate(loop)
                conf = res[0]
                for key, proto in PROTO.items():
                    cred = (self.dev.get("creds") or {}).get(key)
                    if cred:
                        conf.set_credentials(proto, cred)
                self.atv = await pyatv.connect(conf, loop)
                self.atv.listener = self
                try:
                    self.atv.power.listener = self
                    self.set(power="on" if self.atv.power.power_state == PowerState.On else "off" if self.atv.power.power_state == PowerState.Off else "unknown")
                except Exception:  # noqa: BLE001
                    pass
                try:
                    self.atv.push_updater.listener = self
                    self.atv.push_updater.start()
                except Exception as exc:  # noqa: BLE001
                    print("push_updater: %r" % exc, file=sys.stderr, flush=True)
                self.set(online=True)
                self.read_app()
                wait = 5
                # Verbindung beobachten; alle 30 s App/Power nachlesen (Companion pusht nicht überall)
                off_polls = 0
                while not self.stop and self.cur["online"]:
                    await asyncio.sleep(30)
                    try:
                        ps = self.atv.power.power_state
                        self.set(power="on" if ps == PowerState.On else "off" if ps == PowerState.Off else "unknown")
                    except Exception:  # noqa: BLE001
                        ps = None
                    self.read_app()
                    # Ein gemeldeter Standby kann veraltet sein (Push-Ereignis „wach“ verpasst):
                    # nach 2 Minuten Standby neu verbinden, damit der Zustand frisch abgefragt wird.
                    off_polls = off_polls + 1 if ps == PowerState.Off else 0
                    if off_polls >= 4:
                        print("%s: Standby seit 2 Min – Verbindung wird erneuert" % self.dev.get("id"), file=sys.stderr, flush=True)
                        break
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                print("Apple TV %s: %r" % (self.dev["id"], exc), file=sys.stderr, flush=True)
                emit({"event": "error", "id": self.dev["id"], "msg": ("%s: %s" % (type(exc).__name__, exc))[:200]})
                self.set(online=False)
            finally:
                if self.atv is not None:
                    try:
                        self.atv.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self.atv = None
            if not self.stop:
                await asyncio.sleep(wait)
                wait = min(wait * 2, 120)


watchers = {}
pairing = {"handler": None, "proto": None, "id": None}


async def handle(req):
    cmd = req.get("cmd")
    loop = asyncio.get_running_loop()
    try:
        if cmd == "scan":
            found = await pyatv.scan(loop, timeout=6)
            out = []
            for c in found:
                out.append({
                    "id": c.identifier, "ids": list(c.all_identifiers), "name": c.name, "address": str(c.address),
                    "model": str(getattr(c.device_info, "model", "")) if getattr(c, "device_info", None) else "",
                    "protocols": sorted(s.protocol.name.lower() for s in c.services),
                })
            return {"ok": True, "devices": out}
        if cmd == "pair_begin":
            proto = PROTO.get(req.get("protocol"))
            if proto is None:
                return {"ok": False, "error": "Protokoll unbekannt"}
            found = await pyatv.scan(loop, identifier=req["atv"], hosts=[req["address"]] if req.get("address") else None, timeout=6)
            if not found:
                return {"ok": False, "error": "Gerät nicht gefunden"}
            if pairing["handler"] is not None:
                try:
                    await pairing["handler"].close()
                except Exception:  # noqa: BLE001
                    pass
            h = await pyatv.pair(found[0], proto, loop)
            await h.begin()
            pairing.update(handler=h, proto=req["protocol"], id=req["id"])
            return {"ok": True, "pin": bool(h.device_provides_pin)}
        if cmd == "pair_pin":
            h = pairing["handler"]
            if h is None:
                return {"ok": False, "error": "Keine Kopplung gestartet"}
            h.pin(str(req.get("pin", "")).strip())
            await h.finish()
            if not h.has_paired:
                return {"ok": False, "error": "Kopplung fehlgeschlagen (PIN falsch?)"}
            cred = h.service.credentials
            proto = pairing["proto"]
            await h.close()
            pairing.update(handler=None)
            return {"ok": True, "protocol": proto, "credentials": cred}
        if cmd == "connect":
            wanted = {d["id"]: d for d in req.get("devices", [])}
            for i in list(watchers):
                if i not in wanted or watchers[i].dev != wanted[i]:
                    watchers[i].stop = True
                    watchers[i].task.cancel()
                    del watchers[i]
            for i, d in wanted.items():
                if i not in watchers:
                    w = Watch(d)
                    w.task = asyncio.ensure_future(w.run())
                    watchers[i] = w
            return {"ok": True}
        if cmd == "disconnect":
            for w in watchers.values():
                w.stop = True
                w.task.cancel()
            watchers.clear()
            return {"ok": True}
        return {"ok": False, "error": "Unbekannter Befehl: %s" % cmd}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


async def main():
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if line:
                loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()
    while True:
        line = await queue.get()
        if line is None:
            break
        try:
            req = json.loads(line)
        except ValueError:
            continue

        async def work(r):
            res = await handle(r)
            res["id"] = r.get("id")
            emit(res)

        asyncio.ensure_future(work(req))


asyncio.run(main())
