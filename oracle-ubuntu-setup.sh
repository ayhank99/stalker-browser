#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-$HOME/iptv-manager}"

echo "[1/6] System packages"
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git ufw

if ! command -v docker >/dev/null 2>&1; then
  echo "[2/6] Docker"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "[3/6] Docker permissions"
sudo usermod -aG docker "$USER" || true

echo "[4/6] Firewall"
sudo ufw allow 22/tcp || true
sudo ufw allow 3000/tcp || true
sudo ufw allow 8080/tcp || true
sudo ufw --force enable || true

echo "[5/6] App directory"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ ! -f "docker-compose.yml" ]; then
  echo "Project files are not in $APP_DIR yet."
  echo "Copy this repo to the server, then rerun this script from inside that folder or pass the folder path."
  exit 1
fi

mkdir -p data
touch data/playlists.json

echo "[6/6] Start service"
sudo docker compose up -d --build

echo
echo "Setup complete."
echo "Web panel : http://$(hostname -I | awk '{print $1}'):3000"
echo "TV server : http://$(hostname -I | awk '{print $1}'):8080"
echo
echo "If docker permission is denied in a new shell, log out and log back in once."
