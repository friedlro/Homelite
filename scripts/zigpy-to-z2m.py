import sqlite3, json, os, random, string, zipfile, time
from zigpy.backups import NetworkBackup
import sys
names = json.loads(open('names.json').read()) if os.path.exists('names.json') else {}
c = sqlite3.connect('zigbee.db'); c.row_factory = sqlite3.Row
row = c.execute('select backup_json from network_backups_v16 order by id desc limit 1').fetchone()
raw = json.loads(row[0]); bk = NetworkBackup.from_dict(raw)
open_json = bk.as_open_coordinator_json()
ni = raw['network_info']; coord_ieee = raw['node_info']['ieee']
k0 = ni['network_key']['key']
key = bytes(k0) if isinstance(k0, list) else bytes.fromhex(k0.replace(':', '').replace(' ', ''))
ext = bytes.fromhex(ni['extended_pan_id'].replace(':', ''))
ext_z2m = list(ext[::-1])
pan = int(ni['pan_id'], 16); chan = ni['channel']
hx = lambda e: '0x' + e.replace(':', '').lower()
rid = lambda: ''.join(random.choices(string.ascii_letters + string.digits, k=16))
nd = {r['ieee']: dict(r) for r in c.execute('select * from node_descriptors_v16')}
eps = {}
for r in c.execute('select * from endpoints_v16'): eps.setdefault(r['ieee'], {})[r['endpoint_id']] = dict(r)
cl = {}
for r in c.execute('select * from clusters_v16'): cl.setdefault((r['ieee'], r['endpoint_id']), {0: [], 1: []})[r['cluster_type']].append(r['cluster_id'])
attr = {}
for r in c.execute('select ieee,endpoint_id,cluster_id,attr_id,value from attributes_cache_v16 where cluster_id=0'):
    v = r['value']
    if isinstance(v, bytes): v = v.decode(errors='ignore')
    attr.setdefault(r['ieee'], {})[r['attr_id']] = v
def s(v):
    if v is None: return None
    if isinstance(v, bytes): v = v.decode(errors='ignore')
    return str(v).strip('\x00')
def num(v):
    try: return int(v)
    except Exception: return None
lines = []; cfgdev = {}; nid = 1
lines.append({"id": 1, "type": "Coordinator", "ieeeAddr": hx(coord_ieee), "nwkAddr": 0, "manufId": 0, "epList": [11, 6, 5, 4, 3, 2, 1],
  "endpoints": {"1": {"profId": 260, "epId": 1, "devId": 5, "inClusterList": [], "outClusterList": [], "clusters": {}, "binds": [], "configuredReportings": [], "meta": {}}},
  "interviewCompleted": True, "interviewing": False, "meta": {}, "_id": rid()})
skipped = []
for d in c.execute('select * from devices_v16 order by ieee'):
    ieee = d['ieee']
    if ieee.lower() == coord_ieee.lower(): continue
    n = nd.get(ieee); a = attr.get(ieee, {})
    if not n: skipped.append(ieee); continue
    nid += 1
    typ = 'Router' if n['logical_type'] == 1 else 'EndDevice'
    mains = bool(n['mac_capability_flags'] & 0x04)
    ep = {}
    for e, er in sorted(eps.get(ieee, {}).items()):
        if e == 242: continue
        cc = cl.get((ieee, e), {0: [], 1: []})
        ep[str(e)] = {"profId": er['profile_id'], "epId": e, "devId": er['device_type'], "inClusterList": sorted(cc[0]), "outClusterList": sorted(cc[1]), "clusters": {}, "binds": [], "configuredReportings": [], "meta": {}}
    ent = {"id": nid, "type": typ, "ieeeAddr": hx(ieee), "nwkAddr": d['nwk'], "manufId": n['manufacturer_code'], "manufName": s(a.get(4)), "powerSource": "Mains (single phase)" if mains else "Battery",
      "modelId": s(a.get(5)), "epList": [int(k) for k in ep], "endpoints": ep, "appVersion": num(a.get(1)), "stackVersion": num(a.get(2)), "hwVersion": num(a.get(3)), "dateCode": s(a.get(6)), "swBuildId": s(a.get(0x4000)),
      "zclVersion": num(a.get(0)), "interviewCompleted": True, "interviewing": False, "meta": {}, "lastSeen": int(time.time() * 1000), "defaultSendRequestWhen": "immediate", "_id": rid()}
    ent = {k: v for k, v in ent.items() if v is not None}
    lines.append(ent)
    cfgdev[hx(ieee)] = names.get(ieee.lower()) or (ent.get('modelId') or 'geraet') + '_' + ieee[-5:].replace(':', '')
groups = {}
for g in c.execute('select * from groups_v16'): groups[g['group_id']] = {'name': g['name'], 'members': []}
for m in c.execute('select * from group_members_v16'): groups.setdefault(m['group_id'], {'name': 'Gruppe', 'members': []})['members'].append({"deviceIeeeAddr": hx(m['ieee']), "endpointID": m['endpoint_id']})
for gid, g in groups.items():
    nid += 1; lines.append({"id": nid, "type": "Group", "groupID": gid, "members": g['members'], "meta": {}, "_id": rid()})
q = lambda t: json.dumps(t, ensure_ascii=False)
y = ["# Zigbee2MQTT - aus HomeLite (zigpy/bellows) uebernommen. Dongle: " + str(raw['node_info'].get('model')) + " (EmberZNet " + str(raw['node_info'].get('version')) + ")",
 "version: 4", "homeassistant:", "  enabled: false", "mqtt:", "  base_topic: zigbee2mqtt", "  server: mqtt://192.168.50.10:1883", "serial:",
 "  port: /dev/ttyACM0   # ANPASSEN: ls /dev/serial/by-id/ auf dem Z2M-Server", "  adapter: ember", "  baudrate: 115200", "  rtscts: false", "frontend:", "  enabled: true", "  port: 8080",
 "advanced:", f"  channel: {chan}", f"  pan_id: {pan}", f"  ext_pan_id: {json.dumps(ext_z2m)}", f"  network_key: {json.dumps(list(key))}", "  log_level: info", "devices:"]
for k, v in cfgdev.items(): y += [f'  "{k}":', f'    friendly_name: {q(v)}']
if groups:
    y.append('groups:')
    for gid, g in groups.items(): y += [f'  "{gid}":', f'    friendly_name: {q(g["name"] or "Gruppe %d" % gid)}']
os.makedirs('out', exist_ok=True)
open('out/configuration.yaml', 'w').write('\n'.join(y) + '\n')
open('out/database.db', 'w').write('\n'.join(json.dumps(l, ensure_ascii=False, separators=(',', ':')) for l in lines) + '\n')
open('out/coordinator_backup.json', 'w').write(json.dumps(open_json, indent=2) if not isinstance(open_json, str) else open_json)
open('out/state.json', 'w').write('{}\n')
with zipfile.ZipFile('zigbee2mqtt-backup.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in os.listdir('out'): z.write('out/' + f, f)
print('Geraete:', len(lines) - 1 - len(groups), 'Gruppen:', len(groups), 'uebersprungen:', skipped, 'Kanal', chan, 'PAN', pan, 'zip', os.path.getsize('zigbee2mqtt-backup.zip'))
