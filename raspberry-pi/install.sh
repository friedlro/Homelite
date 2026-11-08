#!/usr/bin/env bash
# HomeLite-Installer für Raspberry Pi OS / Debian / Ubuntu (64-bit empfohlen). Als normaler Benutzer starten: ./install.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" -eq 0 ] && SUDO="" || SUDO="sudo"
DEST=/opt/homelite
PORT="${PORT:-3100}"
RUNUSER="${RUNUSER:-homelite}"

echo "==> Pakete installieren"
$SUDO apt-get update
$SUDO apt-get install -y curl ca-certificates python3 python3-venv python3-pip openssh-client rsync build-essential python3-dev libffi-dev libssl-dev

need_node=1
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node.split(".").slice(0,2).map(Number).reduce((a,b)=>a*1000+b)')
  [ "$v" -ge 22013 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  case "$(uname -m)" in
    armv7l) NARCH=armv7l ;;     # Raspberry Pi 2 / 3 (32-bit), Pi 4/5 mit 32-bit-System
    aarch64|arm64) NARCH=arm64 ;;
    x86_64) NARCH=x64 ;;
    *) echo "Nicht unterstützte Architektur $(uname -m) (Pi Zero/1 = ARMv6 hat kein Node 22)."; exit 1 ;;
  esac
  echo "==> Node.js 22 ($NARCH) von nodejs.org installieren"
  $SUDO apt-get install -y xz-utils
  BASE=https://nodejs.org/dist/latest-v22.x
  T=$(mktemp -d)
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$T/sums"
  FILE=$(grep "linux-$NARCH.tar.xz" "$T/sums" | awk '{print $2}' | head -1)
  [ -n "$FILE" ] || { echo "Kein Node-22-Build für $NARCH gefunden"; exit 1; }
  curl -fsSL "$BASE/$FILE" -o "$T/$FILE"
  (cd "$T" && grep " $FILE\$" sums | sha256sum -c -)
  $SUDO tar -xJf "$T/$FILE" -C /usr/local --strip-components=1
  rm -rf "$T"; hash -r
fi
node -v

# Wenig Arbeitsspeicher (z. B. Pi 2 mit 1 GB): Auslagerungsdatei anlegen, sonst scheitert npm install
MEM=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo); SWAP=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM" -lt 1500 ] && [ "$SWAP" -lt 500 ] && [ ! -e /swapfile ]; then
  echo "==> Wenig RAM ($MEM MB): 1 GB Auslagerungsdatei anlegen"
  $SUDO fallocate -l 1G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=1024
  $SUDO chmod 600 /swapfile; $SUDO mkswap /swapfile >/dev/null; $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

echo "==> Benutzer und Ordner"
id "$RUNUSER" >/dev/null 2>&1 || $SUDO useradd --system --create-home --shell /usr/sbin/nologin "$RUNUSER"
$SUDO mkdir -p "$DEST"
# vorhandene Daten (data/) bleiben unberührt
$SUDO rsync -a --exclude data --exclude node_modules --exclude .venv --exclude .git ./ "$DEST"/ 2>/dev/null || { $SUDO cp -a ./. "$DEST"/; }
$SUDO mkdir -p "$DEST/data/plugins"
for p in plugins-example/*/; do
  id=$(basename "$p")
  if [ ! -d "$DEST/data/plugins/$id" ]; then $SUDO cp -a "$p" "$DEST/data/plugins/$id"; echo "   Plugin $id installiert"; else echo "   Plugin $id vorhanden – übersprungen"; fi
done
$SUDO chown -R "$RUNUSER":"$RUNUSER" "$DEST"

echo "==> npm-Abhängigkeiten"
if [ "${WITH_MATTER:-auto}" = auto ]; then [ "$MEM" -ge 1500 ] && WITH_MATTER=1 || WITH_MATTER=0; fi
if [ "$WITH_MATTER" = 1 ]; then
  $SUDO -u "$RUNUSER" bash -c "cd $DEST && npm install --no-audit --no-fund" || echo "WARNUNG: npm install teilweise fehlgeschlagen (Matter ist optional)"
else
  echo "   (ohne Matter – spart Zeit/Speicher; später: WITH_MATTER=1 ./install.sh oder in den Einstellungen 'Matter-Paket installieren')"
  $SUDO -u "$RUNUSER" bash -c "cd $DEST && npm install --no-audit --no-fund --omit=optional"
fi

echo "==> Python-Umgebung (Apple TV, Leapmotor, Tuya)"
$SUDO -u "$RUNUSER" bash -c "cd $DEST && [ -d .venv ] || python3 -m venv .venv"
PYPK="requests cryptography paho-mqtt tinytuya"; [ "${WITH_APPLETV:-1}" = 1 ] && PYPK="$PYPK pyatv srptools<2"
$SUDO -u "$RUNUSER" "$DEST/.venv/bin/pip" install -q $PYPK || echo "WARNUNG: einige Python-Pakete fehlen (nur für Apple TV/Leapmotor/Tuya nötig)"

echo "==> systemd-Dienst"
$SUDO tee /etc/systemd/system/homelite.service >/dev/null <<UNIT
[Unit]
Description=HomeLite
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DEST
ExecStart=/usr/bin/node server.js
Environment=PORT=$PORT
Environment=PATH=$DEST/.venv/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
User=$RUNUSER

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now homelite
sleep 4
echo
echo "Fertig. HomeLite läuft auf http://$(hostname -I | awk '{print $1}'):$PORT"
echo "Das Start-Passwort steht im Log:  sudo journalctl -u homelite | grep -i passwort"
