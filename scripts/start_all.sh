#!/bin/bash
# One-click launch: opens 3 gnome-terminal windows for the full simulation stack.
# Usage:
#   ./start_all.sh              # controller in interactive mode
#   ./start_all.sh headless     # controller in headless mode
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-interactive}"

if ! command -v gnome-terminal &>/dev/null; then
  echo "Error: gnome-terminal not found. Use start_all_tmux.sh instead."
  exit 1
fi

echo "[start_all] Launching full AGV simulation stack (controller mode: ${MODE})..."

echo "[start_all] Opening Gazebo terminal..."
gnome-terminal --title="AGV - Gazebo" -- bash -lc "${SCRIPT_DIR}/start_gazebo.sh; exec bash"

sleep 5

echo "[start_all] Opening Controller terminal..."
gnome-terminal --title="AGV - Controller (${MODE})" -- bash -lc "${SCRIPT_DIR}/start_controller.sh ${MODE}; exec bash"

sleep 2

echo "[start_all] Opening Web Dashboard terminal..."
gnome-terminal --title="AGV - Web Dashboard" -- bash -lc "${SCRIPT_DIR}/start_web_dashboard.sh; exec bash"

echo "[start_all] All terminals launched. Dashboard will be at http://localhost:5000"
