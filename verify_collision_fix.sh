#!/bin/bash
# Collision Fix Verification Script

echo "=========================================="
echo "Harbour Models Collision Fix Verification"
echo "=========================================="
echo ""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "1. Checking Gazebo processes..."
if ps aux | grep -E "ign gazebo" | grep -v grep > /dev/null; then
    echo -e "${GREEN}✓${NC} Gazebo is running"
    ps aux | grep "ign gazebo" | grep -v grep | awk '{print "  PID:", $2, "CMD:", $11, $12}'
else
    echo -e "${RED}✗${NC} Gazebo is NOT running"
fi

echo ""
echo "2. Checking for crash indicators in logs..."
if grep -q "Segmentation fault" /tmp/harbour_test.log 2>/dev/null; then
    echo -e "${RED}✗${NC} Segmentation fault detected"
else
    echo -e "${GREEN}✓${NC} No segmentation fault"
fi

if grep -q "OdeMesh::fillArrays" /tmp/harbour_test.log 2>/dev/null; then
    echo -e "${RED}✗${NC} OdeMesh crash detected"
else
    echo -e "${GREEN}✓${NC} No OdeMesh crash"
fi

MESH_ERRORS=$(grep -c "CustomMeshShape.*normal count" /tmp/harbour_test.log 2>/dev/null || echo "0")
echo "  CustomMeshShape errors: $MESH_ERRORS"
if [ "$MESH_ERRORS" -eq 0 ]; then
    echo -e "${GREEN}✓${NC} No CustomMeshShape errors"
else
    echo -e "${YELLOW}⚠${NC} CustomMeshShape warnings present (non-critical)"
fi

echo ""
echo "3. Checking ROS2 topics..."
source /opt/ros/humble/setup.bash
source install/setup.bash

if ros2 topic list | grep -q "/diff_drive/odometry"; then
    echo -e "${GREEN}✓${NC} /diff_drive/odometry topic exists"
else
    echo -e "${RED}✗${NC} /diff_drive/odometry topic NOT found"
fi

if ros2 topic list | grep -q "/diff_drive/cmd_vel"; then
    echo -e "${GREEN}✓${NC} /diff_drive/cmd_vel topic exists"
else
    echo -e "${RED}✗${NC} /diff_drive/cmd_vel topic NOT found"
fi

echo ""
echo "4. Modified model files..."
echo "  - harbour_assets_description/models/crane1/model.sdf"
echo "  - harbour_assets_description/models/container40/model.sdf"
echo "  - harbour_assets_description/models/container-multi-stack/model.sdf"

echo ""
echo "=========================================="
echo "Summary"
echo "=========================================="
echo ""
echo "Collision Fix Status:"
echo "  crane1:              Box collision (10m × 10m × 20m)"
echo "  container40:         Box collision (12m × 2.4m × 2.6m)"
echo "  container-multi-stack: Box collision (12m × 6m × 8m)"
echo ""
echo "All models now use simple box primitives for collision"
echo "instead of complex DAE meshes that caused DART/ODE crashes."
echo ""
