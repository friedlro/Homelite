#!/usr/bin/env python3
"""HomeLite-Zigbee-Brücke: ZHA-Kern (Bibliothek „zha“) + zigpy/bellows + zha-quirks.

Protokoll: JSON-Zeilen über stdin/stdout (Anfragen {id, cmd, ...} -> Antwort {id, ok, ...},
Ereignisse {event: ...}). Logs gehen nach stderr.
Es darf nur EIN Programm den Dongle halten (Zigbee2MQTT, Home Assistant/ZHA usw. beenden).
"""
import asyncio
import base64
import dataclasses
import enum
import json
import logging
import os
import sys
import time

logging.basicConfig(stream=sys.stderr, level=os.environ.get("ZB_LOG", "WARNING"))
LOG = logging.getLogger("homelite.zigbee")
OUT = sys.stdout


def emit(obj):
    OUT.write(json.dumps(obj, default=str, ensure_ascii=False) + "\n")
    OUT.flush()


def jsafe(v):
    """Beliebigen ZHA-Wert JSON-tauglich machen."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, enum.Enum):
        return v.value if isinstance(v.value, (int, float, str)) else v.name
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return {f.name: jsafe(getattr(v, f.name, None)) for f in dataclasses.fields(v)}
    if isinstance(v, dict):
        return {str(k): jsafe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [jsafe(x) for x in v]
    return str(v)


# Felder, die für HomeLite uninteressant sind (Metadaten)
SKIP = {"unique_id", "migrate_unique_ids", "platform", "class_name", "fallback_name", "translation_key",
        "translation_placeholders", "device_class", "state_class", "entity_category", "entity_registry_enabled_default",
        "enabled", "primary", "extra_state_attribute_names", "device_ieee", "endpoint_id", "group_id", "supported_features",
        "effect_list", "supported_color_modes", "fan_modes", "preset_modes", "hvac_modes"}


def state_dict(ent):
    try:
        st = ent.state
    except Exception as e:  # noqa: BLE001
        LOG.debug("state %s: %s", getattr(ent, "unique_id", "?"), e)
        return {}
    d = {}
    for f in dataclasses.fields(st):
        if f.name in SKIP:
            continue
        d[f.name] = jsafe(getattr(st, f.name, None))
    d["available"] = getattr(st, "available", None)
    return d


def ent_info(ent):
    st = None
    try:
        st = ent.state
    except Exception:  # noqa: BLE001
        pass
    cat = getattr(ent, "entity_category", None)
    return {
        "uid": ent.unique_id,
        "platform": str(getattr(ent.PLATFORM, "value", ent.PLATFORM)),
        "name": getattr(ent, "fallback_name", None) or getattr(ent, "translation_key", None) or "",
        "key": getattr(ent, "translation_key", None) or "",
        "device_class": str(jsafe(getattr(ent, "device_class", None)) or ""),
        "category": str(jsafe(cat) or ""),
        "enabled": bool(getattr(ent, "enabled", True)),
        "endpoint": getattr(ent, "endpoint_id", None) if hasattr(ent, "endpoint_id") else None,
        "unit": (getattr(st, "unit", None) if st is not None else None) or getattr(ent, "_attr_native_unit_of_measurement", None) or getattr(ent, "_attr_unit_of_measurement", None) or "",
        "options": jsafe(getattr(st, "options", None)) if st is not None and hasattr(st, "options") else None,
        "min": jsafe(getattr(ent, "_attr_native_min_value", None)),
        "max": jsafe(getattr(ent, "_attr_native_max_value", None)),
        "step": jsafe(getattr(ent, "_attr_native_step", None)),
        "state": state_dict(ent),
    }


def dev_info(dev):
    clusters = []
    try:
        for ep_id, ep in dev.zigpy_device.endpoints.items():
            if ep_id == 0:
                continue
            clusters.append({
                "ep": ep_id,
                "profile": getattr(ep, "profile_id", None),
                "device_type": jsafe(getattr(ep, "device_type", None)),
                "in": sorted(f"0x{c:04x}" for c in ep.in_clusters),
                "out": sorted(f"0x{c:04x}" for c in ep.out_clusters),
            })
    except Exception:  # noqa: BLE001
        pass
    quirk = ""
    try:
        quirk = type(dev.zigpy_device).__module__ + "." + type(dev.zigpy_device).__name__
        if quirk.startswith("zigpy.device"):
            quirk = ""
    except Exception:  # noqa: BLE001
        pass
    ents = []
    try:
        for e in dev.platform_entities.values():
            ents.append(ent_info(e))
    except Exception as e:  # noqa: BLE001
        LOG.warning("Entitäten von %s: %s", dev.ieee, e)
    return {
        "ieee": str(dev.ieee),
        "nwk": f"0x{dev.nwk:04x}" if isinstance(dev.nwk, int) else str(dev.nwk),
        "name": dev.name,
        "manufacturer": dev.manufacturer,
        "model": dev.model,
        "quirk": quirk,
        "type": str(dev.device_type),
        "power": str(dev.power_source),
        "mains": dev.is_mains_powered,
        "lqi": dev.lqi,
        "rssi": dev.rssi,
        "available": bool(dev.available),
        "last_seen": dev.last_seen,
        "sw": getattr(dev.zigpy_device, "sw_build_id", None) or "",
        "endpoints": clusters,
        "entities": ents,
    }


class Bridge:
    def __init__(self):
        self.gw = None
        self.cfg = {}
        self.unsubs = {}      # uid -> [unsub]
        self.dev_unsubs = {}  # ieee -> [unsub]
        self.starting = False
        self.loop = asyncio.get_running_loop()
        self.tasks = set()
        self.mismatch_old = None

    # ---------- Start / Stop ----------
    async def start(self, cfg):
        if self.gw or self.starting:
            return {"ok": True, "already": True}
        self.starting = True
        self.cfg = cfg
        emit({"event": "status", "state": "starting"})
        try:
            from zha.application.gateway import Gateway
            from zha.application.helpers import (CoordinatorConfiguration, QuirksConfiguration, ZHAConfiguration, ZHAData,
                                                 DeviceOptions)
            import zhaquirks
            path = cfg["path"]
            flow = cfg.get("flow_control") or None
            zcfg = {"database_path": os.path.join(cfg["data_dir"], "zigbee.db"),
                    "network": {"channel": int(cfg.get("channel") or 15)},
                    "ota": {"enabled": bool(cfg.get("ota", True))}}
            if cfg.get("custom_quirks"):
                os.makedirs(cfg["custom_quirks"], exist_ok=True)
            zha_cfg = ZHAConfiguration(
                coordinator_configuration=CoordinatorConfiguration(
                    path=path, baudrate=int(cfg.get("baudrate") or 115200),
                    flow_control=flow if flow in ("hardware", "software") else None,
                    radio_type=cfg.get("radio") if cfg.get("radio") in ("ezsp", "znp", "deconz", "xbee", "zigate") else "ezsp"),
                quirks_configuration=QuirksConfiguration(enabled=True, custom_quirks_path=cfg.get("custom_quirks") or None,
                                                         setup_function=zhaquirks.setup),
                device_options=DeviceOptions(enable_identify_on_join=False),
            )
            mode = cfg.get("mismatch") or ""
            db = zcfg["database_path"]
            if mode == "adopt" and os.path.exists(db):
                # Netz des Dongles übernehmen: alte Datenbank beiseitelegen (nicht löschen)
                os.replace(db, db + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
            if mode == "restore":
                zcfg["validate_network_settings"] = False
            data = ZHAData(config=zha_cfg, zigpy_config=zcfg)
            gw = await Gateway.async_from_config(data)
            data.gateway = gw
            gw.on_all_events(self.on_gw_event)
            await gw.async_initialize()
            if mode == "restore":
                old = self.mismatch_old
                if old is None:
                    raise RuntimeError("Kein altes Netz zum Zurückschreiben bekannt – erst normal verbinden")
                await gw.application_controller.backups.restore_backup(old, create_new=False)
                self.mismatch_old = None
                await gw.shutdown()
                emit({"event": "status", "state": "starting", "msg": "Altes Netz geschrieben, verbinde neu …"})
                self.starting = False
                return await self.start({**cfg, "mismatch": ""})
            self.gw = gw
            await gw.async_initialize_devices_and_entities()
            for d in list(gw.devices.values()):
                self.attach(d)
            emit({"event": "status", "state": "online", "info": self.net_info()})
            emit({"event": "devices", "devices": self.all_devices()})
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            LOG.exception("Start")
            self.gw = None
            c = e.__cause__ or e.__context__
            msg = f"{type(e).__name__}: {e}" + (f" ← {type(c).__name__}: {c}" if c else "")
            if type(e).__name__ == "NetworkSettingsInconsistent" and hasattr(e, "new_state"):
                self.mismatch_old = e.old_state

                def d(b):
                    return {"channel": b.network_info.channel, "pan_id": f"0x{b.network_info.pan_id:04x}", "ext_pan_id": str(b.network_info.extended_pan_id),
                            "ieee": str(b.node_info.ieee), "time": b.backup_time.isoformat()}
                detail = {"dongle": d(e.new_state), "database": d(e.old_state)}
                msg = "Das Zigbee-Netz auf dem Dongle passt nicht zur gespeicherten Datenbank"
                emit({"event": "status", "state": "error", "code": "mismatch", "detail": detail, "msg": msg})
                return {"ok": False, "error": msg, "mismatch": True}
            emit({"event": "status", "state": "error", "msg": msg})
            return {"ok": False, "error": msg}
        finally:
            self.starting = False

    async def stop(self):
        gw, self.gw = self.gw, None
        if gw:
            try:
                await asyncio.wait_for(gw.shutdown(), 20)
            except Exception as e:  # noqa: BLE001
                LOG.warning("Shutdown: %s", e)
        emit({"event": "status", "state": "stopped"})

    # ---------- Netzwerkinfo ----------
    def net_info(self):
        gw = self.gw
        if not gw or not gw.application_controller:
            return {}
        app = gw.application_controller
        st = app.state
        ni, no = st.network_info, st.node_info
        info = {
            "channel": ni.channel, "pan_id": f"0x{ni.pan_id:04x}", "ext_pan_id": str(ni.extended_pan_id),
            "nwk_update_id": ni.nwk_update_id, "coordinator_ieee": str(no.ieee), "radio": type(app).__module__.split(".")[0],
            "stack": str(getattr(ni, "stack_specific", None) and "ezsp" or ""),
            "version": str(no.version or ""), "model": no.model or "", "manufacturer": no.manufacturer or "",
            "devices": max(0, len(gw.devices) - 1),
        }
        return jsafe(info)

    # ---------- Geräte ----------
    def all_devices(self):
        gw = self.gw
        out = []
        for d in gw.devices.values():
            if getattr(d, "is_coordinator", False) or getattr(d, "is_active_coordinator", False):
                continue
            out.append(dev_info(d))
        return out

    def attach(self, dev):
        """An Entitäten und Gerät-Ereignisse hängen (idempotent)."""
        ieee = str(dev.ieee)
        if getattr(dev, "is_active_coordinator", False) or getattr(dev, "is_coordinator", False):
            return
        for u in self.dev_unsubs.pop(ieee, []):
            try:
                u()
            except Exception:  # noqa: BLE001
                pass
        subs = []
        try:
            subs.append(dev.on_event("zha_event", lambda ev, i=ieee: emit({"event": "zha_event", "ieee": i, "data": jsafe(getattr(ev, "data", {}))})))
        except Exception as e:  # noqa: BLE001
            LOG.debug("zha_event: %s", e)
        for ent in dev.platform_entities.values():
            self.attach_entity(ieee, ent, subs)
        self.dev_unsubs[ieee] = subs

    def attach_entity(self, ieee, ent, subs):
        uid, plat = ent.unique_id, str(getattr(ent.PLATFORM, "value", ent.PLATFORM))
        try:
            subs.append(ent.on_event("state_changed", lambda ev, i=ieee, u=uid, p=plat, e=ent: emit(
                {"event": "state", "ieee": i, "uid": u, "platform": p, "state": state_dict(e)})))
            subs.append(ent.on_event("event_triggered", lambda ev, i=ieee, u=uid: emit(
                {"event": "button", "ieee": i, "uid": u, "type": getattr(ev.triggered, "event_type", ""),
                 "attrs": jsafe(getattr(ev.triggered, "event_attributes", {}))})))
        except Exception as e:  # noqa: BLE001
            LOG.debug("Entität %s: %s", uid, e)

    def on_gw_event(self, ev):
        try:
            name = getattr(ev, "event", "")
            if name == "device_joined":
                emit({"event": "join", "ieee": str(ev.device_info.ieee), "nwk": f"0x{ev.device_info.nwk:04x}"})
            elif name == "raw_device_initialized":
                emit({"event": "join_raw", "ieee": str(ev.device_info.ieee), "manufacturer": ev.device_info.manufacturer, "model": ev.device_info.model})
            elif name == "device_fully_initialized":
                dev = self.gw.devices.get(ev.device_info.ieee)
                if dev:
                    self.attach(dev)
                    emit({"event": "device", "device": dev_info(dev), "new": bool(getattr(ev, "new_join", False))})
            elif name in ("device_left", "device_removed"):
                ieee = str(ev.ieee if name == "device_left" else ev.device_info.ieee)
                for u in self.dev_unsubs.pop(ieee, []):
                    try:
                        u()
                    except Exception:  # noqa: BLE001
                        pass
                emit({"event": "left" if name == "device_left" else "removed", "ieee": ieee})
            elif name == "connection_lost":
                emit({"event": "status", "state": "error", "msg": f"Verbindung zum Dongle verloren: {getattr(ev, 'exception', '')}"})
                self.spawn(self.reconnect())
        except Exception as e:  # noqa: BLE001
            LOG.warning("Gateway-Ereignis: %s", e)

    def spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    async def reconnect(self):
        """Nach Verbindungsverlust (z. B. Netzwerk-Dongle neu gestartet) alle 15 s neu versuchen."""
        if getattr(self, "reconnecting", False):
            return
        self.reconnecting = True
        cfg = self.cfg
        try:
            await self.stop()
        except Exception:  # noqa: BLE001
            pass
        for _ in range(10000):
            await asyncio.sleep(15)
            r = await self.start(cfg)
            if r.get("ok"):
                break
        self.reconnecting = False

    # periodische Auffrischung von LQI/Erreichbarkeit
    async def ticker(self):
        while True:
            await asyncio.sleep(60)
            if not self.gw:
                continue
            try:
                emit({"event": "health", "devices": [
                    {"ieee": str(d.ieee), "lqi": d.lqi, "rssi": d.rssi, "available": bool(d.available), "last_seen": d.last_seen}
                    for d in self.gw.devices.values() if not getattr(d, "is_active_coordinator", False)]})
            except Exception as e:  # noqa: BLE001
                LOG.debug("health: %s", e)

    # ---------- Befehle ----------
    def find_entity(self, ieee, uid):
        from zigpy.types import EUI64
        dev = self.gw.devices.get(EUI64.convert(ieee))
        if not dev:
            raise ValueError("Gerät unbekannt")
        for e in dev.platform_entities.values():
            if e.unique_id == uid:
                return e
        raise ValueError("Entität unbekannt")

    async def call(self, m):
        ent = self.find_entity(m["ieee"], m["uid"])
        method, a = m["method"], m.get("args") or {}
        plat = str(getattr(ent.PLATFORM, "value", ent.PLATFORM))
        fn = getattr(ent, "async_" + method, None)
        if fn is None:
            raise ValueError(f"{plat} kennt „{method}“ nicht")
        if method == "turn_on" and plat == "light":
            kw = {}
            if a.get("brightness") is not None:
                kw["brightness"] = max(1, min(255, int(a["brightness"])))
            if a.get("color_temp") is not None:
                kw["color_temp"] = int(a["color_temp"])
            if a.get("xy_color"):
                kw["xy_color"] = tuple(float(x) for x in a["xy_color"])
            if a.get("transition") is not None:
                kw["transition"] = float(a["transition"])
            await fn(**kw)
        elif method == "set_cover_position":
            await fn(position=int(a["position"]))
        elif method == "set_temperature":
            await fn(temperature=float(a["temperature"]))
        elif method == "set_hvac_mode":
            from zha.application.platforms.climate.const import HVACMode
            await fn(HVACMode(a["mode"]))
        elif method == "select_option":
            await fn(str(a["option"]))
        elif method == "set_native_value":
            await fn(float(a["value"]))
        else:
            await fn(**{k: v for k, v in a.items() if k != "_"})
        return {"state": state_dict(ent)}

    async def handle(self, m):
        cmd = m.get("cmd")
        if cmd == "start":
            return await self.start(m["cfg"])
        if cmd == "stop":
            await self.stop()
            return {"ok": True}
        if not self.gw and cmd not in ("ping",):
            return {"ok": False, "error": "Dongle nicht verbunden"}
        if cmd == "ping":
            return {"ok": True, "online": bool(self.gw)}
        if cmd == "info":
            return {"ok": True, "info": self.net_info()}
        if cmd == "devices":
            return {"ok": True, "devices": self.all_devices()}
        if cmd == "permit":
            t = max(0, min(254, int(m.get("time") or 0)))
            await self.gw.application_controller.permit(t)
            return {"ok": True}
        if cmd == "call":
            return {"ok": True, **(await self.call(m))}
        if cmd == "remove":
            from zigpy.types import EUI64
            await self.gw.async_remove_device(EUI64.convert(m["ieee"]))
            return {"ok": True}
        if cmd == "reinterview":
            from zigpy.types import EUI64
            dev = self.gw.devices.get(EUI64.convert(m["ieee"]))
            if not dev:
                return {"ok": False, "error": "Gerät unbekannt"}
            await dev.async_initialize(False)
            await dev.async_configure()
            self.attach(dev)
            emit({"event": "device", "device": dev_info(dev), "new": False})
            return {"ok": True}
        if cmd == "poll":
            from zigpy.types import EUI64
            dev = self.gw.devices.get(EUI64.convert(m["ieee"]))
            if not dev:
                return {"ok": False, "error": "Gerät unbekannt"}
            for e in dev.platform_entities.values():
                f = getattr(e, "async_update", None)
                if f:
                    try:
                        await f()
                    except Exception:  # noqa: BLE001
                        pass
            return {"ok": True}
        if cmd == "backup":
            app = self.gw.application_controller
            # ohne Geräte-Kindliste: für die Wiederherstellung des Netzes nicht nötig, und das Auslesen
            # (viele Anfragen) hat bei Netzwerk-Dongles die Verbindung abbrechen lassen
            bk = await app.backups.create_backup(load_devices=False)
            return {"ok": True, "data": bk.as_open_coordinator_json()}
        if cmd == "restore":
            from zigpy.backups import NetworkBackup
            data = m["data"]
            md = data.setdefault("metadata", {})
            md.setdefault("version", 1)
            md.setdefault("source", "import")
            md.setdefault("internal", {})
            bk = NetworkBackup.from_open_coordinator_json(data)
            app = self.gw.application_controller
            await app.backups.restore_backup(bk, create_new=False)
            # neuen Stand als „letztes Backup“ in der Datenbank vermerken, sonst meldet zigpy beim
            # Neustart einen Konflikt zwischen Dongle und Datenbank
            await app.load_network_info(load_devices=False)
            app.backups.add_backup(app.backups.from_network_state())
            return {"ok": True}
        if cmd == "set_channel":
            await self.gw.application_controller.move_network_to_channel(int(m["channel"]))
            return {"ok": True, "info": self.net_info()}
        if cmd == "scan":
            res = await self.gw.application_controller.energy_scan(channels=__import__("zigpy.types", fromlist=["Channels"]).Channels.ALL_CHANNELS, count=3, duration_exp=4)
            return {"ok": True, "scan": {str(k): int(v) for k, v in res.items()}}
        return {"ok": False, "error": f"unbekannter Befehl {cmd}"}


async def main():
    br = Bridge()
    br.spawn(br.ticker())
    reader = asyncio.StreamReader()
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    async def run(m):
        try:
            r = await br.handle(m)
        except Exception as e:  # noqa: BLE001
            LOG.exception("Befehl %s", m.get("cmd"))
            r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        emit({"id": m.get("id"), **r})

    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            m = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        br.spawn(run(m))
    await br.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
