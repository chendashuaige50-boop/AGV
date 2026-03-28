# AGV Digital Twin Dashboard - 离线运行指南

## 问题分析

**原因：** 网页依赖多个外部 CDN 资源（Leaflet.js、Socket.IO、OpenStreetMap 瓦片），在没有网络代理的情况下无法加载这些资源，导致页面一直加载。

## 解决方案

已将所有外部依赖下载到本地 `static/` 目录：

```
backend/
├── static/
│   ├── css/
│   │   ├── leaflet.css
│   │   └── images/
│   │       ├── layers.png
│   │       ├── marker-icon.png
│   │       └── marker-shadow.png
│   └── js/
│       ├── leaflet.js
│       ├── leaflet-heat.js
│       └── socket.io.min.js
├── templates/
│   └── dashboard.html
└── app.py
```

## 启动步骤

### 1. 启动 Gazebo 仿真

```bash
# 在终端 1 中启动 Gazebo
cd /home/loong/AGV_sim/src/ros_gz_project_template
source /opt/ros/humble/setup.bash
colcon build
source install/setup.bash
ros2 launch ros_gz_example_bringup diff_drive.launch.py
```

### 2. 启动 Flask 后端

```bash
# 在终端 2 中启动后端
cd /home/loong/AGV_sim/src/backend
source /opt/ros/humble/setup.bash
python3 app.py
```

或使用启动脚本：

```bash
cd /home/loong/AGV_sim/src/backend
./start_server.sh
```

### 3. 访问仪表板

在浏览器中打开：`http://localhost:5000`

## 验证运行状态

### 检查 ROS2 话题

```bash
source /opt/ros/humble/setup.bash
ros2 topic list | grep diff_drive
# 应该看到：/diff_drive/odometry

ros2 topic echo /diff_drive/odometry --once
# 应该看到实时的里程计数据
```

### 检查 Flask 服务器

```bash
curl http://localhost:5000/vehicle_state
# 应该返回 JSON 格式的车辆状态
```

### 检查浏览器控制台

按 F12 打开开发者工具，在 Console 标签中应该看到：
- "Initializing AGV Dashboard..."
- "Socket.IO connected"
- 实时的位姿数据更新

## 功能说明

### 仪表板功能

1. **实时地图显示**
   - AGV 位置标记（绿色圆点）
   - 轨迹线（蓝色）
   - 风险热力图（绿色=低风险，黄色=中风险，红色=高风险）

2. **侧边栏信息**
   - 车辆位姿（X, Y, 航向角）
   - 速度
   - 风险指数
   - 连接状态

3. **图层控制**
   - 显示/隐藏轨迹
   - 显示/隐藏热力图
   - 显示/隐藏网格

### 数据流

```
Gazebo Simulation
    ↓ (发布)
/diff_drive/odometry (ROS2 Topic)
    ↓ (订阅)
Flask Backend (ROS2 Node)
    ↓ (Socket.IO)
Web Dashboard (浏览器)
```

## 故障排除

### 问题：页面显示 "Connecting..."

**解决方法：**
1. 确认 Flask 服务器正在运行：`ps aux | grep "python3 app.py"`
2. 确认端口 5000 正在监听：`ss -tuln | grep 5000`
3. 检查浏览器控制台错误信息

### 问题：没有实时数据更新

**解决方法：**
1. 确认 Gazebo 正在运行
2. 确认 ROS2 话题正在发布：`ros2 topic hz /diff_drive/odometry`
3. 检查 Flask 终端输出，应该看到 "Emitting pose data" 消息

### 问题：地图不显示

**解决方法：**
1. 检查静态文件是否存在：`ls -lh static/js/ static/css/`
2. 测试静态文件访问：`curl -I http://localhost:5000/static/js/leaflet.js`
3. 清除浏览器缓存后重新加载

## 技术栈

- **后端：** Flask + Flask-SocketIO + ROS2 (rclpy)
- **前端：** HTML + CSS + JavaScript + Leaflet.js
- **通信：** Socket.IO (WebSocket/Polling)
- **仿真：** ROS2 Humble + Gazebo Fortress

## 注意事项

1. 必须先启动 Gazebo，再启动 Flask 后端
2. Flask 后端必须在 ROS2 环境中运行（source setup.bash）
3. 所有资源已本地化，无需网络连接即可运行
4. 地图使用简单的灰色背景，不依赖外部地图瓦片服务
