'use strict';

const hm = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

function inSlot(slot, now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yest = (today + 6) % 7;
  const days = slot.days && slot.days.length ? slot.days : [0, 1, 2, 3, 4, 5, 6];
  const f = hm(slot.from);
  const t = hm(slot.to);
  if (f <= t) return days.includes(today) && mins >= f && mins < t;
  return (days.includes(today) && mins >= f) || (days.includes(yest) && mins < t);
}

module.exports = function createHeating({ store, devices, presence, log }) {
  const applied = new Map();
  const live = new Map();
  const H = () => store.cfg.heating;
  const NEVER = 4e12;

  function target(room) {
    const h = H();
    const now = new Date();
    if (room.boost) {
      if (room.boost.until > Date.now()) return { t: Number(room.boost.temp), why: room.boost.until >= NEVER ? 'Manuell' : 'Boost' };
      delete room.boost;
      store.save();
    }
    const comfort = Number(room.comfort ?? 21);
    const eco = Number(room.eco ?? 17);
    switch (h.mode) {
      case 'off': return { t: Number(h.frost ?? 7), why: 'Aus (Frostschutz)' };
      case 'comfort': return { t: comfort, why: 'Komfort' };
      case 'eco': return { t: eco, why: 'Absenkung' };
      default:
    }
    if (room.awayEco !== false && presence.nobodyHome()) return { t: eco, why: 'Niemand zuhause' };
    if ((room.schedule || []).some((s) => inSlot(s, now))) return { t: comfort, why: 'Zeitplan' };
    return { t: eco, why: 'Absenkung' };
  }

  function evaluate(room) {
    const { t, why } = target(room);
    const dev = devices.byId(room.device);
    const sensor = room.sensor ? devices.byId(room.sensor) : null;
    const st = { target: t, why };
    if (!dev) { st.error = 'Gerät fehlt'; live.set(room.id, st); return; }
    const ds = devices.states.get(dev.id) || {};
    if (dev.type === 'thermostat') {
      st.current = sensor ? devices.numeric(sensor) : ds.current;
      st.setpoint = ds.setpoint;
      if (applied.get(room.id) !== t) {
        applied.set(room.id, t);
        devices.control(dev, 'setpoint', t, { k: 'heat', w: room.name })
          .then(() => log('info', `🌡 ${room.name}: Soll ${t} °C (${why})`))
          .catch((e) => { applied.delete(room.id); log('error', `Heizung ${room.name}: ${e.message}`); });
      }
    } else {
      st.on = ds.on;
      st.current = sensor ? devices.numeric(sensor) : NaN;
      if (isNaN(st.current)) { st.error = 'Temperatursensor fehlt/keine Messung'; live.set(room.id, st); return; }
      const want = st.current < t - 0.3 ? 'on' : st.current > t + 0.3 ? 'off' : null;
      if (want && ds.on !== (want === 'on')) {
        devices.control(dev, want, undefined, { k: 'heat', w: room.name }).then(() => log('info', `🌡 ${room.name}: ${want === 'on' ? 'heizt' : 'aus'} (Ist ${st.current}, Soll ${t})`))
          .catch((e) => log('error', `Heizung ${room.name}: ${e.message}`));
      }
    }
    if (st.current !== undefined && isNaN(st.current)) st.current = undefined;
    live.set(room.id, st);
  }

  function tick() {
    for (const room of H().rooms) {
      try { evaluate(room); } catch (e) { log('error', `Heizung ${room.name}: ${e.message}`); }
    }
  }

  function command(act) {
    const h = H();
    const mode = act.mode;
    if (!act.room) {
      if (!['comfort', 'eco', 'off', 'auto'].includes(mode)) throw new Error('Ungültiger Heizmodus');
      h.mode = mode;
    } else {
      const room = h.rooms.find((r) => r.id === act.room);
      if (!room) throw new Error('Heizraum nicht gefunden');
      if (mode === 'auto') delete room.boost;
      else {
        const temp = mode === 'boost' ? Number(act.temp) : mode === 'comfort' ? Number(room.comfort ?? 21) : mode === 'eco' ? Number(room.eco ?? 17) : Number(h.frost ?? 7);
        if (!isFinite(temp)) throw new Error('Ungültige Temperatur');
        const min = Number(act.minutes) || 0;
        room.boost = { temp, until: min > 0 ? Date.now() + min * 60000 : NEVER };
      }
    }
    store.save();
    tick();
  }

  function status() {
    const h = H();
    return {
      mode: h.mode, frost: h.frost,
      rooms: h.rooms.map((r) => ({ id: r.id, name: r.name, boost: r.boost || null, ...(live.get(r.id) || {}) })),
    };
  }

  function reset() { applied.clear(); live.clear(); tick(); }

  return { tick, command, status, reset };
};
