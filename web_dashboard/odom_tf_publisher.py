#!/usr/bin/env python3
"""
odom_tf_publisher.py — Broadcasts odom -> chassis TF from /agv/odometry
========================================================================

The Gazebo AckermannSteering plugin publishes nav_msgs/Odometry to
/agv/odometry, but does NOT publish the corresponding odom -> base_link
TF transform (the OdometryPublisher was removed to avoid TF conflicts
with PosePublisher).

This lightweight node subscribes to /agv/odometry and broadcasts the
odom -> chassis transform so RViz can display the robot moving in the
odom frame.

Usage:
    python3 odom_tf_publisher.py
    # or launched from harbour_diff_drive.launch.py
"""

import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry
from tf2_ros import TransformBroadcaster
from geometry_msgs.msg import TransformStamped


class OdomTFPublisher(Node):

    def __init__(self):
        super().__init__('odom_tf_publisher')
        self.br = TransformBroadcaster(self)
        self.create_subscription(Odometry, '/agv/odometry', self._on_odom, 10)
        self.get_logger().info('Broadcasting odom -> chassis TF from /agv/odometry')

    def _on_odom(self, msg: Odometry):
        t = TransformStamped()
        t.header.stamp = msg.header.stamp
        t.header.frame_id = 'odom'
        t.child_frame_id = 'chassis'

        t.transform.translation.x = msg.pose.pose.position.x
        t.transform.translation.y = msg.pose.pose.position.y
        t.transform.translation.z = msg.pose.pose.position.z
        t.transform.rotation = msg.pose.pose.orientation

        self.br.sendTransform(t)


def main():
    rclpy.init()
    node = OdomTFPublisher()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
