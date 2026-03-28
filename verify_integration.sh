#!/bin/bash
# Verification script for AGV Digital Twin Harbour Integration

echo "=========================================="
echo "AGV Digital Twin - Harbour Integration"
echo "Verification Script"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Source ROS2
source /opt/ros/humble/setup.bash
source install/setup.bash

echo "1. Checking ROS2 packages..."
if ros2 pkg list | grep -q "harbour_assets_description"; then
    echo -e "${GREEN}✓${NC} harbour_assets_description package found"
else
    echo -e "${RED}✗${NC} harbour_assets_description package NOT found"
    exit 1
fi

echo ""
echo "2. Checking ROS2 topics..."
if ros2 topic list | grep -q "/diff_drive/odometry"; then
    echo -e "${GREEN}✓${NC} /diff_drive/odometry topic exists"
else
    echo -e "${RED}✗${NC} /diff_drive/odometry topic NOT found"
    echo -e "${YELLOW}→${NC} Make sure Gazebo simulation is running"
fi

if ros2 topic list | grep -q "/diff_drive/cmd_vel"; then
    echo -e "${GREEN}✓${NC} /diff_drive/cmd_vel topic exists"
else
    echo -e "${RED}✗${NC} /diff_drive/cmd_vel topic NOT found"
fi

echo ""
echo "3. Checking Web Dashboard..."
if curl -s http://localhost:5000/vehicle_state > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Web dashboard is responding"
    echo "   Vehicle state:"
    curl -s http://localhost:5000/vehicle_state | python3 -m json.tool | head -10
else
    echo -e "${RED}✗${NC} Web dashboard is NOT responding"
    echo -e "${YELLOW}→${NC} Make sure Flask server is running"
fi

echo ""
echo "4. Checking file structure..."
if [ -f "web_dashboard/app.py" ]; then
    echo -e "${GREEN}✓${NC} web_dashboard/app.py exists"
else
    echo -e "${RED}✗${NC} web_dashboard/app.py NOT found"
fi

if [ -f "ros_gz_project_template/ros_gz_example_gazebo/worlds/harbour_diff_drive.sdf" ]; then
    echo -e "${GREEN}✓${NC} harbour_diff_drive.sdf exists"
else
    echo -e "${RED}✗${NC} harbour_diff_drive.sdf NOT found"
fi

if [ -f "ros_gz_project_template/ros_gz_example_bringup/launch/harbour_diff_drive.launch.py" ]; then
    echo -e "${GREEN}✓${NC} harbour_diff_drive.launch.py exists"
else
    echo -e "${RED}✗${NC} harbour_diff_drive.launch.py NOT found"
fi

echo ""
echo "=========================================="
echo "Verification Complete"
echo "=========================================="
echo ""
echo "To start the system:"
echo "  1. Terminal 1: ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py"
echo "  2. Terminal 2: cd web_dashboard && ./start_server.sh"
echo "  3. Browser: http://localhost:5000"
echo ""
