# Copyright 2022 Open Source Robotics Foundation, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Harbour AGV Launch File (agv_ackermann only)

Launches Gazebo + RViz with the port harbour environment.

TF chain for RViz:
    odom -> chassis -> {steering_links -> wheels, rear_wheels}

    odom -> chassis:  published by odom_tf_publisher (from /agv/odometry)
    chassis -> *:     published by robot_state_publisher (from URDF + /agv/joint_states)

Usage:
    ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py
    ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py rviz:=false
"""

import os

from ament_index_python.packages import get_package_share_directory

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, SetEnvironmentVariable
from launch.actions import IncludeLaunchDescription, ExecuteProcess
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration

from launch_ros.actions import Node


def generate_launch_description():

    # ── Package paths ─────────────────────────────────────────────
    pkg_project_bringup = get_package_share_directory('ros_gz_example_bringup')
    pkg_project_gazebo = get_package_share_directory('ros_gz_example_gazebo')
    pkg_project_description = get_package_share_directory('ros_gz_example_description')
    pkg_ros_gz_sim = get_package_share_directory('ros_gz_sim')

    # Harbour assets models path for Gazebo resource resolution
    pkg_harbour_assets = get_package_share_directory('harbour_assets_description')
    harbour_models_path = os.path.join(pkg_harbour_assets, 'models')
    existing_resource_path = os.environ.get('IGN_GAZEBO_RESOURCE_PATH', '')
    new_resource_path = harbour_models_path
    if existing_resource_path:
        new_resource_path = harbour_models_path + ':' + existing_resource_path

    set_resource_path = SetEnvironmentVariable(
        name='IGN_GAZEBO_RESOURCE_PATH',
        value=new_resource_path,
    )

    # ── agv_ackermann URDF (for robot_state_publisher → RViz) ─────
    agv_urdf_file = os.path.join(
        pkg_project_description, 'models', 'agv_ackermann', 'agv_ackermann.urdf')
    with open(agv_urdf_file, 'r') as f:
        agv_robot_desc = f.read()

    # ── Gazebo simulator ──────────────────────────────────────────
    gz_sim = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(pkg_ros_gz_sim, 'launch', 'gz_sim.launch.py')),
        launch_arguments={'gz_args': '-r ' + os.path.join(
            pkg_project_gazebo, 'worlds', 'harbour_diff_drive.sdf')
        }.items(),
    )

    # ── Gazebo↔ROS bridge (cmd_vel, odometry, joint_states) ──────
    # NOTE: TF is NOT bridged. robot_state_publisher + odom_tf_publisher
    # handle the full TF tree to avoid Gazebo PosePublisher conflicts.
    agv_bridge = Node(
        package='ros_gz_bridge',
        executable='parameter_bridge',
        name='agv_ackermann_bridge',
        parameters=[{
            'config_file': os.path.join(
                pkg_project_bringup, 'config', 'ros_gz_agv_ackermann_bridge.yaml'),
            'use_sim_time': True,
        }],
        output='screen'
    )

    # ── robot_state_publisher (URDF tree → TF + /robot_description) ──
    # Publishes: chassis -> steering_links -> wheels, chassis -> rear_wheels
    # Consumes: /agv/joint_states (from Gazebo bridge)
    agv_robot_state_publisher = Node(
        package='robot_state_publisher',
        executable='robot_state_publisher',
        name='agv_robot_state_publisher',
        output='both',
        parameters=[
            {'use_sim_time': True},
            {'robot_description': agv_robot_desc},
        ],
        remappings=[
            ('joint_states', '/agv/joint_states'),
        ]
    )

    # ── odom_tf_publisher (odometry → odom->chassis TF) ──────────
    # Converts /agv/odometry (nav_msgs/Odometry) into a TF broadcast
    # so RViz can display the robot moving in the odom frame.
    # Located in web_dashboard/ alongside other Python nodes.
    workspace_src = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(pkg_project_bringup))))
    odom_tf_script = os.path.join(workspace_src, 'web_dashboard', 'odom_tf_publisher.py')

    odom_tf_publisher = ExecuteProcess(
        cmd=['python3', odom_tf_script],
        output='screen',
    )

    # ── odom_visual_helper (floating arrow + trailing path) ────────
    # Publishes /agv/odom_marker (Marker ARROW) and /agv/odom_path_vis (Path)
    # for high-visibility direction/trajectory display in RViz.
    odom_vis_script = os.path.join(workspace_src, 'web_dashboard', 'odom_visual_helper.py')

    odom_visual_helper = ExecuteProcess(
        cmd=['python3', odom_vis_script],
        output='screen',
    )

    # ── RViz (optional) ───────────────────────────────────────────
    rviz = Node(
        package='rviz2',
        executable='rviz2',
        arguments=['-d', os.path.join(
            pkg_project_bringup, 'config', 'agv_ackermann.rviz')],
        parameters=[{'use_sim_time': True}],
        condition=IfCondition(LaunchConfiguration('rviz'))
    )

    return LaunchDescription([
        set_resource_path,

        DeclareLaunchArgument(
            'rviz',
            default_value='true',
            description='Open RViz.'),

        gz_sim,
        agv_bridge,
        agv_robot_state_publisher,
        odom_tf_publisher,
        odom_visual_helper,
        rviz,
    ])
