#!/bin/bash
# Start Flask web dashboard + mission controller
# Launches agv_mission_controller.py in background, then app.py in foreground.
# On exit, cleans up the background process.
set -eo pipefail

SRC_DIR="/home/loong/AGV_sim/src"
WEB_DIR="${SRC_DIR}/web_dashboard"
MISSION_PID=""

cleanup() {
  echo ""
  echo "[start_web_dashboard] Shutting down..."
  if [[ -n "${MISSION_PID}" ]] && kill -0 "${MISSION_PID}" 2>/dev/null; then
    echo "[start_web_dashboard] Stopping agv_mission_controller (PID ${MISSION_PID})..."
    kill "${MISSION_PID}" 2>/dev/null
    wait "${MISSION_PID}" 2>/dev/null || true
  fi
  echo "[start_web_dashboard] Cleanup done."
}

trap cleanup EXIT INT TERM

set +u
source /opt/ros/humble/setup.bash
source "${SRC_DIR}/install/setup.bash"
set -u

cd "${WEB_DIR}"

echo "[start_web_dashboard] Starting agv_mission_controller.py in background..."
python3 agv_mission_controller.py &
MISSION_PID=$!

echo "[start_web_dashboard] Starting Flask app (app.py)..."
python3 app.py
