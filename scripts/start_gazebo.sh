#!/bin/bash
# Start Gazebo simulation with harbour world and agv_ackermann
set -eo pipefail

SRC_DIR="/home/loong/AGV_sim/src"

set +u
source /opt/ros/humble/setup.bash
source "${SRC_DIR}/install/setup.bash"
set -u

echo "[start_gazebo] Launching Gazebo harbour simulation..."
ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py
