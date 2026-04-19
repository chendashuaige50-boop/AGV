cmake_minimum_required(VERSION 3.8)
project(harbour_assets_description)

# Find dependencies
find_package(ament_cmake REQUIRED)

# Install models directory so Gazebo can find them via GZ_SIM_RESOURCE_PATH
install(DIRECTORY
  models/
  DESTINATION share/${PROJECT_NAME}/models
)

# Some checkouts only contain models/, so keep optional asset folders best-effort.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/meshes")
  install(DIRECTORY
    meshes/
    DESTINATION share/${PROJECT_NAME}/meshes
  )
endif()

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/config")
  install(DIRECTORY
    config/
    DESTINATION share/${PROJECT_NAME}/config
  )
endif()

# Install GZ_SIM_RESOURCE_PATH hooks so that 'source install/setup.bash'
# makes Gazebo find our models via package:// URIs automatically
ament_environment_hooks(
  hooks/harbour_assets_description.dsv.in
  hooks/harbour_assets_description.sh.in
)

# Export package information
ament_package()
