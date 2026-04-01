# Architecture — Port AGV Digital Twin

## Module Overview

### 1. Gazebo Simulation (`ros_gz_project_template/`)

The simulation layer. Contains robot models, world files, launch files, and bridge configs.

- **harbour_diff_drive.sdf** — Main world with harbour scene, crane, containers, and agv_ackermann (diff_drive removed)
- **agv_ackermann/model.sdf** — Ackermann-steered port truck (10 ton, 3m wheelbase)
- **harbour_diff_drive.launch.py** — Launches Gazebo + ros_gz_bridge + RViz
- **ros_gz_agv_ackermann_bridge.yaml** — Maps Gazebo ↔ ROS2 topics for agv_ackermann

Status: read-only base (modifications only for vehicle model tuning).

### 2. Harbour Assets (`harbour_assets_description/`)

Custom ROS2 package that provides port 3D models (crane1, container40, container-multi-stack) to Gazebo via `GZ_SIM_RESOURCE_PATH` environment hooks.

### 3. Flask Backend (`web_dashboard/app.py`)

Hybrid ROS2 + Web server:

- **Main thread**: Flask-SocketIO (threading mode, NOT eventlet)
- **Background thread**: `rclpy.spin()` running AGVPoseSubscriber
- **Data flow**: `/agv/odometry` → risk_layer → risk_fusion → Socket.IO emit + REST
- **Control bridge**: Publishes to `/agv/control_cmd` and `/agv/mission_cmd` on behalf of browser

### 4. Risk Pipeline (`web_dashboard/risk_layer.py`, `risk_fusion.py`)

Development-period synthetic risk assessment:

- `risk_layer.py` — 200x200 static risk grid with port hotspots (crane zone, container stack, harbour edge)
- `risk_fusion.py` — Combines terrain risk + gradient magnitude → `risk_score` (0-1) + `risk_state` (safe/warn/danger)

### 5. Manual Controller (`agv_manual_controller.py`)

Persistent-state Ackermann controller. The **sole publisher** of `/agv/cmd_vel`.

- Accepts commands via keyboard (terminal) OR `/agv/control_cmd` topic (remote)
- Maintains `target_speed` and `target_steer_angle` independently
- Rate-limited output (max_accel, max_steer_rate) for smooth motion
- Ackermann conversion: `angular.z = speed × tan(steer) / wheel_base`

### 6. Mission Controller (`web_dashboard/agv_mission_controller.py`)

Waypoint-following autopilot for demo routes:

- Subscribes to `/agv/odometry` for vehicle pose
- Receives mission commands via `/agv/mission_cmd`
- Publishes high-level commands to `/agv/control_cmd` (consumed by manual controller)
- Proportional heading control + distance-based speed modulation
- Publishes status to `/agv/mission_status`

### 7. Frontend (`web_dashboard/templates/dashboard.html`)

Single-page Leaflet + Socket.IO dashboard:

- CRS.Simple (direct meter coordinates from Gazebo)
- Real-time vehicle marker with rotation
- Trajectory polyline
- Risk heatmap overlay
- Vehicle control pad (buttons + keyboard W/S/A/D)
- Demo route buttons + mission status display

## Topic Map

```
/agv/cmd_vel          Twist       manual_controller → Gazebo
/agv/odometry         Odometry    Gazebo → app.py, mission_controller
/agv/control_cmd      String      app.py, mission_controller → manual_controller
/agv/mission_cmd      String      app.py → mission_controller
/agv/mission_status   String      mission_controller → app.py
```

## Threading Model

```
app.py process:
  Main thread:     Flask-SocketIO server (port 5000)
  Background:      rclpy.spin(AGVPoseSubscriber)
  Shared state:    vehicle_state{}, trajectory_history, mission_state{}
  Lock:            state_lock (threading.Lock)

agv_manual_controller process:
  Main thread:     keyboard loop (or rclpy.spin in headless mode)
  Timer callback:  _publish() at 20 Hz → /agv/cmd_vel

agv_mission_controller process:
  Main thread:     rclpy.spin()
  Timer callbacks: _control_loop() at 10 Hz, _publish_status() at 2 Hz
```
