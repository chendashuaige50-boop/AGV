#!/usr/bin/env python3
"""
Flask Backend for Port AGV Digital Twin Dashboard
Integrates ROS2 real-time data with Flask-SocketIO for web visualization.

Development-period data flow:
  Gazebo → /diff_drive/odometry → AGVPoseSubscriber
      → risk_layer.query(x, y)      [terrain_query]
      → risk_fusion.fuse(...)        [rule-based risk assessment]
      → vehicle_state{}              [shared state]
      → Socket.IO vehicle_pose       [real-time push to browser]
      → REST endpoints               [poll-based browser requests]
"""

import math
import os
import sys
import time
from collections import deque
from datetime import datetime
import threading

# ---------------------------------------------------------------------------
# FIX: Prevent python-engineio from auto-detecting eventlet.
# Even with async_mode='threading', if eventlet is importable engineio's
# async driver selection can silently pick eventlet internals, which breaks
# session management for cross-thread emit() calls (the ROS2 callback thread).
# This manifests as "Invalid session" errors and no real-time updates.
# Blocking the import before engineio loads forces pure-threading mode.
# ---------------------------------------------------------------------------
_blocked = {}
for _mod in ('eventlet', 'eventlet.wsgi', 'eventlet.green', 'eventlet.green.threading'):
    if _mod not in sys.modules:
        _blocked[_mod] = True
        sys.modules[_mod] = None          # type: ignore[assignment]

import yaml
from flask import Flask, jsonify, render_template
from flask_cors import CORS
from flask_socketio import SocketIO, emit

# Restore module entries so other code is not permanently affected
for _mod in _blocked:
    if sys.modules.get(_mod) is None:
        del sys.modules[_mod]
del _blocked

# ROS2
import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry

# Development-period risk pipeline (local modules)
import risk_layer
import risk_fusion

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)
# IMPORTANT: async_mode must be 'threading' because:
# 1. The ROS2 odometry callback runs in a background threading.Thread
# 2. socketio.emit() is called from that thread
# 3. eventlet/gevent async modes break cross-thread emit (causes "Invalid session")
# 4. threading mode allows emit() from any thread safely
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading',
                    logger=False, engineio_logger=False)

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
vehicle_state: dict = {
    # Pose (from odometry)
    'x': 0.0,
    'y': 0.0,
    'heading': 0.0,
    'speed': 0.0,
    'last_update': 0.0,
    # Scenario label
    'scenario': 'Standard Operation',
    # Risk pipeline output
    'risk_score':     0.0,
    'risk_state':     'safe',
    'warning_reason': '正常运行 / Normal operation',
    'terrain_risk':   0.0,
    'gradient_mag':   0.0,
}

trajectory_history: deque = deque(maxlen=500)
state_lock = threading.Lock()

# ROS2 topic (matches ros_gz_bridge config)
ROS2_TOPIC = '/diff_drive/odometry'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def quaternion_to_yaw(q) -> float:
    """Convert quaternion to yaw in degrees [0, 360)."""
    siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
    cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
    yaw_deg = math.degrees(math.atan2(siny_cosp, cosy_cosp))
    return yaw_deg % 360.0


# ---------------------------------------------------------------------------
# ROS2 node
# ---------------------------------------------------------------------------

class AGVPoseSubscriber(Node):
    """
    ROS2 node: subscribes to /diff_drive/odometry.

    On every message:
      1. Extract x, y, heading, speed
      2. Run terrain query  (risk_layer)
      3. Run risk fusion    (risk_fusion)
      4. Update global vehicle_state (thread-safe)
      5. Emit vehicle_pose via Socket.IO
    """

    def __init__(self):
        super().__init__('agv_pose_subscriber')
        self.subscription = self.create_subscription(
            Odometry, ROS2_TOPIC, self.odometry_callback, 10)
        self.get_logger().info(f'Subscribed to {ROS2_TOPIC}')

    def odometry_callback(self, msg: Odometry) -> None:
        # 1. Extract pose & velocity
        x = msg.pose.pose.position.x
        y = msg.pose.pose.position.y
        heading = quaternion_to_yaw(msg.pose.pose.orientation)
        vx = msg.twist.twist.linear.x
        vy = msg.twist.twist.linear.y
        speed = math.sqrt(vx**2 + vy**2)

        # 2. Terrain query (development: synthetic risk grid, fast in-memory)
        tq = risk_layer.query(x, y)

        # 3. Risk fusion (development: rule-based)
        rf = risk_fusion.fuse(
            {'x': x, 'y': y, 'speed': speed, 'heading': heading},
            tq,
        )

        # 4. Update shared state (thread-safe)
        with state_lock:
            vehicle_state['x']              = x
            vehicle_state['y']              = y
            vehicle_state['heading']        = heading
            vehicle_state['speed']          = speed
            vehicle_state['last_update']    = time.time()
            vehicle_state['risk_score']     = rf['risk_score']
            vehicle_state['risk_state']     = rf['risk_state']
            vehicle_state['warning_reason'] = rf['warning_reason']
            vehicle_state['terrain_risk']   = rf['terrain_risk']
            vehicle_state['gradient_mag']   = rf['gradient_mag']
            trajectory_history.append({'x': x, 'y': y, 'timestamp': time.time()})

        # 5. Emit real-time update to all browser clients
        socketio.emit('vehicle_pose', {
            'x':          x,
            'y':          y,
            'heading':    heading,
            'speed':      speed,
            'risk':       rf['risk_score'],   # continuous 0-1
            'risk_state': rf['risk_state'],   # safe/warn/danger
            'warning':    rf['warning_reason'],
        }, namespace='/')


def _ros2_spin(node: Node) -> None:
    """Run ROS2 executor in background thread (non-blocking for Flask)."""
    try:
        rclpy.spin(node)
    except Exception as exc:
        print(f'[ROS2] spin error: {exc}')
    finally:
        node.destroy_node()


def initialize_ros2():
    """Init ROS2 node; return node or None on failure."""
    try:
        rclpy.init()
        node = AGVPoseSubscriber()
        t = threading.Thread(target=_ros2_spin, args=(node,), daemon=True)
        t.start()
        print('✓ ROS2 node initialised – subscribed to', ROS2_TOPIC)
        return node
    except Exception as exc:
        print(f'✗ ROS2 init failed: {exc}')
        print('  Flask will run without real-time robot data.')
        return None


# ---------------------------------------------------------------------------
# Cached heatmap (built once at startup)
# ---------------------------------------------------------------------------
_heatmap_cache: list | None = None


def _get_heatmap() -> list:
    global _heatmap_cache
    if _heatmap_cache is None:
        _heatmap_cache = risk_layer.get_heatmap_data(step=4)
    return _heatmap_cache


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('dashboard.html')


@app.route('/health')
def health():
    """Health check – for startup verification and monitoring."""
    with state_lock:
        last_update = vehicle_state['last_update']

    ros2_ok = (last_update > 0) and ((time.time() - last_update) < 5.0)

    return jsonify({
        'status':            'ok',
        'ros2_active':       ros2_ok,
        'last_odom_age_s':   round(time.time() - last_update, 2) if last_update > 0 else None,
        'risk_layer':        'synthetic_grid',
        'risk_fusion':       'rule_based',
        'endpoints': [
            '/vehicle_state', '/trajectory',
            '/risk/current', '/risk/heatmap', '/health',
        ],
    })


@app.route('/vehicle_state')
def get_vehicle_state():
    """Current vehicle state: pose + speed + full risk assessment."""
    with state_lock:
        return jsonify({
            'pose': {
                'x':       vehicle_state['x'],
                'y':       vehicle_state['y'],
                'heading': vehicle_state['heading'],
            },
            'speed':          vehicle_state['speed'],
            'scenario':       vehicle_state['scenario'],
            'timestamp':      vehicle_state['last_update'],
            'risk_index':     vehicle_state['risk_score'],   # compat alias
            'risk_score':     vehicle_state['risk_score'],
            'risk_state':     vehicle_state['risk_state'],
            'warning_reason': vehicle_state['warning_reason'],
            'terrain_risk':   vehicle_state['terrain_risk'],
            'gradient_mag':   vehicle_state['gradient_mag'],
        })


@app.route('/trajectory')
def get_trajectory():
    """Historical trajectory points (max 500)."""
    with state_lock:
        return jsonify(list(trajectory_history))


@app.route('/risk/current')
def get_risk_current():
    """Current risk assessment at vehicle position."""
    with state_lock:
        x     = vehicle_state['x']
        y     = vehicle_state['y']
        speed = vehicle_state['speed']
        hdg   = vehicle_state['heading']

    tq = risk_layer.query(x, y)
    rf = risk_fusion.fuse({'x': x, 'y': y, 'speed': speed, 'heading': hdg}, tq)
    return jsonify({
        'position':       {'x': round(x, 3), 'y': round(y, 3)},
        'risk_score':     rf['risk_score'],
        'risk_state':     rf['risk_state'],
        'warning_reason': rf['warning_reason'],
        'terrain_risk':   rf['terrain_risk'],
        'gradient_mag':   rf['gradient_mag'],
    })


@app.route('/risk/heatmap')
def get_risk_heatmap():
    """
    Risk heatmap data for Leaflet overlay.
    Returns real data from risk_layer (synthetic grid for development period).
    TODO: replace risk_layer backend with real GeoTIFF loader.
    """
    return jsonify(_get_heatmap())


@app.route('/risk/heatmap/refresh')
def refresh_heatmap():
    """Force rebuild heatmap cache (useful after hot-swapping risk layer data)."""
    global _heatmap_cache
    _heatmap_cache = None
    data = _get_heatmap()
    return jsonify({'status': 'refreshed', 'points': len(data)})


# ---------------------------------------------------------------------------
# Socket.IO events
# ---------------------------------------------------------------------------

@socketio.on('connect')
def handle_connect():
    print(f'[WS] client connected {datetime.now().isoformat()}')
    with state_lock:
        emit('vehicle_pose', {
            'x':          vehicle_state['x'],
            'y':          vehicle_state['y'],
            'heading':    vehicle_state['heading'],
            'speed':      vehicle_state['speed'],
            'risk':       vehicle_state['risk_score'],
            'risk_state': vehicle_state['risk_state'],
            'warning':    vehicle_state['warning_reason'],
        })


@socketio.on('disconnect')
def handle_disconnect():
    print(f'[WS] client disconnected {datetime.now().isoformat()}')


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    print('=' * 60)
    print('🚛  AGV Digital Twin – Development Period Backend')
    print('=' * 60)
    print('  http://localhost:5000')
    print()
    print('  Endpoints:')
    print('    GET  /                 Dashboard UI')
    print('    GET  /health           System health check')
    print('    GET  /vehicle_state    Pose + speed + risk assessment')
    print('    GET  /trajectory       Historical path (max 500 pts)')
    print('    GET  /risk/current     Risk at current position')
    print('    GET  /risk/heatmap     Full risk grid for Leaflet')
    print('    WS   /socket.io/       Real-time vehicle_pose events')
    print()
    print('  Pipeline:')
    print('    /diff_drive/odometry → terrain_query → risk_fusion → WS push')
    print('=' * 60)

    ros_node = initialize_ros2()

    if not ros_node:
        print('⚠  Running without ROS2 – vehicle position stays at (0, 0)')

    print('\nPress Ctrl+C to stop.\n')

    try:
        # use_reloader=False: prevents Werkzeug from spawning a second process
        # (reloader would create 2 instances → duplicate ROS2 nodes → session chaos)
        socketio.run(app, host='0.0.0.0', port=5000,
                     allow_unsafe_werkzeug=True, use_reloader=False)
    except KeyboardInterrupt:
        print('\nShutting down…')
    finally:
        if ros_node:
            rclpy.shutdown()
