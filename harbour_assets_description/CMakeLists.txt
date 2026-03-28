cmake_minimum_required(VERSION 3.8)
project(harbour_assets_description)

# Find dependencies
find_package(ament_cmake REQUIRED)

# Install models directory so Gazebo can find them via GZ_SIM_RESOURCE_PATH
install(DIRECTORY
  models/
  DESTINATION share/${PROJECT_NAME}/models
)

# Install meshes directory
install(DIRECTORY
  meshes/
  DESTINATION share/${PROJECT_NAME}/meshes
)

# Install config directory
install(DIRECTORY
  config/
  DESTINATION share/${PROJECT_NAME}/config
)

# Install GZ_SIM_RESOURCE_PATH hooks so that 'source install/setup.bash'
# makes Gazebo find our models via package:// URIs automatically
ament_environment_hooks(
  hooks/harbour_assets_description.dsv.in
  hooks/harbour_assets_description.sh.in
)

# Export package information
ament_package()
