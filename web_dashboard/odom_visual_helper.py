#!/usr/bin/env python3
"""
odom_visual_helper.py — High-visibility RViz markers for AGV motion
====================================================================

Publishes a short trailing path for RViz visualization:

  /agv/odom_path_vis  (nav_msgs/Path)
   - Short trailing path (last ~22 poses) showing recent trajectory
   - Raised slightly above ground to avoid z-fighting with grid

Subscribes to: /agv/odometry
Does NOT modify any control or physics topics.

Usage:
    python3 odom_visual_helper.py
    # or launched from harbour_diff_drive.launch.py
"""

import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry, Path
from geometry_msgs.msg import PoseStamped
from collections import deque


class OdomVisualHelper(Node):

    def __init__(self):
        super().__init__('odom_visual_helper')

        # Config
        self.path_z_offset = 0.15       # meters above ground
        self.path_max_points = 22
        self.min_dist_between_points = 0.4  # avoid cluttering when stopped

        # State
        self.path_points = deque(maxlen=self.path_max_points)
        self.last_x = None
        self.last_y = None

        # Publisher (path only — vehicle heading arrow removed for cleaner display)
        self.path_pub = self.create_publisher(Path, '/agv/odom_path_vis', 10)

        # Subscriber
        self.create_subscription(Odometry, '/agv/odometry', self._on_odom, 10)

        self.get_logger().info('Visual helper active: /agv/odom_path_vis')

    def _on_odom(self, msg: Odometry):
        x = msg.pose.pose.position.x
        y = msg.pose.pose.position.y
        z = msg.pose.pose.position.z
        orientation = msg.pose.pose.orientation
        stamp = msg.header.stamp

        # ── Trailing path ─────────────────────────────────────────
        # Only add point if moved enough (avoid clutter when stopped)
        add_point = True
        if self.last_x is not None:
            dx = x - self.last_x
            dy = y - self.last_y
            if (dx * dx + dy * dy) < self.min_dist_between_points ** 2:
                add_point = False

        if add_point:
            self.last_x = x
            self.last_y = y

            ps = PoseStamped()
            ps.header.frame_id = 'odom'
            ps.header.stamp = stamp
            ps.pose.position.x = x
            ps.pose.position.y = y
            ps.pose.position.z = z + self.path_z_offset
            ps.pose.orientation = orientation
            self.path_points.append(ps)

        path_msg = Path()
        path_msg.header.frame_id = 'odom'
        path_msg.header.stamp = stamp
        path_msg.poses = list(self.path_points)
        self.path_pub.publish(path_msg)


def main():
    rclpy.init()
    node = OdomVisualHelper()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
