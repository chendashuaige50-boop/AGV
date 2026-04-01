#!/bin/bash
# Start AGV manual controller
# Usage:
#   ./start_controller.sh              # interactive mode (keyboard control)
#   ./start_controller.sh headless     # headless mode (remote control only)
set -eo pipefail

SRC_DIR="/home/loong/AGV_sim/src"
MODE="${1:-interactive}"

set +u
source /opt/ros/humble/setup.bash
source "${SRC_DIR}/install/setup.bash"
set -u

cd "${SRC_DIR}"

case "${MODE}" in
  interactive)
    echo "[start_controller] Starting in interactive mode (keyboard control)..."
    python3 agv_manual_controller.py
    ;;
  headless)
    echo "[start_controller] Starting in headless mode (remote control only)..."
    python3 agv_manual_controller.py < /dev/null
    ;;
  *)
    echo "Error: unknown mode '${MODE}'. Use 'interactive' or 'headless'."
    exit 1
    ;;
esac
