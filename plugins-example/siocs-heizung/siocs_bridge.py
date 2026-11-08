#!/usr/bin/env python3
"""Zeilenbasierte JSON-Brücke zwischen HomeLite (Node) und dem SIOCS-Webportal (SCHNEID, Regler MR-12).

Portiert aus der Home-Assistant-App friedlro/ha-siocs-heizung (MIT). Das Portal hat keine offene
Schnittstelle: ein Chromium-Browser (Playwright) bedient es wie ein Mensch.

stdin  (je Zeile): {"cmd":"config","url":..,"username":..,"password":..,"poll":60}
                   {"cmd":"mode","mode":"auto"} | {"cmd":"offset","value":0.5} | {"cmd":"refresh"} | {"cmd":"debug","id":1}
stdout (je Zeile): {"event":"state","state":{..}} | {"event":"debug","id":1,..} | {"event":"fatal","error":".."}
Das Passwort wird nie protokolliert.
"""
import asyncio
import json
import re
import sys
import time

REAL_OUT = sys.stdout
sys.stdout = sys.stderr  # print() im Code landet im Protokoll, nicht im Datenkanal

try:
    from playwright.async_api import async_playwright
except Exception as exc:  # noqa: BLE001
    print("Playwright fehlt: %r" % exc, file=sys.stderr, flush=True)
    REAL_OUT.write(json.dumps({"event": "fatal", "error": "Python-Paket 'playwright' fehlt (pip install playwright && playwright install chromium)"}) + "\n")
    REAL_OUT.flush()
    sys.exit(3)

URL = USER = PASSWORD = ""
POLL = 60


def emit(obj):
    REAL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    REAL_OUT.flush()


MODES = {"auto": "0", "off": "1", "setback": "2", "heat": "3", "schedule": "4", "party": "5"}
MODE_BY_VALUE = {v: k for k, v in MODES.items()}

LABELS = {
    "Leistung": "power_kw",
    "Spreizung": "spread_k",
    "Wärmemenge": "energy_kwh",
    "Volumen": "volume_m3",
    "für Regelung": "outdoor_avg_control",
    "für Abschaltung": "outdoor_avg_shutdown",
    "Raumsoll.:": "room_setpoint",
}

# Die Element-IDs des Wt-Portals aendern sich je Sitzung. Werte werden deshalb ueber
# die Beschriftung in derselben Zeile gefunden, die Bedienelemente per data-ha markiert.
EXTRACT_JS = """
(labels) => {
  document.querySelectorAll('[data-ha]').forEach(e => e.removeAttribute('data-ha'));
  const parse = t => {
    const m = t.match(/^(-?\\d+(?:[.,]\\d+)?)\\s*(°C|kW|kWh|m3|l\\/h|%)?$/);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  };
  const leaves = [...document.querySelectorAll('body *')]
    .filter(e => e.children.length === 0 && e.textContent.trim()
                 && e.getBoundingClientRect().width > 0)
    .map(e => { const r = e.getBoundingClientRect();
                return {e, t: e.textContent.trim(), x: r.x, y: r.y, n: null}; });
  leaves.forEach(l => l.n = parse(l.t));
  const out = {};
  for (const [label, key] of Object.entries(labels)) {
    const lab = leaves.find(l => l.t === label);
    if (!lab) continue;
    let best = null, bd = 1e9;
    for (const l of leaves) {
      if (l.n === null || Math.abs(l.y - lab.y) > 6) continue;
      const d = Math.abs(l.x - lab.x);
      if (d < bd) { bd = d; best = l; }
    }
    if (best) out[key] = best.n;
  }
  const ref = leaves.find(l => l.t === 'Raumsoll.:');
  if (ref) {
    const temps = leaves.filter(l => l.t.endsWith('°C') && l.n !== null && l.x > ref.x - 40 && l.x < ref.x + 200
                                     && l.y > ref.y + 20 && l.y < ref.y + 200)
                        .sort((a, b) => a.y - b.y);
    if (temps.length >= 2) {
      temps[0].e.setAttribute('data-ha', 'offset'); out.offset = temps[0].n;
      temps[1].e.setAttribute('data-ha', 'room_temp'); out.room_temp = temps[1].n;
      // Klickbar ist nur das Statuswort (z.B. "Aus/FS"), nicht die "MANUELL-..."-Zeile darueber.
      const STATUS = /^(Aus\\/FS|Frostschutz|Heizen|Restw.rme|Absenkung|WW-Nachrang|Sperre|\\* Handbetrieb \\*|Ausheizen|0-10V Vorgabe|K.hlen)$/;
      const modeEl = leaves.filter(l => l.x > ref.x - 40 && l.x < ref.x + 200 && l.y > temps[1].y + 40
                                        && l.y < temps[1].y + 250 && STATUS.test(l.t))
                           .sort((a, b) => a.y - b.y)[0];
      if (modeEl) { modeEl.e.setAttribute('data-ha', 'mode'); out.mode_status = modeEl.t; }
    }
  }
  return out;
}
"""

# Heizzeiten: Seite HEIZZEITEN, je Heizkreis 7 Wochentage mit bis zu 3 Zeitraeumen (von/bis).
SCHEDULE_READY_JS = """
() => [...document.querySelectorAll('body *')].some(e => e.children.length === 0
  && e.textContent.trim() === 'Heizzeiten' && e.getBoundingClientRect().width > 0)
"""

SCHEDULE_JS = """
() => {
  const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const leaves = [...document.querySelectorAll('body *')]
    .filter(e => e.children.length === 0 && e.textContent.trim()
                 && e.getBoundingClientRect().width > 0)
    .map(e => { const r = e.getBoundingClientRect(); return {t: e.textContent.trim(), x: r.x, y: r.y}; });
  const isTime = t => t.length >= 4 && t.length <= 5 && t.charAt(t.length - 3) === ':' && !isNaN(parseInt(t));
  const hks = leaves.filter(l => /^HK[0-9]/.test(l.t));
  const out = {};
  for (const h of hks) {
    const left = h.x < 400;
    const below = hks.filter(o => (o.x < 400) === left && o.y > h.y).map(o => o.y);
    const yEnd = below.length ? Math.min(...below) - 5 : h.y + 170;
    const times = leaves.filter(l => isTime(l.t) && l.y >= h.y - 5 && l.y < yEnd
                                     && (left ? l.x < 590 : l.x >= 600))
                        .sort((a, b) => a.y - b.y);
    const rows = [];
    for (const l of times) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(l.y - last.y) < 8) last.items.push(l); else rows.push({y: l.y, items: [l]});
    }
    if (!rows.length) continue;
    const days = {};
    rows.slice(0, 7).forEach((row, i) => {
      const ts = row.items.sort((a, b) => a.x - b.x).map(l => l.t);
      const pairs = [];
      for (let j = 0; j + 1 < ts.length; j += 2) pairs.push([ts[j], ts[j + 1]]);
      days[DAYS[i]] = pairs;
    });
    out[h.t.slice(0, 3)] = {name: h.t, days};
  }
  return out;
}
"""

state = {"mode_selected": None, "updated": None, "ok": False, "error": ""}
pending = {}
wake = None
kick = None
lock = asyncio.Lock()
page = None


def publish():
    emit({"event": "state", "state": state})


async def login():
    await page.goto(URL, wait_until="load")
    await asyncio.sleep(3)  # Wt-JavaScript muss erst Handler anhaengen, sonst geht der Klick ins Leere
    # Die Felder haben keinen placeholder: erstes Textfeld, Passwortfeld, Button "Anmelden".
    user_box = page.locator("input[type=text]:visible").first
    pass_field = page.locator("input[type=password]:visible")
    if await pass_field.count():
        pw_box = pass_field.first
        for _ in range(3):
            # Wie ein Mensch tippen, damit Wt die Tastatur-Ereignisse mitbekommt.
            await user_box.click()
            await user_box.fill("")
            await user_box.press_sequentially(USER, delay=40)
            await pw_box.click()
            await pw_box.fill("")
            await pw_box.press_sequentially(PASSWORD, delay=40)
            await page.locator("button:has-text('Anmelden')").first.click()
            await asyncio.sleep(6)
            if not await pass_field.count():
                break
            print("login: Formular noch sichtbar, neuer Versuch", flush=True)
    # Im DOM liegen versteckte Vorlagen mit demselben Text - auf ein sichtbares Element warten.
    try:
        await page.wait_for_function(
            "() => [...document.querySelectorAll('body *')].some(e => e.children.length === 0"
            " && e.textContent.trim() === 'Raumsoll.:' && e.getBoundingClientRect().width > 0)",
            timeout=60000,
        )
    except Exception:  # noqa: BLE001
        text = await page.evaluate("() => document.body.innerText.slice(0, 1500)")
        print("nach login:", page.url, repr(text), flush=True)
        raise


async def click_btn(name):
    await page.locator("button", has_text=re.compile(rf"^\s*{name}\s*$", re.I)).last.click()


async def read_mode_selected():
    """Oeffnet den Auswahl-Dialog, liest die gewaehlte Betriebsart, bricht ab."""
    await page.locator("[data-ha=mode]").click()
    sel = page.locator("select:visible").last
    await sel.wait_for(state="visible", timeout=25000)
    value = await sel.evaluate("s => s.value")
    await click_btn("abbrechen")
    await page.locator("select:visible").last.wait_for(state="hidden", timeout=10000)
    state["mode_selected"] = MODE_BY_VALUE.get(value, value)
    publish()


async def poll_once(read_mode=False):
    data = {}
    for _ in range(10):  # das Portal baut die Seite schrittweise auf
        data = await page.evaluate(EXTRACT_JS, LABELS)
        if "room_temp" in data:
            break
        await asyncio.sleep(1)
    if "room_temp" not in data:
        print("auslese unvollstaendig:", data, flush=True)
        raise RuntimeError("Werte nicht gefunden - Sitzung abgelaufen?")
    state.update(data)
    state["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    state["ok"] = True
    state["error"] = ""
    publish()
    if read_mode:
        try:
            await read_mode_selected()
        except Exception as exc:  # noqa: BLE001
            print("modus lesen fehlgeschlagen:", exc, flush=True)
            await close_dialog()


async def read_schedule():
    """Oeffnet die Seite HEIZZEITEN, liest die Zeiten und kehrt zur Stationsseite zurueck."""
    try:
        btn = page.locator("button:visible", has_text=re.compile(r"^\s*HEIZZEITEN\s*$", re.I))
        await btn.first.click(timeout=15000)
        await page.wait_for_function(SCHEDULE_READY_JS, timeout=30000)
        await asyncio.sleep(2)
        data = await page.evaluate(SCHEDULE_JS)
        if data:
            first = next(iter(data.values()))
            state["schedule_all"] = data
            state["schedule"] = first["days"]
            state["schedule_circuit"] = first["name"]
            state["schedule_updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            publish()
        else:
            print("heizzeiten: keine Zeiten gefunden", flush=True)
    finally:
        await login()  # zurueck zur Stationsseite


async def poller():
    last_mode_read = 0
    last_schedule = 0
    last_reload = 0  # erster Durchlauf meldet sich an
    while True:
        async with lock:
            try:
                if time.time() - last_reload > 1800:
                    await login()
                    last_reload = time.time()
                due = time.time() - last_mode_read > 900
                await poll_once(read_mode=due)
                if due:
                    last_mode_read = time.time()
                if time.time() - last_schedule > 21600:  # alle 6 Stunden
                    last_schedule = time.time()
                    try:
                        await read_schedule()
                    except Exception as exc:  # noqa: BLE001
                        print("heizzeiten lesen fehlgeschlagen:", exc, flush=True)
            except Exception as exc:  # noqa: BLE001
                state["ok"] = False
                state["error"] = str(exc).split("\n")[0][:200]
                publish()
                print("poll fehler:", exc, flush=True)
                try:
                    await login()
                    last_reload = time.time()
                except Exception as exc2:  # noqa: BLE001
                    print("login fehler:", exc2, flush=True)
        try:
            await asyncio.wait_for(kick.wait(), POLL)
        except asyncio.TimeoutError:
            pass
        kick.clear()


async def set_mode(mode):
    await page.locator("[data-ha=mode]").click()
    sel = page.locator("select:visible").last
    await sel.wait_for(state="visible", timeout=25000)
    await sel.select_option(value=MODES[mode])
    await click_btn("ok")
    await page.locator("select:visible").last.wait_for(state="hidden", timeout=10000)
    state["mode_selected"] = mode
    publish()


async def set_offset(value):
    # Der Klick links im Korrektur-Feld oeffnet den Zahlen-Dialog (am Portal getestet).
    await page.locator("[data-ha=offset]").click(position={"x": 27, "y": 13})
    box = page.locator("input.Wt-spinbox:visible").last
    await box.wait_for(state="visible", timeout=10000)
    await box.fill(f"{value:.1f}")
    await box.press("Tab")
    await click_btn("ok")
    await page.locator("input.Wt-spinbox:visible").last.wait_for(state="hidden", timeout=10000)


async def close_dialog():
    btn = page.locator("button:visible", has_text=re.compile(r"^\s*abbrechen\s*$", re.I))
    if await btn.count():
        try:
            await btn.last.click(timeout=3000)
        except Exception:  # noqa: BLE001
            pass


async def applier():
    """Setzt nur den jeweils neuesten Wunsch um; schnelles Klicken in HA stapelt sich sonst."""
    while True:
        await wake.wait()
        wake.clear()
        while pending:
            key = next(iter(pending))
            value = pending.pop(key)
            async with lock:
                for attempt in range(3):
                    try:
                        await poll_once()  # markiert die Bedienelemente neu (Wt baut sie um)
                        if key == "mode":
                            await set_mode(value)
                        else:
                            await set_offset(value)
                        break
                    except Exception as exc:  # noqa: BLE001
                        print(f"setzen fehlgeschlagen ({key}={value}, Versuch {attempt + 1}): {exc}",
                              flush=True)
                        await close_dialog()
                        if attempt == 1:
                            try:
                                await login()
                            except Exception as exc2:  # noqa: BLE001
                                print("login fehler:", exc2, flush=True)
                await asyncio.sleep(4)
                try:
                    await poll_once()
                except Exception as exc:  # noqa: BLE001
                    print("poll nach setzen:", exc, flush=True)




async def debug_info():
    try:
        text = await page.evaluate("() => document.body.innerText.slice(0, 1500)")
        return {"url": page.url, "title": await page.title(), "text": text}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


async def handle(msg):
    cmd = msg.get("cmd")
    if cmd == "mode":
        mode = msg.get("mode")
        if mode in MODES:
            state["mode_selected"] = mode
            publish()
            pending["mode"] = mode
            wake.set()
    elif cmd == "offset":
        value = round(max(-5.0, min(5.0, float(msg["value"]))), 1)
        state["offset"] = value
        publish()
        pending["offset"] = value
        wake.set()
    elif cmd == "refresh":
        kick.set()
    elif cmd == "debug":
        info = await debug_info()
        emit({"event": "debug", "id": msg.get("id"), **info})


async def main():
    global page, wake, kick, URL, USER, PASSWORD, POLL
    wake = asyncio.Event()
    kick = asyncio.Event()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    # Die erste Zeile ist die Konfiguration.
    cfg = json.loads((await reader.readline()).decode() or "{}")
    URL = str(cfg.get("url", "")).strip().rstrip("/") + "/"
    USER = str(cfg.get("username", ""))
    PASSWORD = str(cfg.get("password", ""))
    POLL = max(30, min(3600, int(cfg.get("poll", 60) or 60)))
    pw = await async_playwright().start()
    browser = await pw.chromium.launch(args=["--no-sandbox"])
    ctx = await browser.new_context(viewport={"width": 731, "height": 698}, locale="de-AT")
    page = await ctx.new_page()
    asyncio.create_task(poller())
    asyncio.create_task(applier())
    while True:
        line = await reader.readline()
        if not line:
            break  # HomeLite beendet
        try:
            await handle(json.loads(line))
        except Exception as exc:  # noqa: BLE001
            print("befehl fehlgeschlagen:", exc, flush=True)
    await browser.close()


try:
    asyncio.run(main())
except Exception as exc:  # noqa: BLE001
    msg = str(exc).split("\n")[0][:200]
    if "Executable doesn't exist" in str(exc):
        msg = "Chromium fehlt für den HomeLite-Benutzer: als root 'playwright install --with-deps chromium' ausführen (siehe LIESMICH)"
    emit({"event": "fatal", "error": msg})
    sys.exit(1)
