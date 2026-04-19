# Copyright 2022 Open Source Robotics Foundation, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

"""
Minimal 400 m simplified port experiment launch (agv_ackermann only).

This launch preserves the current /agv/* bridge chain and only swaps the Gazebo
world to a simplified, repeatable experiment scene for localization-error and
terrain/deformation studies.
"""

import os

from ament_index_python.packages import get_package_share_directory

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, SetEnvironmentVariable
from launch.actions import IncludeLaunchDescription
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration

from launch_ros.actions import Node


def generate_launch_description():
    pkg_project_bringup = get_package_share_directory('ros_gz_example_bringup')
    pkg_project_gazebo = get_package_share_directory('ros_gz_example_gazebo')
    pkg_project_description = get_package_share_directory('ros_gz_example_description')
    pkg_ros_gz_sim = get_package_share_directory('ros_gz_sim')

    pkg_harbour_assets = get_package_share_directory('harbour_assets_description')
    harbour_models_path = os.path.join(pkg_harbour_assets, 'models')
    existing_resource_path = os.environ.get('IGN_GAZEBO_RESOURCE_PATH', '')
    new_resource_path = harbour_models_path
    if existing_resource_path:
        new_resource_path = harbour_models_path + ':' + existing_resource_path

    zones_yaml = os.path.join(
        pkg_project_bringup, 'config', 'deformation_zones.yaml')

    set_resource_path = SetEnvironmentVariable(
        name='IGN_GAZEBO_RESOURCE_PATH',
        value=new_resource_path,
    )

    set_zones_path = SetEnvironmentVariable(
        name='AGV_DEFORMATION_ZONES_FILE',
        value=zones_yaml,
    )

    set_scene_name = SetEnvironmentVariable(
        name='AGV_SCENE_PROFILE',
        value='simplified_port_agv_terrain_400m',
    )

    agv_urdf_file = os.path.join(
        pkg_project_description, 'models', 'agv_ackermann', 'agv_ackermann.urdf')
    with open(agv_urdf_file, 'r') as f:
        agv_robot_desc = f.read()

    gz_sim = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(pkg_ros_gz_sim, 'launch', 'gz_sim.launch.py')),
        launch_arguments={'gz_args': '-r ' + os.path.join(
            pkg_project_gazebo, 'worlds', 'simplified_port_agv_terrain_400m.sdf'),
            'on_exit_shutdown': ''
        }.items(),
    )

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

    agv_robot_state_publisher = Node(
        package='robot_state_publisher',
        executable='robot_state_publisher',
        name='agv_robot_state_publisher',
        output='both',
        parameters=[
            {'use_sim_time': True},
            {'frame_prefix': 'agv_ackermann/'},
            {'robot_description': agv_robot_desc},
        ],
        remappings=[
            ('joint_states', '/agv/joint_states'),
        ]
    )

    odom_tf_publisher = Node(
        package='ros_gz_example_bringup',
        executable='odom_tf_publisher.py',
        name='odom_tf_publisher',
        output='screen',
    )

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
        set_zones_path,
        set_scene_name,

        DeclareLaunchArgument(
            'rviz',
            default_value='true',
            description='Open RViz.'),
        DeclareLaunchArgument(
            'odom_visual_helper',
            default_value='true',
            description='Enable default odom path helper for RViz trajectory display.'),

        gz_sim,
        agv_bridge,
        agv_robot_state_publisher,
        odom_tf_publisher,
        Node(
            package='ros_gz_example_bringup',
            executable='odom_visual_helper.py',
            name='odom_visual_helper',
            output='screen',
            condition=IfCondition(LaunchConfiguration('odom_visual_helper')),
        ),
        rviz,
    ])
