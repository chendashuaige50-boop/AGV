#!/usr/bin/env python3
"""
Flask Backend for Port AGV Digital Twin Dashboard
Integrates ROS2 real-time data with Flask-SocketIO for web visualization
"""

from flask import Flask, jsonify, render_template
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import threading
import math
import time
from datetime import datetime
from collections import deque

# ROS2 imports
import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry

app = Flask(__name__)
CORS(app)

# Initialize Socket.IO with threading mode (default)
socketio = SocketIO(app, cors_allowed_origins="*", logger=True, engineio_logger=True)

# Global vehicle state (thread-safe access)
vehicle_state = {
    'x': 0.0,
    'y': 0.0,
    'heading': 0.0,
    'speed': 0.0,
    'risk_index': 0.1,
    'scenario': 'Standard Operation',
    'last_update': 0.0
}

trajectory_history = deque(maxlen=500)
state_lock = threading.Lock()

# ROS2 configuration - subscribes to AGV odometry from ros_gz_bridge
ROS2_TOPIC = '/diff_drive/odometry'
ROS2_MSG_TYPE = 'nav_msgs/msg/Odometry'


# ============================================================================
# ROS2 Integration Section
# ============================================================================

def quaternion_to_yaw(q):
    """
    Convert quaternion to yaw angle (heading)

    Quaternion → Euler angle conversion for extracting heading from orientation

    Args:
        q: Quaternion with x, y, z, w components

    Returns:
        yaw angle in degrees [0, 360)
    """
    siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
    cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
    yaw_rad = math.atan2(siny_cosp, cosy_cosp)

    # Convert to degrees and normalize to [0, 360)
    yaw_deg = math.degrees(yaw_rad)
    if yaw_deg < 0:
        yaw_deg += 360.0

    return yaw_deg


class AGVPoseSubscriber(Node):
    """
    ROS2 Node for subscribing to AGV pose data from Gazebo simulation

    Gazebo Pose Subscription:
    
    - Subscribes to /diff_drive/odometry (bridged from Gazebo via ros_gz_bridge)
    - Extracts position (x, y), orientation (quaternion → yaw), and velocity
    - Emits real-time data to Socket.IO clients
    """

    def __init__(self):
        super().__init__('agv_pose_subscriber')

        # Subscribe to odometry topic from ros_gz_bridge
        self.subscription = self.create_subscription(
            Odometry,
            ROS2_TOPIC,
            self.odometry_callback,
            10
        )

        self.get_logger().info(f'Subscribed to {ROS2_TOPIC}')
        self.get_logger().info('Waiting for AGV odometry data from Gazebo...')

    def odometry_callback(self, msg):
        """
        Callback for odometry messages from Gazebo

        Processes incoming ROS2 Odometry messages:
        1. Extract x, y position
        2. Convert quaternion orientation to yaw (heading)
        3. Calculate linear velocity magnitude (speed)
        4. Update global state (thread-safe)
        5. Emit to Socket.IO clients
        """
        global vehicle_state, trajectory_history

        # Extract position (x, y) from pose
        x = msg.pose.pose.position.x
        y = msg.pose.pose.position.y

        # Extract orientation and convert quaternion to yaw (heading)
        q = msg.pose.pose.orientation
        heading = quaternion_to_yaw(q)

        # Extract linear velocity magnitude (speed)
        vx = msg.twist.twist.linear.x
        vy = msg.twist.twist.linear.y
        speed = math.sqrt(vx**2 + vy**2)

        # Update global vehicle state (thread-safe)
        with state_lock:
            vehicle_state['x'] = x
            vehicle_state['y'] = y
            vehicle_state['heading'] = heading
            vehicle_state['speed'] = speed
            vehicle_state['last_update'] = time.time()

            # Update trajectory history
            trajectory_history.append({
                'x': x,
                'y': y,
                'timestamp': time.time()
            })

        # Socket.IO Emission: Emit real-time pose data to all connected clients
        pose_data = {
            'x': x,
            'y': y,
            'heading': heading,
            'risk': vehicle_state['risk_index']
        }

        # Emit to all connected clients
        print(f"Emitting pose data: x={x:.2f}, y={y:.2f}, heading={heading:.2f}")
        socketio.emit('vehicle_pose', pose_data, namespace='/')


def ros2_spin_thread(node):
    """
    Run ROS2 executor in background thread

    Threading: Keeps ROS2 node alive and processing callbacks without blocking Flask
    """
    try:
        rclpy.spin(node)
    except Exception as e:
        print(f'ROS2 spin error: {e}')
    finally:
        node.destroy_node()


def initialize_ros2():
    """
    Initialize ROS2 node and start background thread

    Returns:
        ROS2 node instance or None if initialization fails
    """
    try:
        rclpy.init()
        node = AGVPoseSubscriber()

        # Start ROS2 executor in background thread (non-blocking)
        ros_thread = threading.Thread(target=ros2_spin_thread, args=(node,), daemon=True)
        ros_thread.start()

        print(f'✓ ROS2 node initialized and subscribed to {ROS2_TOPIC}')
        return node

    except Exception as e:
        print(f'✗ Failed to initialize ROS2: {e}')
        print('  WARNING: ROS2 integration unavailable')
        print('  Possible causes:')
        print('    - ROS2 environment not sourced')
        print('    - ros_gz_bridge not running')
        print('    - Gazebo simulation not started')
        print('  Flask server will continue without ROS2 data')
        return None


# ============================================================================
# Flask REST API Endpoints
# ============================================================================

@app.route('/')
def index():
    """Root endpoint - serve dashboard"""
    return render_template('dashboard.html')


@app.route('/vehicle_state')
def get_vehicle_state():
    """
    GET /vehicle_state
    Returns current vehicle state including pose, speed, and risk index
    Data sourced from ROS2 /diff_drive/odometry topic
    """
    with state_lock:
        return jsonify({
            'pose': {
                'x': vehicle_state['x'],
                'y': vehicle_state['y'],
                'heading': vehicle_state['heading']
            },
            'speed': vehicle_state['speed'],
            'risk_index': vehicle_state['risk_index'],
            'scenario': vehicle_state['scenario'],
            'timestamp': vehicle_state['last_update']
        })


@app.route('/trajectory')
def get_trajectory():
    """
    GET /trajectory
    Returns historical trajectory points from ROS2 odometry
    """
    with state_lock:
        return jsonify(list(trajectory_history))


@app.route('/risk/heatmap')
def get_risk_heatmap():
    """
    GET /risk/heatmap
    Returns risk heatmap data for visualization
    TODO: Replace with actual InSAR risk data or geospatial risk analysis
    """
    import random

    # Generate sample heatmap data points
    heatmap_data = []

    # Create a grid of risk points around the simulation area
    grid_size = 20
    simulation_area_size = 100.0

    for i in range(grid_size):
        for j in range(grid_size):
            x = (i - grid_size/2) * (simulation_area_size / grid_size) * 2
            y = (j - grid_size/2) * (simulation_area_size / grid_size) * 2

            # Simulate risk hotspots with distance-based risk
            distance_to_center = math.sqrt(x**2 + y**2)
            risk = max(0.0, min(1.0, 0.5 + 0.3 * math.sin(distance_to_center / 20)))

            # Add some random variation
            risk += random.uniform(-0.2, 0.2)
            risk = max(0.0, min(1.0, risk))

            heatmap_data.append({
                'x': x,
                'y': y,
                'risk': risk
            })

    return jsonify(heatmap_data)


# ============================================================================
# Socket.IO Event Handlers
# ============================================================================

@socketio.on('connect')
def handle_connect():
    """Handle WebSocket client connection"""
    print(f'Client connected: {datetime.now().isoformat()}')

    # Send initial vehicle pose
    with state_lock:
        emit('vehicle_pose', {
            'x': vehicle_state['x'],
            'y': vehicle_state['y'],
            'heading': vehicle_state['heading'],
            'risk': vehicle_state['risk_index']
        })


@socketio.on('disconnect')
def handle_disconnect():
    """Handle WebSocket client disconnection"""
    print(f'Client disconnected: {datetime.now().isoformat()}')


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == '__main__':
    print("=" * 60)
    print("🚛 AGV Digital Twin Backend Server")
    print("=" * 60)
    print(f"Starting server at http://0.0.0.0:5000")
    print(f"Dashboard: http://localhost:5000")
    print(f"WebSocket endpoint: ws://localhost:5000/socket.io/")
    print("=" * 60)
    print("\nROS2 Integration:")
    print(f"  Topic: {ROS2_TOPIC}")
    print(f"  Type:  {ROS2_MSG_TYPE}")
    print(f"  Model: diff_drive (from ros_gz_project_template)")
    print("=" * 60)
    print("\nAvailable endpoints:")
    print("  GET  /                 - Dashboard UI")
    print("  GET  /vehicle_state    - Current vehicle state")
    print("  GET  /trajectory       - Historical trajectory")
    print("  GET  /risk/heatmap     - Risk heatmap data")
    print("  WS   /socket.io/       - Real-time vehicle pose")
    print("=" * 60)

    # Initialize ROS2 integration
    print("\nInitializing ROS2 integration...")
    ros_node = initialize_ros2()

    if ros_node:
        print("✓ ROS2 integration active - receiving data from Gazebo")
    else:
        print("✗ ROS2 integration unavailable - Flask server running without ROS2")

    print("\nPress Ctrl+C to stop the server\n")
    print("=" * 60)

    # Run Flask-SocketIO server with threading mode
    try:
        socketio.run(app, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True, debug=True)
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        if ros_node:
            rclpy.shutdown()
