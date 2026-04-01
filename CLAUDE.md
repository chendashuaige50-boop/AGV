# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Port AGV Digital Twin** — ROS2 Humble + Gazebo Fortress simulation with a Flask web dashboard for real-time visualization. Currently in **Phase 1: Minimal Viable Integration**.

**Primary vehicle: `agv_ackermann`** (Ackermann-steered port truck). diff_drive has been removed from the run chain and archived.

Three main components:
1. **ROS2 + Gazebo Simulation** (`ros_gz_project_template/`) — agv_ackermann in a port harbour scene.
2. **Harbour Assets** (`harbour_assets_description/`) — Custom ROS2 package providing port 3D models (crane, containers) to Gazebo via `GZ_SIM_RESOURCE_PATH`.
3. **Web Dashboard** (`web_dashboard/`) — Flask + Socket.IO + ROS2 node hybrid with control panel and mission routes.

## Architecture

```
Gazebo (harbour_diff_drive.sdf world — agv_ackermann only)
    ↓ ros_gz_bridge (config: ros_gz_agv_ackermann_bridge.yaml)
ROS2 Topics: /agv/odometry, /agv/cmd_vel, /agv/joint_states
    ↓
agv_manual_controller.py (sole /agv/cmd_vel publisher)
    ↑ /agv/control_cmd from Flask or agv_mission_controller
    ↓
web_dashboard/app.py (Flask-SocketIO, threading mode)
    ├── risk_layer.py    → static 200x200 risk grid
    └── risk_fusion.py   → risk_score + risk_state
    ↓ Socket.IO emit (vehicle_pose event)
Browser Dashboard (templates/dashboard.html)
```

**Threading model**: Main thread runs Flask-SocketIO (threading mode, NOT eventlet). Background thread runs `rclpy.spin()`. Shared state protected by `state_lock`.

## Development Commands

### Build (from workspace root `AGV_sim/src/`)

```bash
source /opt/ros/humble/setup.bash
colcon build --symlink-install
source install/setup.bash
```

### Launch Simulation

```bash
ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py
ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py rviz:=false
```

### Run Control + Web Dashboard

```bash
# Terminal 2: manual controller
python3 agv_manual_controller.py

# Terminal 3: mission controller + Flask
cd web_dashboard
python3 agv_mission_controller.py &
./start_server.sh
```

### Control AGV

```bash
# From browser: http://localhost:5000 (W/S/A/D + demo routes)
# From CLI:
ros2 topic pub --once /agv/cmd_vel geometry_msgs/msg/Twist \
  "{linear: {x: 1.0}, angular: {z: 0.3}}"
```

### Verify / Debug

```bash
ros2 topic list | grep agv
ros2 topic hz /agv/odometry
ros2 topic echo /agv/odometry --once

curl http://localhost:5000/vehicle_state
curl http://localhost:5000/mission/status
curl http://localhost:5000/risk/heatmap
```

## Important Constraints

- **Offline operation required.** All JS/CSS in `web_dashboard/static/`. No CDN.
- **Threading mode only.** Do NOT use eventlet.
- **Phase 1 scope only.** No InSAR, GNSS, dynamic terrain, multi-vehicle.
- See `AGENTS.md` for the full constraint list.

## ROS2 Topics

| Topic | Type | Direction |
|-------|------|-----------|
| `/agv/odometry` | nav_msgs/msg/Odometry | Gazebo → ROS2 |
| `/agv/cmd_vel` | geometry_msgs/msg/Twist | ROS2 → Gazebo |
| `/agv/joint_states` | sensor_msgs/msg/JointState | Gazebo → ROS2 |
| `/agv/control_cmd` | std_msgs/msg/String | Flask/mission → controller |
| `/agv/mission_cmd` | std_msgs/msg/String | Flask → mission controller |
| `/agv/mission_status` | std_msgs/msg/String | mission controller → Flask |
| `/tf` | tf2_msgs/msg/TFMessage | Gazebo → ROS2 |

Frames: `agv_ackermann/*` (from Gazebo PosePublisher), `chassis` (URDF base).

## Web API

- `GET /` — Dashboard page
- `GET /vehicle_state` — Current pose, speed, risk
- `GET /trajectory` — Up to 500 historical points
- `GET /risk/heatmap` — Risk grid data
- `POST /control/manual` — `{"action":"speed_up"}` etc.
- `POST /control/stop` — Emergency stop
- `POST /mission/start` — `{"route_name":"standard_operation"}`
- `GET /mission/status` — Mode, route, progress

## Configuration

- `web_dashboard/config.yaml` — Server port, ROS2 topic, map settings
- `web_dashboard/config/demo_routes.yaml` — Predefined waypoint routes
- `agv_manual_config.yaml` — Controller limits (wheel_base, max_speed, etc.)
- `ros_gz_example_bringup/config/ros_gz_agv_ackermann_bridge.yaml` — Gazebo↔ROS2 bridge

## Environment

- Ubuntu 22.04, ROS2 Humble, Gazebo Fortress, Python 3.10+
- Python packages: flask, flask-cors, flask-socketio, pyyaml, rclpy, nav_msgs
