# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Port AGV Digital Twin** system that integrates ROS2 Humble, Gazebo Fortress simulation, and a web-based dashboard for real-time visualization. The system consists of two main components:

1. **ROS2 + Gazebo Simulation** (`ros_gz_project_template/`) - A differential drive AGV simulation
2. **Flask Web Dashboard** (`backend/`) - Real-time web visualization with Socket.IO

## Architecture

### Data Flow
```
Gazebo Simulation (diff_drive model)
    ↓ publishes via ros_gz_bridge
ROS2 Topic: /diff_drive/odometry (nav_msgs/msg/Odometry)
    ↓ subscribed by
Flask Backend (ROS2 Node: agv_pose_subscriber)
    ↓ emits via Socket.IO
Web Dashboard (Browser)
```

### Key Integration Points

- **ros_gz_bridge**: Bridges Gazebo topics to ROS2 topics (configured in `ros_gz_project_template/ros_gz_example_bringup/config/ros_gz_example_bridge.yaml`)
- **Flask ROS2 Node**: `backend/app.py` runs both Flask-SocketIO server and ROS2 node in separate threads
- **Thread Safety**: Global `vehicle_state` and `trajectory_history` protected by `state_lock` for cross-thread access

### Backend Architecture (`backend/app.py`)

The Flask backend is a **hybrid ROS2/Web application**:

- **Main Thread**: Flask-SocketIO server (threading mode, NOT eventlet)
- **Background Thread**: ROS2 executor (`rclpy.spin()`) running `AGVPoseSubscriber` node
- **Communication**: ROS2 callbacks update global state, Socket.IO emits to all connected clients

**Critical**: The backend MUST be run with ROS2 environment sourced. It will start even without ROS2, but won't receive data.

## Development Commands

### Building and Running the Simulation

```bash
# Build ROS2 workspace (from ros_gz_project_template/)
cd ros_gz_project_template
source /opt/ros/humble/setup.bash
colcon build
source install/setup.bash

# Launch Gazebo simulation with diff_drive AGV
ros2 launch ros_gz_example_bringup diff_drive.launch.py
```

### Running the Web Dashboard

```bash
# Start Flask backend (MUST source ROS2 first)
cd backend
source /opt/ros/humble/setup.bash
python3 app.py

# Or use the startup script
./start_server.sh
```

Access dashboard at: `http://localhost:5000`

### Testing and Debugging

```bash
# Check if ROS2 topics are publishing
source /opt/ros/humble/setup.bash
ros2 topic list | grep diff_drive
ros2 topic echo /diff_drive/odometry --once
ros2 topic hz /diff_drive/odometry

# Test Flask REST API
curl http://localhost:5000/vehicle_state
curl http://localhost:5000/trajectory
curl http://localhost:5000/risk/heatmap

# Check if Flask is running
ps aux | grep "python3 app.py"
ss -tuln | grep 5000

# Test Socket.IO connection
curl 'http://localhost:5000/socket.io/?EIO=4&transport=polling'
```

### Controlling the AGV

```bash
# Publish velocity commands to move the AGV
ros2 topic pub /diff_drive/cmd_vel geometry_msgs/msg/Twist \
  "{linear: {x: 1.0, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.5}}"
```

## Important Constraints

### DO NOT Modify ros_gz_project_template

The `ros_gz_project_template/` directory is a **read-only reference**. All integration work must be done in `backend/`. You can:
- ✅ Read files to understand topic names, message types, frame IDs
- ✅ Subscribe to its published topics
- ❌ Modify launch files, configs, or code inside it

### Offline Operation

The dashboard is designed to work **without internet access**:
- All JavaScript libraries (Leaflet.js, Socket.IO) are in `backend/static/`
- Map tiles use a simple canvas background instead of OpenStreetMap
- Total static assets: ~248KB

If adding new frontend dependencies, download them to `static/` and use Flask's `url_for('static', filename='...')`.

### Flask-SocketIO Threading Mode

**Critical**: The backend uses **threading mode**, NOT eventlet:
- Do NOT import or use `eventlet`
- Do NOT use `async_mode='eventlet'`
- Socket.IO emits from ROS2 callbacks use `socketio.emit(..., namespace='/')`

## ROS2 Topics Reference

### Published by Gazebo (via ros_gz_bridge)

- `/diff_drive/odometry` (nav_msgs/msg/Odometry) - AGV pose and velocity
- `/diff_drive/scan` (sensor_msgs/msg/LaserScan) - LIDAR data
- `/joint_states` (sensor_msgs/msg/JointState) - Joint positions
- `/tf` (tf2_msgs/msg/TFMessage) - Transform tree
- `/clock` (rosgraph_msgs/msg/Clock) - Simulation time

### Subscribed by Gazebo

- `/diff_drive/cmd_vel` (geometry_msgs/msg/Twist) - Velocity commands

### Frames

- `diff_drive/odom` - Odometry frame
- `diff_drive` - Robot base frame
- `diff_drive/lidar_link` - LIDAR sensor frame

## REST API Endpoints

- `GET /` - Serves dashboard.html
- `GET /vehicle_state` - Current AGV state (pose, speed, risk_index)
- `GET /trajectory` - Historical trajectory points (max 500)
- `GET /risk/heatmap` - Simulated risk heatmap data

## Socket.IO Events

- **Client → Server**: `connect`, `disconnect`
- **Server → Client**: `vehicle_pose` - Real-time AGV position updates
  ```json
  {
    "x": float,
    "y": float,
    "heading": float,  // degrees [0, 360)
    "risk": float      // [0.0, 1.0]
  }
  ```

## Common Issues

### "Connecting..." in Dashboard
- Ensure Flask server is running with ROS2 environment sourced
- Check browser console (F12) for Socket.IO connection errors
- Verify port 5000 is not blocked: `ss -tuln | grep 5000`

### No Real-Time Data Updates
- Ensure Gazebo simulation is running
- Verify ROS2 topic is publishing: `ros2 topic hz /diff_drive/odometry`
- Check Flask terminal for "Emitting pose data" messages

### Page Won't Load Without Proxy
- All external CDN resources have been downloaded to `backend/static/`
- If page still won't load, check that static files exist: `ls -lh backend/static/js/`

## Environment

- **OS**: Ubuntu 22.04
- **ROS2**: Humble
- **Gazebo**: Fortress
- **Python**: 3.10+
- **Required Python packages**: flask, flask-cors, flask-socketio, rclpy, nav_msgs
