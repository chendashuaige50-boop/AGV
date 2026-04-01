# Port AGV Digital Twin — Harbour Simulation

ROS 2 Humble + Gazebo Fortress + Flask + Leaflet real-time digital twin for port AGV simulation.

**Current primary vehicle: `agv_ackermann`** (Ackermann-steered port truck)

## Project Structure

```
AGV_sim/src/
├── web_dashboard/                  # Flask + Socket.IO backend & frontend
│   ├── app.py                      #   Main server (ROS2 node + REST + WebSocket)
│   ├── risk_layer.py               #   Synthetic risk grid
│   ├── risk_fusion.py              #   Risk assessment fusion
│   ├── agv_mission_controller.py   #   Waypoint-following mission executor
│   ├── config.yaml                 #   Server & ROS2 topic config
│   ├── config/demo_routes.yaml     #   Predefined demo routes
│   ├── start_server.sh             #   Startup script
│   ├── templates/dashboard.html    #   Dashboard UI
│   └── static/                     #   Leaflet, Socket.IO (offline)
│
├── agv_manual_controller.py        # Persistent-state manual Ackermann controller
├── agv_manual_config.yaml          # Controller config (wheel_base, limits, steps)
│
├── ros_gz_project_template/        # ROS2 + Gazebo simulation packages (read-only base)
│   ├── ros_gz_example_bringup/     #   Launch files + bridge configs
│   ├── ros_gz_example_description/ #   Robot models (agv_ackermann + archived diff_drive)
│   └── ros_gz_example_gazebo/      #   World files (harbour scene)
│
├── harbour_assets_description/     # Custom ROS2 package — port 3D models
│   └── models/                     #   crane1, container40, container-multi-stack
│
├── docs/                           # Documentation
├── scripts/                        # Verification & utility scripts
├── third_party/                    # Third-party reference repos
└── archive_pending_review/         # Archived deprecated files
```

## Quick Start

### Prerequisites

- Ubuntu 22.04, ROS 2 Humble, Gazebo Fortress, Python 3.10+
- Python packages: flask, flask-cors, flask-socketio, pyyaml

### 1. Build

```bash
cd AGV_sim/src
source /opt/ros/humble/setup.bash
colcon build --symlink-install
source install/setup.bash
```

### 2. Launch Gazebo

```bash
ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py
```

### 3. Start Control Layer

```bash
# Terminal 2: manual controller (accepts keyboard + remote commands)
python3 agv_manual_controller.py
```

### 4. Start Web Dashboard

```bash
# Terminal 3: Flask backend + mission controller
cd web_dashboard
python3 agv_mission_controller.py &
./start_server.sh
```

### 5. Open Dashboard

Browser: `http://localhost:5000`

- **Vehicle Control** panel: W/S/A/D + SPACE/R/Q (keyboard or buttons)
- **Demo Routes**: one-click predefined waypoint routes
- **Risk Heatmap**: real-time risk overlay

## Architecture

```
Browser (dashboard.html)
    ↓ REST + Socket.IO
Flask app.py (ROS2 node)
    ├── /control/manual  → publishes /agv/control_cmd
    ├── /mission/start   → publishes /agv/mission_cmd
    ├── subscribes: /agv/odometry, /agv/mission_status
    └── risk_layer + risk_fusion pipeline
            ↓                               ↓
agv_manual_controller          agv_mission_controller
    (sole /agv/cmd_vel publisher)    (waypoint follower)
            ↓
AckermannSteering plugin (Gazebo)
```

## Key APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/vehicle_state` | GET | Current pose, speed, risk |
| `/trajectory` | GET | Historical trajectory (max 500 pts) |
| `/risk/heatmap` | GET | Risk grid data |
| `/control/manual` | POST | `{"action":"speed_up"}` etc. |
| `/control/stop` | POST | Emergency stop |
| `/mission/start` | POST | `{"route_name":"standard_operation"}` |
| `/mission/cancel` | POST | Cancel running mission |
| `/mission/status` | GET | Current mode/route/progress |

## Documentation

- [Architecture](docs/architecture.md) — Module responsibilities
- [Run Guide](docs/run_guide.md) — Step-by-step startup
- [Quick Start](docs/quickstart.md) — Original quick start guide
- [Integration Plan](docs/integration_plan.md) — Phase 1 scope
- [Cleanup Report](docs/cleanup_report.md) — Recent file reorganization
- [CLAUDE.md](CLAUDE.md) — AI assistant guidance
- [AGENTS.md](AGENTS.md) — Development constraints

## License

See individual component licenses.
