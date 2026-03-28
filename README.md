# AGV Digital Twin - Port Harbour Simulation

A ROS2 + Gazebo + Web-based Digital Twin system for Port AGV simulation with real-time visualization.

## Project Structure

```
.
├── ros_gz_project_template/     # ROS2 + Gazebo simulation (diff_drive AGV)
├── harbour_assets_description/  # Port harbour 3D models and assets
├── web_dashboard/               # Flask + Socket.IO web visualization
├── Gazebo_Harbour_Models/       # Third-party harbour model repository (reference only)
├── docs/                        # Documentation
└── CLAUDE.md                    # AI assistant guidance
```

## Quick Start

### Prerequisites

- Ubuntu 22.04
- ROS2 Humble
- Gazebo Fortress (Ignition Gazebo)
- Python 3.10+

### 1. Build the Workspace

```bash
# Source ROS2
source /opt/ros/humble/setup.bash

# Build all packages
colcon build --symlink-install

# Source the workspace
source install/setup.bash
```

### 2. Launch Harbour Simulation

```bash
# Terminal 1: Launch Gazebo with harbour scene
ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py
```

### 3. Start Web Dashboard

```bash
# Terminal 2: Start Flask backend
cd web_dashboard
./start_server.sh
```

### 4. Access Dashboard

Open browser: `http://localhost:5000`

## Features

### Simulation
- Differential drive AGV in port harbour environment
- Static harbour models (cranes, containers, port facilities)
- Real-time odometry and sensor data via ROS2

### Web Dashboard
- Real-time AGV position tracking
- Trajectory visualization
- Risk heatmap overlay
- Offline operation (no external CDN dependencies)

## Development

### Testing ROS2 Topics

```bash
# List topics
ros2 topic list | grep diff_drive

# Echo odometry
ros2 topic echo /diff_drive/odometry --once

# Check topic frequency
ros2 topic hz /diff_drive/odometry

# Control AGV
ros2 topic pub /diff_drive/cmd_vel geometry_msgs/msg/Twist \
  "{linear: {x: 1.0}, angular: {z: 0.5}}"
```

### Testing Web API

```bash
# Check vehicle state
curl http://localhost:5000/vehicle_state

# Check trajectory
curl http://localhost:5000/trajectory

# Check heatmap
curl http://localhost:5000/risk/heatmap
```

## Architecture

```
Gazebo Simulation (harbour_diff_drive.sdf)
    ↓ ros_gz_bridge
ROS2 Topics (/diff_drive/odometry, /diff_drive/cmd_vel, etc.)
    ↓ rclpy subscription
Flask Backend (ROS2 Node + Web Server)
    ↓ Socket.IO (WebSocket/Polling)
Web Dashboard (Browser)
```

## Current Stage

**Phase 1: Minimal Viable Integration** ✓
- ✅ Harbour static models integrated
- ✅ diff_drive AGV operational
- ✅ Web dashboard connected
- ✅ Offline operation enabled

**Phase 2: Advanced Features** (Future)
- ⏳ InSAR risk assessment
- ⏳ GNSS integration
- ⏳ Dynamic terrain deformation
- ⏳ Multi-vehicle coordination

## Documentation

- [Integration Plan](docs/integration_plan.md) - Current phase objectives
- [CLAUDE.md](CLAUDE.md) - AI assistant guidance
- [AGENTS.md](AGENTS.md) - Development rules and constraints
- [Web Dashboard README](web_dashboard/README_OFFLINE.md) - Frontend setup

## License

See individual component licenses.

## Contributing

See [AGENTS.md](AGENTS.md) for development guidelines and constraints.
