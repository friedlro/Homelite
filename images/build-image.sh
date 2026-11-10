#!/usr/bin/env bash
# Baut ein SD-Karten-Image mit vorinstalliertem HomeLite aus einem offiziellen Basis-Image (armhf).
# Verwendung (als root, Linux): ./build-image.sh <basis.img.xz> <rootfs-partitionsnummer> <hostname-alt> <ziel.img>
#   Orange Pi One (Armbian):  ./build-image.sh Armbian_..._Orangepione_trixie_current_..._minimal.img.xz 1 orangepione out.img
#   Raspberry Pi (Pi OS Lite armhf, Pi 2+):  ./build-image.sh 2026-..-raspios-trixie-armhf-lite.img.xz 2 raspberrypi out.img
# Voraussetzungen: xz, losetup, e2fsck, resize2fs, python3, npm (zum Holen der Abhängigkeiten), Netzwerk für Node.js.
# Prüfe die Prüfsumme des Basis-Images selbst (sha256/sha1 vom Anbieter), bevor du es verwendest.
set -euo pipefail
BASE=$1; PART=$2; OLDHOST=$3; OUT=$4; GROW_MB=${GROW_MB:-600}
NODE_VER=${NODE_VER:-22.23.4}
HERE=$(cd "$(dirname "$0")/.." && pwd); W=$(mktemp -d)
cleanup(){ umount "$W/mnt" 2>/dev/null || true; [ -n "${LD:-}" ] && losetup -d "$LD" 2>/dev/null || true; }; trap cleanup EXIT
xz -dc "$BASE" > "$OUT"
read -r START SIZE < <(python3 - "$OUT" "$PART" <<'PY'
import struct,sys
d=open(sys.argv[1],'rb').read(512); i=int(sys.argv[2])-1; e=d[446+16*i:462+16*i]
s,n=struct.unpack('<II',e[8:16]); print(s*512,n*512)
PY
)
NEW=$((START+SIZE+GROW_MB*1024*1024)); truncate -s "$NEW" "$OUT"
python3 - "$OUT" "$PART" "$NEW" <<'PY'      # Partitionseintrag vergrößern
import struct,sys
f=open(sys.argv[1],'r+b'); d=bytearray(f.read(512)); i=int(sys.argv[2])-1; o=446+16*i
s=struct.unpack('<I',d[o+8:o+12])[0]; d[o+12:o+16]=struct.pack('<I',int(sys.argv[3])//512-s); f.seek(0); f.write(d)
PY
LD=$(losetup -f --show -o "$START" "$OUT"); e2fsck -fy "$LD" || true; resize2fs "$LD"
mkdir -p "$W/mnt"; mount "$LD" "$W/mnt"; R=$W/mnt
curl -fsSL "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-armv7l.tar.xz" -o "$W/node.tar.xz"
curl -fsSL "https://nodejs.org/dist/v$NODE_VER/SHASUMS256.txt" | grep "linux-armv7l.tar.xz" | (cd "$W" && sed "s#node-v.*#node.tar.xz#" | sha256sum -c -)
mkdir -p "$R/opt/node" "$R/opt/homelite"; tar -xJf "$W/node.tar.xz" -C "$R/opt/node" --strip-components=1; rm -rf "$R/opt/node/share" "$R/opt/node/include"
tar --exclude=node_modules --exclude=data --exclude=.git --exclude=images -C "$HERE" -cf - . | tar -xf - -C "$R/opt/homelite"
(cd "$R/opt/homelite" && npm install --omit=optional --omit=dev --no-audit --no-fund)
for b in node npm npx; do ln -sf "/opt/node/bin/$b" "$R/usr/local/bin/$b"; done
cat > "$R/etc/systemd/system/homelite.service" <<'U'
[Unit]
Description=HomeLite Hausautomatisierung
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=/opt/homelite
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
U
ln -sf /etc/systemd/system/homelite.service "$R/etc/systemd/system/multi-user.target.wants/homelite.service"
echo homelite > "$R/etc/hostname"; sed -i "s/$OLDHOST/homelite/g" "$R/etc/hosts"
sync; umount "$W/mnt"; e2fsck -fn "$LD" || true
echo "Fertig: $OUT  (zum Verteilen: xz -T0 -5 $OUT)"
