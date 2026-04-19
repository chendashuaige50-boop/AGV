#!/usr/bin/env bash
# common_env.sh — Shared ROS/workspace environment bootstrap for AGV_sim.
#
# Priority order:
#   1. Reuse the ROS distro already loaded in the caller shell (ROS_DISTRO)
#   2. Use AGV_ROS_DISTRO if explicitly provided by the user
#   3. Auto-detect an installed distro from a known list
#
# This file is meant to be sourced:
#   source "$(dirname "$0")/common_env.sh"

_agv_common_env_fail() {
  echo "[common_env] Error: $*" >&2
  return 1 2>/dev/null || exit 1
}

_agv_common_env_note() {
  echo "[common_env] $*"
}

AGV_COMMON_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGV_PROJECT_ROOT="$(cd "${AGV_COMMON_ENV_DIR}/.." && pwd)"
export AGV_COMMON_ENV_DIR
export AGV_PROJECT_ROOT
AGV_ROS_DOMAIN_ID_PRESET="${ROS_DOMAIN_ID+x}"
AGV_ROS_LOCALHOST_ONLY_PRESET="${ROS_LOCALHOST_ONLY+x}"

# Keep ROS runtime state inside the workspace when the caller did not provide
# explicit locations, which avoids failures on machines where ~/.ros is
# unavailable or read-only and keeps launch logs close to the project.
if [[ -z "${ROS_HOME:-}" ]]; then
  export ROS_HOME="${AGV_PROJECT_ROOT}/.ros"
fi
if [[ -z "${ROS_LOG_DIR:-}" ]]; then
  export ROS_LOG_DIR="${ROS_HOME}/log"
fi
if [[ -z "${GZ_LOG_PATH:-}" ]]; then
  export GZ_LOG_PATH="${AGV_PROJECT_ROOT}/.gz"
fi
mkdir -p "${ROS_HOME}" "${ROS_LOG_DIR}" "${GZ_LOG_PATH}" 2>/dev/null || true

_agv_ros_candidates=()
if [[ -n "${ROS_DISTRO:-}" ]]; then
  _agv_ros_candidates+=("${ROS_DISTRO}")
fi
if [[ -n "${AGV_ROS_DISTRO:-}" ]]; then
  _already_listed=0
  for _candidate in "${_agv_ros_candidates[@]}"; do
    if [[ "${_candidate}" == "${AGV_ROS_DISTRO}" ]]; then
      _already_listed=1
      break
    fi
  done
  if [[ "${_already_listed}" -eq 0 ]]; then
    _agv_ros_candidates+=("${AGV_ROS_DISTRO}")
  fi
fi
for _candidate in jazzy humble iron rolling; do
  _already_listed=0
  for _listed in "${_agv_ros_candidates[@]}"; do
    if [[ "${_listed}" == "${_candidate}" ]]; then
      _already_listed=1
      break
    fi
  done
  if [[ "${_already_listed}" -eq 0 ]]; then
    _agv_ros_candidates+=("${_candidate}")
  fi
done

AGV_ROS_SETUP=""
AGV_ROS_DISTRO_SELECTED=""
for _candidate in "${_agv_ros_candidates[@]}"; do
  if [[ -f "/opt/ros/${_candidate}/setup.bash" ]]; then
    AGV_ROS_SETUP="/opt/ros/${_candidate}/setup.bash"
    AGV_ROS_DISTRO_SELECTED="${_candidate}"
    break
  fi
done

if [[ -z "${AGV_ROS_SETUP}" ]]; then
  _agv_common_env_fail "No supported ROS 2 setup file found. Tried: ${_agv_ros_candidates[*]}"
fi

set +u
source "${AGV_ROS_SETUP}"
set -u

export AGV_ROS_DISTRO_SELECTED

AGV_WS_SETUP="${AGV_PROJECT_ROOT}/install/setup.bash"
AGV_WS_SETUP_LOADED=0
if [[ -f "${AGV_WS_SETUP}" ]]; then
  set +u
  source "${AGV_WS_SETUP}"
  set -u
  AGV_WS_SETUP_LOADED=1
else
  _agv_common_env_note "Workspace overlay not found at ${AGV_WS_SETUP}"
  _agv_common_env_note "Run 'colcon build --symlink-install' on this machine before launching the full stack."
fi
export AGV_WS_SETUP
export AGV_WS_SETUP_LOADED

# Keep the default local simulation isolated from unrelated ROS 2 systems on
# DDS domain 0. Users can still override either variable before sourcing.
if [[ -z "${AGV_ROS_DOMAIN_ID_PRESET}" ]]; then
  unset ROS_DOMAIN_ID
fi
if [[ -z "${AGV_ROS_LOCALHOST_ONLY_PRESET}" ]]; then
  unset ROS_LOCALHOST_ONLY
fi
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-${AGV_ROS_DOMAIN_ID:-77}}"
export ROS_LOCALHOST_ONLY="${ROS_LOCALHOST_ONLY:-1}"

_agv_common_env_note "PROJECT_ROOT=${AGV_PROJECT_ROOT}"
_agv_common_env_note "ROS_DISTRO=${ROS_DISTRO:-${AGV_ROS_DISTRO_SELECTED}}"
if [[ "${AGV_WS_SETUP_LOADED}" -eq 1 ]]; then
  _agv_common_env_note "Workspace overlay loaded: ${AGV_WS_SETUP}"
else
  _agv_common_env_note "Workspace overlay not loaded"
fi

AGV_COMMON_ENV_LOADED=1
export AGV_COMMON_ENV_LOADED

_agv_collect_pids_by_pattern() {
  local pattern
  local pids=()
  for pattern in "$@"; do
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] || continue
      pids+=("${pid}")
    done < <(pgrep -f -- "${pattern}" 2>/dev/null || true)
  done

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi

  printf '%s\n' "${pids[@]}" | awk '!seen[$0]++'
}

_agv_current_process_tree_pids() {
  local pid="$$"
  local ppid=""
  while [[ -n "${pid}" && "${pid}" != "0" && -r "/proc/${pid}/status" ]]; do
    printf '%s\n' "${pid}"
    ppid="$(awk '/^PPid:/ {print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
    if [[ -z "${ppid}" || "${ppid}" == "${pid}" ]]; then
      break
    fi
    pid="${ppid}"
  done
}

agv_stop_processes() {
  if [[ "$#" -lt 2 ]]; then
    echo "[common_env] Error: agv_stop_processes needs a label and at least one pattern." >&2
    return 1
  fi

  local label="$1"
  shift
  local patterns=("$@")
  local pids=()
  local skip_pids=()
  local pid

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    skip_pids+=("${pid}")
  done < <(_agv_current_process_tree_pids)

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    if printf '%s\n' "${skip_pids[@]}" | grep -qx "${pid}"; then
      continue
    fi
    pids+=("${pid}")
  done < <(_agv_collect_pids_by_pattern "${patterns[@]}")

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "[${label}] Found stale processes from an earlier run:"
  ps -fp "${pids[@]}" || true
  echo "[${label}] Stopping stale processes before launch..."
  kill "${pids[@]}" 2>/dev/null || true

  local waited=0
  local alive=0
  while [[ "${waited}" -lt 10 ]]; do
    alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then
        alive=1
        break
      fi
    done
    if [[ "${alive}" -eq 0 ]]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  local stubborn=()
  for pid in "${pids[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      stubborn+=("${pid}")
    fi
  done

  if [[ "${#stubborn[@]}" -gt 0 ]]; then
    echo "[${label}] Forcing shutdown of stubborn processes: ${stubborn[*]}"
    kill -9 "${stubborn[@]}" 2>/dev/null || true
    sleep 1
  fi
}
