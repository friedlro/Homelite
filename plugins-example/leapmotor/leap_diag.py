#!/usr/bin/env python3
"""Diagnose: python3 lib/leap_diag.py <E-Mail> <Passwort> [PIN]
Zeigt Schritt für Schritt, woran die Leapmotor-Anbindung scheitert."""
import os
import shutil
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
print("Python:", sys.version.split()[0], sys.executable)
print("curl:", shutil.which("curl") or "FEHLT (apt install curl)")
for mod in ("requests", "cryptography", "urllib3"):
    try:
        m = __import__(mod)
        print("%s: OK %s" % (mod, getattr(m, "__version__", "")))
    except Exception as e:  # noqa: BLE001
        print("%s: FEHLT (%s)  ->  pip install requests cryptography" % (mod, e))
try:
    from leapmotor.api import LeapmotorApiClient
except Exception as e:  # noqa: BLE001
    sys.exit("Client nicht ladbar: %r" % e)
certs = os.environ.get("LEAP_CERT_DIR") or os.path.join(here, "leapmotor", "certs")
print("Zertifikate:", [f for f in os.listdir(certs)])
if len(sys.argv) < 3:
    sys.exit("Aufruf mit E-Mail und Passwort für den Login-Test")
c = LeapmotorApiClient(username=sys.argv[1], password=sys.argv[2], operation_password=(sys.argv[3] if len(sys.argv) > 3 else None), static_cert_dir=certs)
try:
    c.login()
    print("Login: OK")
    vs = c.get_vehicle_list()
    print("Fahrzeuge:", [(v.vin[-4:], v.car_type) for v in vs])
    d = c.fetch_data()
    v = next(iter(d["vehicles"].values()))
    import json as _j
    import leap_bridge_view as _b
    print("Status: OK ->", _j.dumps(_b.status_dict(v), ensure_ascii=False))
    print("Abschnitte:", {k: (len(x) if hasattr(x, "__len__") else x) for k, x in v.items()})
except Exception as e:  # noqa: BLE001
    print("FEHLER:", type(e).__name__, e)
    for k, r in getattr(c, "last_api_results", {}).items():
        print("  letzter API-Aufruf", k, str(r)[:300])
