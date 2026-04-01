#!/bin/bash
# One-click launch using tmux (fallback when gnome-terminal is unavailable).
# Usage:
#   ./start_all_tmux.sh              # controller in interactive mode
#   ./start_all_tmux.sh headless     # controller in headless mode
#
# After launch:
#   tmux attach -t agv       # attach to the session
#   Ctrl-b then 0/1/2        # switch between panes
#   Ctrl-b then d             # detach (processes keep running)
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-interactive}"
SESSION="agv"

if ! command -v tmux &>/dev/null; then
  echo "Error: tmux not found. Install with: sudo apt install tmux"
  exit 1
fi

# Kill existing session if any
tmux kill-session -t "${SESSION}" 2>/dev/null || true

echo "[start_all_tmux] Creating tmux session '${SESSION}' (controller mode: ${MODE})..."

# Create session with first window: Gazebo
tmux new-session -d -s "${SESSION}" -n "gazebo" "'${SCRIPT_DIR}/start_gazebo.sh'; exec bash"

# Second window: Controller
tmux new-window -t "${SESSION}" -n "controller" "sleep 5; '${SCRIPT_DIR}/start_controller.sh' '${MODE}'; exec bash"

# Third window: Web Dashboard
tmux new-window -t "${SESSION}" -n "web" "sleep 7; '${SCRIPT_DIR}/start_web_dashboard.sh'; exec bash"

# Select first window
tmux select-window -t "${SESSION}:0"

echo "[start_all_tmux] tmux session '${SESSION}' created with 3 windows."
echo "  Attach with: tmux attach -t ${SESSION}"
echo "  Switch windows: Ctrl-b then 0/1/2"
echo "  Dashboard: http://localhost:5000"

# Auto-attach if running interactively
if [[ -t 0 ]]; then
  tmux attach -t "${SESSION}"
fi
