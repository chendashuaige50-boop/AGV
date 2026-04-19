#!/usr/bin/env python3
"""
Flask Backend for Port AGV Digital Twin Dashboard
Integrates ROS2 real-time data with Flask-SocketIO for web visualization.

Development-period data flow:
  Gazebo → /agv/odometry → AGVPoseSubscriber
      → risk_layer.query(x, y)      [terrain_query]
      → risk_fusion.fuse(...)        [rule-based risk assessment]
      → vehicle_state{}              [shared state]
      → Socket.IO agv_state          [real-time push to browser]
      → REST endpoints               [poll-based compatibility requests]

Unified API layer (/api/*) added for MVP cockpit.
Legacy endpoints preserved for backward compatibility.
"""

import math
import os
import socket
import sys
import time
from collections import deque
from datetime import datetime
import threading

# ---------------------------------------------------------------------------
# FIX: Prevent python-engineio from auto-detecting eventlet.
# ---------------------------------------------------------------------------
_blocked = {}
for _mod in ('eventlet', 'eventlet.wsgi', 'eventlet.green', 'eventlet.green.threading'):
    if _mod not in sys.modules:
        _blocked[_mod] = True
        sys.modules[_mod] = None          # type: ignore[assignment]

import yaml
from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit

for _mod in _blocked:
    if sys.modules.get(_mod) is None:
        del sys.modules[_mod]
del _blocked

# ROS2
import json
import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from nav_msgs.msg import Odometry
from std_msgs.msg import String

# Development-period risk pipeline (local modules)
import risk_layer
import risk_fusion

# InSAR deformation provider
from deformation_provider.zhoukou_provider import ZhoukouProvider
from deformation_provider.coord_transform import sim_to_wgs84
_insar_provider = ZhoukouProvider()

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = Flask(__name__)
socketio = SocketIO(app, async_mode='threading',
                    logger=False, engineio_logger=False)

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
vehicle_state: dict = {
    'x': 0.0, 'y': 0.0, 'heading': 0.0, 'speed': 0.0,
    'last_update': 0.0,
    'scenario': 'Standard Operation',
    'risk_score': 0.0, 'risk_state': 'safe',
    'warning_reason': '正常运行 / Normal operation',
    'terrain_risk': 0.0, 'gradient_mag': 0.0,
}

trajectory_history: deque = deque(maxlen=500)
state_lock = threading.Lock()

# Mission / control state
mission_state: dict = {
    'mode': 'idle',
    'route_name': '',
    'running': False,
    'waypoint_index': 0,
    'total_waypoints': 0,
    'progress': '',
}

# Alert queue (in-memory ring buffer)
alert_history: deque = deque(maxlen=100)

# System start time
_start_time = time.time()

# Shutdown coordination for Flask main thread + ROS2 spin thread
_shutdown_event = threading.Event()
_shutdown_lock = threading.Lock()
_shutdown_started = False
_ros2_spin_thread: threading.Thread | None = None

# ---------------------------------------------------------------------------
# Alert helpers
# ---------------------------------------------------------------------------

_RISK_LEVEL_CN = {'low': '低风险', 'medium': '中风险', 'high': '高风险'}
_ALERT_LEVEL_CN = {'info': '信息', 'warn': '警告', 'critical': '严重'}

# Track last risk state to detect transitions
_last_risk_state = 'safe'


def _push_alert(level: str, title: str, message: str, agv_id: str = 'agv-001'):
    """Create an alert and push via WebSocket."""
    alert = {
        'timestamp': datetime.now().isoformat(),
        'level': level,
        'level_cn': _ALERT_LEVEL_CN.get(level, level),
        'title': title,
        'message': message,
        'agv_id': agv_id,
    }
    alert_history.append(alert)
    socketio.emit('alert_event', alert, namespace='/')


def _risk_state_to_level(rs: str) -> str:
    return {'safe': 'low', 'warn': 'medium', 'danger': 'high'}.get(rs, 'low')


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

_routes_cfg_path = os.path.join(os.path.dirname(__file__), 'config', 'demo_routes.yaml')
try:
    with open(_routes_cfg_path, 'r') as _rf:
        _routes_cfg = yaml.safe_load(_rf)
    DEMO_ROUTES = {
        name: info.get('description', name) if isinstance(info, dict) else name
        for name, info in _routes_cfg.get('demo_routes', {}).items()
    }
except Exception:
    DEMO_ROUTES = {}

_cfg_path = os.path.join(os.path.dirname(__file__), 'config.yaml')
try:
    with open(_cfg_path, 'r') as _f:
        _cfg = yaml.safe_load(_f)
except Exception:
    _cfg = {}

ROS2_TOPIC = _cfg.get('ros2', {}).get('topic', '/agv/odometry')
_server_cfg = _cfg.get('server', {})
SERVER_HOST = _server_cfg.get('host', '127.0.0.1')
SERVER_PORT = int(_server_cfg.get('port', 5000))
SERVER_DEBUG = bool(_server_cfg.get('debug', False))
_scene_cfg = _cfg.get('scene', {}) if isinstance(_cfg.get('scene'), dict) else {}


def _resolve_config_path(path_value: str | None) -> str | None:
    if not path_value:
        return None
    if os.path.isabs(path_value):
        return path_value
    return os.path.normpath(os.path.join(os.path.dirname(_cfg_path), path_value))


def _load_yaml_file(path_value: str | None) -> dict:
    resolved = _resolve_config_path(path_value)
    if not resolved:
        return {}
    try:
        with open(resolved, 'r', encoding='utf-8') as handle:
            data = yaml.safe_load(handle) or {}
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


_risk_layer_meta = risk_layer.get_scene_metadata()
_zones_cfg = _load_yaml_file(_scene_cfg.get('deformation_zones_file'))
_default_bounds = {'min_x': -200.0, 'max_x': 200.0, 'min_y': -200.0, 'max_y': 200.0}
_bounds_cfg = _scene_cfg.get('local_map_bounds', {}) if isinstance(_scene_cfg.get('local_map_bounds'), dict) else {}
LOCAL_MAP_BOUNDS = {
    key: float(_bounds_cfg.get(key, _default_bounds[key]))
    for key in _default_bounds
}
WORLD_SIZE_M = _scene_cfg.get('world_size_m', _risk_layer_meta.get('world_size_m', [400.0, 400.0]))
SCENE_PROFILE = _scene_cfg.get('profile', _risk_layer_meta.get('profile', 'simplified_port_agv_terrain_400m'))
SCENE_TITLE_CN = _scene_cfg.get('title_cn', '400m 极简实验港口场景')
SCENE_DESCRIPTION_CN = _scene_cfg.get('description_cn', '定位误差与地形/形变感知验证主场景')
DEFAULT_GAZEBO_LAUNCH = _scene_cfg.get('default_gazebo_launch', 'simplified_port_agv_terrain_400m.launch.py')
LEGACY_GAZEBO_LAUNCH = _scene_cfg.get('legacy_gazebo_launch', 'harbour_diff_drive.launch.py')
DEFORMATION_ZONES_FILE = (
    _resolve_config_path(_scene_cfg.get('deformation_zones_file'))
    or _risk_layer_meta.get('deformation_zones_file')
)
DEFORMATION_ZONES_ID = os.path.basename(DEFORMATION_ZONES_FILE) if DEFORMATION_ZONES_FILE else 'deformation_zones.yaml'
SCENE_CONTEXT = {
    'profile': SCENE_PROFILE,
    'title_cn': SCENE_TITLE_CN,
    'description_cn': SCENE_DESCRIPTION_CN,
    'world_size_m': WORLD_SIZE_M,
    'default_gazebo_launch': DEFAULT_GAZEBO_LAUNCH,
    'legacy_gazebo_launch': LEGACY_GAZEBO_LAUNCH,
    'local_map_bounds': LOCAL_MAP_BOUNDS,
    'risk_layer_mode': _risk_layer_meta.get('mode', 'synthetic_compat'),
    'deformation_zones_file': DEFORMATION_ZONES_ID,
    'corridors': _zones_cfg.get('corridors', _risk_layer_meta.get('corridors', {})),
    'zones': _zones_cfg.get('zones', _risk_layer_meta.get('zones', {})),
    'landmarks': _zones_cfg.get('landmarks', _risk_layer_meta.get('landmarks', {})),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def quaternion_to_yaw(q) -> float:
    siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
    cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
    yaw_deg = math.degrees(math.atan2(siny_cosp, cosy_cosp))
    return yaw_deg % 360.0


def _check_server_port_available(host: str, port: int) -> tuple[bool, str | None]:
    """Return whether the configured host/port can be bound by Flask."""
    bind_host = '0.0.0.0' if host in ('', '*') else host
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((bind_host, port))
    except OSError as exc:
        return False, str(exc)
    finally:
        sock.close()
    return True, None


def _build_agv_state_msg() -> dict:
    """Build unified agv_state message from current shared state."""
    with state_lock:
        mode = mission_state.get('mode', 'idle')
        return {
            'timestamp': datetime.now().isoformat(),
            'id': 'agv-001',
            'position': {
                'x': round(vehicle_state['x'], 3),
                'y': round(vehicle_state['y'], 3),
                'z': 0.0,
            },
            'orientation': {
                'roll': 0.0,
                'pitch': 0.0,
                'yaw': round(vehicle_state['heading'], 2),
            },
            'speed': round(vehicle_state['speed'], 3),
            'mode': mode,
            'source': 'ros2' if vehicle_state['last_update'] > 0 else 'mock',
        }


def _build_risk_state_msg() -> dict:
    """Build unified risk_state message."""
    with state_lock:
        rs = vehicle_state['risk_state']
        level = _risk_state_to_level(rs)
        return {
            'timestamp': datetime.now().isoformat(),
            'agv_id': 'agv-001',
            'risk_level': level,
            'risk_level_cn': _RISK_LEVEL_CN.get(level, level),
            'risk_score': vehicle_state['risk_score'],
            'risk_state': rs,
            'reasons': [vehicle_state['warning_reason']],
            'terrain_risk': vehicle_state['terrain_risk'],
            'gradient_mag': vehicle_state['gradient_mag'],
        }


def _build_system_status_msg() -> dict:
    """Build unified system_status message."""
    with state_lock:
        last_update = vehicle_state['last_update']
    ros2_ok = (last_update > 0) and ((time.time() - last_update) < 5.0)
    return {
        'backend': 'online',
        'ros2': 'online' if ros2_ok else 'offline',
        'websocket': 'connected',
        'last_update': datetime.fromtimestamp(last_update).isoformat() if last_update > 0 else None,
        'active_vehicle': 'agv_ackermann',
        'scene_profile': SCENE_PROFILE,
        'scene_title_cn': SCENE_TITLE_CN,
        'world_size_m': WORLD_SIZE_M,
        'local_map_bounds': LOCAL_MAP_BOUNDS,
        'risk_layer_mode': SCENE_CONTEXT['risk_layer_mode'],
        'uptime_s': round(time.time() - _start_time, 1),
    }


def _build_mission_status_msg() -> dict:
    """Build unified mission_status message."""
    with state_lock:
        ms = dict(mission_state)
    ms['timestamp'] = datetime.now().isoformat()
    return ms


def _ros2_context_ok(node: Node | None = None) -> bool:
    """Return whether the ROS2 context is still valid for this process."""
    context = getattr(node, 'context', None) if node is not None else None
    try:
        if context is not None:
            return rclpy.ok(context=context)
        return rclpy.ok()
    except Exception:
        return False


def _safe_destroy_node(node: Node | None) -> None:
    """Best-effort node destruction used during shutdown paths."""
    if node is None:
        return
    try:
        node.destroy_node()
    except Exception:
        pass


def _shutdown_ros2_once() -> None:
    """Centralize ROS2 cleanup so shutdown/destroy only happen once."""
    global _shutdown_started, _ros2_node, _ros2_spin_thread

    with _shutdown_lock:
        if _shutdown_started:
            return
        _shutdown_started = True
        _shutdown_event.set()
        node = _ros2_node
        spin_thread = _ros2_spin_thread
        _ros2_node = None
        _ros2_spin_thread = None

    if node is None:
        return

    if _ros2_context_ok(node):
        try:
            rclpy.shutdown(context=node.context)
        except Exception:
            pass

    if (spin_thread is not None and spin_thread.is_alive() and
            spin_thread is not threading.current_thread()):
        spin_thread.join(timeout=2.0)

    _safe_destroy_node(node)


# ---------------------------------------------------------------------------
# ROS2 node
# ---------------------------------------------------------------------------

class AGVPoseSubscriber(Node):
    def __init__(self):
        super().__init__('agv_pose_subscriber')
        self.subscription = self.create_subscription(
            Odometry, ROS2_TOPIC, self.odometry_callback, 10)
        self.control_cmd_pub = self.create_publisher(
            String, '/agv/control_cmd', 10)
        self.mission_cmd_pub = self.create_publisher(
            String, '/agv/mission_cmd', 10)
        self.create_subscription(
            String, '/agv/mission_status', self._on_mission_status, 10)
        self.get_logger().info(f'Subscribed to {ROS2_TOPIC}')

    def odometry_callback(self, msg: Odometry) -> None:
        global _last_risk_state

        x = msg.pose.pose.position.x
        y = msg.pose.pose.position.y
        heading = quaternion_to_yaw(msg.pose.pose.orientation)
        vx = msg.twist.twist.linear.x
        vy = msg.twist.twist.linear.y
        speed = math.sqrt(vx**2 + vy**2)

        tq = risk_layer.query(x, y)
        rf = risk_fusion.fuse(
            {'x': x, 'y': y, 'speed': speed, 'heading': heading}, tq)

        with state_lock:
            vehicle_state['x'] = x
            vehicle_state['y'] = y
            vehicle_state['heading'] = heading
            vehicle_state['speed'] = speed
            vehicle_state['last_update'] = time.time()
            vehicle_state['risk_score'] = rf['risk_score']
            vehicle_state['risk_state'] = rf['risk_state']
            vehicle_state['warning_reason'] = rf['warning_reason']
            vehicle_state['terrain_risk'] = rf['terrain_risk']
            vehicle_state['gradient_mag'] = rf['gradient_mag']
            trajectory_history.append({'x': x, 'y': y, 'timestamp': time.time()})

        # Unified WebSocket events
        socketio.emit('agv_state', _build_agv_state_msg(), namespace='/')
        socketio.emit('risk_state', _build_risk_state_msg(), namespace='/')

        # Generate alert on risk state transition
        new_rs = rf['risk_state']
        if new_rs != _last_risk_state:
            if new_rs == 'danger':
                _push_alert('critical', '高风险警告',
                            f'AGV 进入高风险区域: {rf["warning_reason"]}')
            elif new_rs == 'warn':
                _push_alert('warn', '中风险提示',
                            f'AGV 进入中风险区域: {rf["warning_reason"]}')
            elif new_rs == 'safe' and _last_risk_state in ('warn', 'danger'):
                _push_alert('info', '风险解除',
                            '车辆已返回安全区域，风险等级恢复正常')
            _last_risk_state = new_rs

    def _on_mission_status(self, msg: String):
        try:
            data = json.loads(msg.data)
            old_running = mission_state.get('running', False)
            with state_lock:
                mission_state.update(data)

            # Emit unified mission_status event
            socketio.emit('mission_status', _build_mission_status_msg(), namespace='/')

            # Generate mission alerts
            new_running = data.get('running', old_running)
            if new_running and not old_running:
                _push_alert('info', '任务启动',
                            f'开始执行路线: {data.get("route_name", "未知")}')
            elif not new_running and old_running:
                _push_alert('info', '任务结束',
                            f'路线执行完成: {data.get("route_name", "未知")}')
        except (json.JSONDecodeError, TypeError):
            pass


def _ros2_spin(node: Node) -> None:
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    except Exception as exc:
        if not _shutdown_event.is_set() and _ros2_context_ok(node):
            print(f'[ROS2] spin error: {exc}')


_ros2_node: AGVPoseSubscriber | None = None


def initialize_ros2():
    global _ros2_node, _ros2_spin_thread
    node: AGVPoseSubscriber | None = None
    try:
        rclpy.init()
        node = AGVPoseSubscriber()
        _ros2_node = node
        _ros2_spin_thread = threading.Thread(
            target=_ros2_spin, args=(node,), daemon=True, name='ros2-spin')
        _ros2_spin_thread.start()
        print('✓ ROS2 node initialised – subscribed to', ROS2_TOPIC)
        return node
    except Exception as exc:
        _safe_destroy_node(node)
        if _ros2_context_ok():
            try:
                rclpy.shutdown()
            except Exception:
                pass
        print(f'✗ ROS2 init failed: {exc}')
        print('  Flask will run without real-time robot data.')
        return None


# ---------------------------------------------------------------------------
# Background broadcaster: system_status every 3s
# ---------------------------------------------------------------------------

def _broadcast_system_status():
    """Periodically emit system_status to all clients."""
    while not _shutdown_event.wait(3.0):
        try:
            socketio.emit('system_status', _build_system_status_msg(), namespace='/')
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Cached heatmap
# ---------------------------------------------------------------------------
_heatmap_cache: list | None = None


def _get_heatmap() -> list:
    global _heatmap_cache
    if _heatmap_cache is None:
        _heatmap_cache = risk_layer.get_heatmap_data(step=4)
    return _heatmap_cache


# ═══════════════════════════════════════════════════════════════════════════
# REST endpoints — Legacy (preserved for backward compatibility)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    return render_template(
        'dashboard.html',
        scene_context=SCENE_CONTEXT,
        active_page='overview',
    )


def _render_platform_page(template_name: str, active_page: str, page_title: str):
    """Render a full-screen platform topic page without changing API contracts."""
    return render_template(
        template_name,
        scene_context=SCENE_CONTEXT,
        active_page=active_page,
        page_title=page_title,
    )


@app.route('/fleet')
def fleet_page():
    return _render_platform_page(
        'fleet.html',
        'fleet',
        '港区车辆运行总览 - 港口数字孪生系统',
    )


@app.route('/risk')
def risk_page():
    return _render_platform_page(
        'risk.html',
        'risk',
        '风险监测与评估 - 港口数字孪生系统',
    )


@app.route('/alerts')
def alerts_page():
    return _render_platform_page(
        'alerts.html',
        'alerts',
        '告警事件中心 - 港口数字孪生系统',
    )


@app.route('/tasks')
def tasks_page():
    return _render_platform_page(
        'tasks.html',
        'tasks',
        '任务执行与调度 - 港口数字孪生系统',
    )


@app.route('/health')
def health():
    with state_lock:
        last_update = vehicle_state['last_update']
    ros2_ok = (last_update > 0) and ((time.time() - last_update) < 5.0)
    return jsonify({
        'status': 'ok',
        'ros2_active': ros2_ok,
        'last_odom_age_s': round(time.time() - last_update, 2) if last_update > 0 else None,
        'scene_profile': SCENE_PROFILE,
        'world_size_m': WORLD_SIZE_M,
        'local_map_bounds': LOCAL_MAP_BOUNDS,
        'risk_layer': SCENE_CONTEXT['risk_layer_mode'],
        'risk_fusion': 'rule_based',
        'endpoints': [
            '/vehicle_state', '/trajectory', '/risk/current', '/risk/heatmap',
            '/health', '/api/system/status', '/api/agv/latest', '/api/agv/path',
            '/api/risk/current', '/api/risk/heatmap', '/api/alerts/recent',
            '/api/mission/status', '/api/demo/reset',
        ],
    })


@app.route('/vehicle_state')
def get_vehicle_state():
    with state_lock:
        return jsonify({
            'pose': {
                'x': vehicle_state['x'],
                'y': vehicle_state['y'],
                'heading': vehicle_state['heading'],
            },
            'speed': vehicle_state['speed'],
            'scenario': vehicle_state['scenario'],
            'timestamp': vehicle_state['last_update'],
            'risk_index': vehicle_state['risk_score'],
            'risk_score': vehicle_state['risk_score'],
            'risk_state': vehicle_state['risk_state'],
            'warning_reason': vehicle_state['warning_reason'],
            'terrain_risk': vehicle_state['terrain_risk'],
            'gradient_mag': vehicle_state['gradient_mag'],
        })


@app.route('/trajectory')
def get_trajectory():
    with state_lock:
        return jsonify(list(trajectory_history))


@app.route('/trajectory/clear', methods=['POST'])
def clear_trajectory():
    with state_lock:
        trajectory_history.clear()
    return jsonify({'status': 'cleared'})


@app.route('/risk/current')
def get_risk_current():
    with state_lock:
        x, y = vehicle_state['x'], vehicle_state['y']
        speed, hdg = vehicle_state['speed'], vehicle_state['heading']
    tq = risk_layer.query(x, y)
    rf = risk_fusion.fuse({'x': x, 'y': y, 'speed': speed, 'heading': hdg}, tq)
    return jsonify({
        'position': {'x': round(x, 3), 'y': round(y, 3)},
        'risk_score': rf['risk_score'], 'risk_state': rf['risk_state'],
        'warning_reason': rf['warning_reason'],
        'terrain_risk': rf['terrain_risk'], 'gradient_mag': rf['gradient_mag'],
    })


@app.route('/risk/heatmap')
def get_risk_heatmap():
    return jsonify(_get_heatmap())


@app.route('/risk/heatmap/refresh')
def refresh_heatmap():
    global _heatmap_cache
    _heatmap_cache = None
    data = _get_heatmap()
    return jsonify({'status': 'refreshed', 'points': len(data)})


# ═══════════════════════════════════════════════════════════════════════════
# Control & Mission endpoints (unchanged)
# ═══════════════════════════════════════════════════════════════════════════

VALID_MANUAL_ACTIONS = {
    'speed_up', 'speed_down', 'steer_left', 'steer_right',
    'center_steer', 'stop', 'reset_all',
}


@app.route('/control/manual', methods=['POST'])
def control_manual():
    if not _ros2_node:
        return jsonify({'error': 'ROS2 not available'}), 503
    data = request.get_json(silent=True) or {}
    action = data.get('action', '')
    if action not in VALID_MANUAL_ACTIONS:
        return jsonify({'error': f'Unknown action: {action}'}), 400
    try:
        msg = String()
        msg.data = action
        _ros2_node.control_cmd_pub.publish(msg)
    except Exception as e:
        return jsonify({'error': f'ROS2 publish failed: {e}'}), 503
    with state_lock:
        if not mission_state.get('running'):
            mission_state['mode'] = 'manual'
    return jsonify({'status': 'ok', 'action': action})


@app.route('/control/stop', methods=['POST'])
def control_stop():
    if _ros2_node:
        try:
            cmd = String()
            cmd.data = 'cancel'
            _ros2_node.mission_cmd_pub.publish(cmd)
            stop = String()
            stop.data = 'emergency_stop'
            _ros2_node.control_cmd_pub.publish(stop)
        except Exception:
            pass
    with state_lock:
        mission_state['mode'] = 'idle'
        mission_state['running'] = False
    _push_alert('warn', '紧急停车', '用户触发紧急停车，车辆已停止')
    return jsonify({'status': 'stopped'})


@app.route('/mission/start', methods=['POST'])
def mission_start():
    if not _ros2_node:
        return jsonify({'error': 'ROS2 not available'}), 503
    data = request.get_json(silent=True) or {}
    route_name = data.get('route_name', '')
    if route_name not in DEMO_ROUTES:
        return jsonify({
            'error': f'Unknown route: {route_name}',
            'available': list(DEMO_ROUTES.keys()),
        }), 400
    try:
        msg = String()
        msg.data = f'start:{route_name}'
        _ros2_node.mission_cmd_pub.publish(msg)
    except Exception as e:
        return jsonify({'error': f'ROS2 publish failed: {e}'}), 503
    return jsonify({'status': 'started', 'route_name': route_name})


@app.route('/mission/cancel', methods=['POST'])
def mission_cancel():
    if _ros2_node:
        try:
            msg = String()
            msg.data = 'cancel'
            _ros2_node.mission_cmd_pub.publish(msg)
        except Exception:
            pass
    return jsonify({'status': 'cancelled'})


@app.route('/mission/status')
def mission_status():
    with state_lock:
        return jsonify(dict(mission_state))


@app.route('/mission/routes')
def mission_routes():
    return jsonify(DEMO_ROUTES)


# ═══════════════════════════════════════════════════════════════════════════
# Unified API endpoints (/api/*)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/system/status')
def api_system_status():
    """系统状态 — 后端、ROS2、WebSocket 连接状态"""
    return jsonify(_build_system_status_msg())


@app.route('/api/agv/latest')
def api_agv_latest():
    """AGV 最新状态"""
    return jsonify(_build_agv_state_msg())


@app.route('/api/agv/path')
def api_agv_path():
    """AGV 历史轨迹"""
    with state_lock:
        points = list(trajectory_history)
    return jsonify({
        'count': len(points),
        'max_points': 500,
        'path': points,
    })


@app.route('/api/risk/current')
def api_risk_current():
    """当前风险评估"""
    return jsonify(_build_risk_state_msg())


@app.route('/api/risk/heatmap')
def api_risk_heatmap():
    """风险热力图数据"""
    data = _get_heatmap()
    return jsonify({
        'count': len(data),
        'grid_resolution': risk_layer.GRID_RES_M,
        'grid_range': [risk_layer.GRID_MIN_M, risk_layer.GRID_MAX_M],
        'scene_profile': SCENE_PROFILE,
        'risk_layer_mode': SCENE_CONTEXT['risk_layer_mode'],
        'deformation_zones_file': DEFORMATION_ZONES_ID,
        'points': data,
    })


@app.route('/api/alerts/recent')
def api_alerts_recent():
    """最近告警事件"""
    limit = request.args.get('limit', 20, type=int)
    alerts = list(alert_history)
    alerts.reverse()  # newest first
    return jsonify({
        'count': len(alerts[:limit]),
        'alerts': alerts[:limit],
    })


@app.route('/api/mission/status')
def api_mission_status():
    """任务状态"""
    return jsonify(_build_mission_status_msg())


@app.route('/api/demo/reset', methods=['POST'])
def api_demo_reset():
    """重置演示状态 — 清除轨迹和告警"""
    with state_lock:
        trajectory_history.clear()
    alert_history.clear()
    global _heatmap_cache
    _heatmap_cache = None

    if _ros2_node:
        try:
            stop = String()
            stop.data = 'emergency_stop'
            _ros2_node.control_cmd_pub.publish(stop)
            cancel = String()
            cancel.data = 'cancel'
            _ros2_node.mission_cmd_pub.publish(cancel)
        except Exception:
            pass
    with state_lock:
        mission_state['mode'] = 'idle'
        mission_state['running'] = False

    _push_alert('info', '系统重置', '演示数据已清除，系统重置完成')
    return jsonify({'status': 'reset', 'message': '演示数据已清除'})


# ═══════════════════════════════════════════════════════════════════════════
# InSAR 形变查询接口
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/insar/layers')
def api_insar_layers():
    """InSAR 可用图层列表与元数据"""
    return jsonify(_insar_provider.get_layers_info())


@app.route('/api/insar/query')
def api_insar_query():
    """查询指定坐标的 InSAR 形变值

    参数 (二选一):
      - lat, lng: WGS84 经纬度 (直接查询)
      - x, y: 仿真平面坐标 (自动转换为 WGS84 后查询)
    """
    lat = request.args.get('lat', type=float)
    lng = request.args.get('lng', type=float)

    if lat is None or lng is None:
        # 尝试从仿真坐标转换
        x = request.args.get('x', type=float)
        y = request.args.get('y', type=float)
        if x is not None and y is not None:
            lat, lng = sim_to_wgs84(x, y)
        else:
            return jsonify({'ok': False, 'error': '需要 lat,lng 或 x,y 参数'}), 400

    return jsonify(_insar_provider.query(lat, lng))


@app.route('/api/insar/heatmap')
def api_insar_heatmap():
    """InSAR 形变热力图数据 (用于 Leaflet 渲染)"""
    step = request.args.get('step', 4, type=int)
    data = _insar_provider.get_heatmap_data(step=step)
    return jsonify({
        'count': len(data),
        'is_mock': _insar_provider.is_mock,
        'source': 'zhoukou_port_insar',
        'points': data,
    })


@app.route('/api/insar/risk_zones')
def api_insar_risk_zones():
    """InSAR 风险分区 GeoJSON"""
    zones = _insar_provider.get_risk_zones_geojson()
    if zones is None:
        return jsonify({'type': 'FeatureCollection', 'features': []})
    return jsonify(zones)


# ═══════════════════════════════════════════════════════════════════════════
# Socket.IO events
# ═══════════════════════════════════════════════════════════════════════════

@socketio.on('connect')
def handle_connect():
    if SERVER_DEBUG:
        print(f'[WS] client connected {datetime.now().isoformat()}')
    # Send initial unified state on connect
    emit('agv_state', _build_agv_state_msg())
    emit('risk_state', _build_risk_state_msg())
    emit('system_status', _build_system_status_msg())
    emit('mission_status', _build_mission_status_msg())

    # Send recent alerts
    alerts = list(alert_history)
    for a in alerts[-10:]:
        emit('alert_event', a)


@socketio.on('disconnect')
def handle_disconnect():
    if SERVER_DEBUG:
        print(f'[WS] client disconnected {datetime.now().isoformat()}')


# ═══════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    browser_host = 'localhost' if SERVER_HOST in ('127.0.0.1', '0.0.0.0') else SERVER_HOST
    port_ok, port_error = _check_server_port_available(SERVER_HOST, SERVER_PORT)
    if not port_ok:
        print(f'✗ Flask startup blocked: {SERVER_HOST}:{SERVER_PORT} is already in use.')
        print(f'  Bind error: {port_error}')
        print('  Resolve the port conflict, then restart the dashboard.')
        print(f'  Suggested checks: ss -ltnp "( sport = :{SERVER_PORT} )" or lsof -i :{SERVER_PORT}')
        sys.exit(1)

    print('=' * 60)
    print('  港口 AGV 数字孪生 — 开发期后端服务')
    print('  Port AGV Digital Twin — Development Backend')
    print('=' * 60)
    print(f'  http://{browser_host}:{SERVER_PORT}')
    print(f'  默认主场景: {SCENE_PROFILE} ({SCENE_TITLE_CN})')
    print(f'  默认 Gazebo 启动: ros2 launch ros_gz_example_bringup {DEFAULT_GAZEBO_LAUNCH}')
    print()
    print('  统一接口 (Unified API):')
    print('    GET  /api/system/status   系统状态')
    print('    GET  /api/agv/latest      AGV 最新状态')
    print('    GET  /api/agv/path        历史轨迹')
    print('    GET  /api/risk/current    当前风险')
    print('    GET  /api/risk/heatmap    风险热力图')
    print('    GET  /api/alerts/recent   最近告警')
    print('    GET  /api/mission/status  任务状态')
    print('    POST /api/demo/reset      重置演示')
    print()
    print('  WebSocket 事件:')
    print('    agv_state, risk_state, alert_event,')
    print('    system_status, mission_status')
    print()
    print(f'  数据管道: {ROS2_TOPIC} → terrain_query → risk_fusion → WS push')
    print(f'  风险层模式: {SCENE_CONTEXT["risk_layer_mode"]}')
    print('=' * 60)

    ros_node = initialize_ros2()

    if not ros_node:
        print('⚠  无 ROS2 连接 — 车辆位置固定在 (0, 0)')

    # Start background system_status broadcaster
    _status_thread = threading.Thread(target=_broadcast_system_status, daemon=True)
    _status_thread.start()

    # Push startup alert
    _push_alert('info', '系统启动', '港口 AGV 数字孪生后端服务已启动')

    print('\n按 Ctrl+C 停止服务.\n')

    try:
        socketio.run(app, host=SERVER_HOST, port=SERVER_PORT,
                     debug=SERVER_DEBUG,
                     allow_unsafe_werkzeug=True, use_reloader=False)
    except KeyboardInterrupt:
        print('\n正在关闭…')
    finally:
        _shutdown_ros2_once()
