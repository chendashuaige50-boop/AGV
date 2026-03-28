# AGENTS.md - Development Rules and Constraints

This file defines rules for AI assistants (Claude Code, GitHub Copilot, etc.) and human developers working on this project.

## Project Context

This is a **Port AGV Digital Twin** system integrating ROS2, Gazebo, and web visualization. The project is in **Phase 1: Minimal Viable Integration** - focus is on stability and basic functionality, not advanced features.

## Critical Constraints

### DO NOT Modify
- ❌ `ros_gz_project_template/` - This is a read-only reference package
- ❌ `/diff_drive/odometry` topic name - Web dashboard depends on this
- ❌ diff_drive robot model - Keep using the simple differential drive AGV
- ❌ Existing ros_gz_bridge configuration - Reuse, don't replace

### DO NOT Add (Yet)
- ❌ InSAR risk assessment (Phase 2+)
- ❌ GNSS integration (Phase 2+)
- ❌ Dynamic terrain deformation (Phase 2+)
- ❌ Multi-vehicle coordination (Phase 2+)
- ❌ Complex vehicle models (volvofh16, etc.)
- ❌ External network dependencies (CDN, APIs)

### MUST Follow
- ✅ Use relative paths, never hardcode absolute paths
- ✅ Test build and launch after every change
- ✅ Keep changes minimal and reviewable
- ✅ Document all modifications with clear comments
- ✅ Maintain offline operation capability
- ✅ Preserve backward compatibility

## Code Style

### Python (Flask Backend)
- Use threading mode for Flask-SocketIO (NOT eventlet)
- Thread-safe access to shared state (use locks)
- Clear separation: ROS2 callbacks → global state → Socket.IO emission
- Extract configuration to YAML/env files, not hardcoded

### ROS2 Packages
- Follow standard ROS2 package structure
- Use `package://` URIs for resource paths
- Export resources properly in CMakeLists.txt
- Include clear package.xml descriptions

### Gazebo SDF
- Use SDF 1.8 format
- Static models for harbour assets
- Reasonable poses (avoid collisions)
- Include comments for pose coordinates

### Launch Files
- Use Python launch files (.launch.py)
- Make paths configurable via launch arguments
- Include descriptive comments
- Follow existing launch file patterns

## Development Workflow

### Before Making Changes
1. Read relevant existing code
2. Understand current architecture
3. Check if change aligns with Phase 1 scope
4. Plan minimal modification approach

### Making Changes
1. Make one logical change at a time
2. Test immediately after change
3. Document the change
4. Verify no regressions

### After Changes
1. Run `colcon build --symlink-install`
2. Test launch files
3. Verify ROS2 topics
4. Test web dashboard
5. Update documentation if needed

## Testing Requirements

### Must Test
- `colcon build` succeeds
- Launch files start without errors
- ROS2 topics publish at expected rates
- Web dashboard connects and displays data
- No console errors in browser
- AGV responds to velocity commands

### Test Commands
```bash
# Build
colcon build --symlink-install
source install/setup.bash

# Launch
ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py

# Verify topics
ros2 topic list | grep diff_drive
ros2 topic hz /diff_drive/odometry
ros2 topic echo /diff_drive/odometry --once

# Test web
cd web_dashboard && ./start_server.sh
curl http://localhost:5000/vehicle_state

# Control AGV
ros2 topic pub /diff_drive/cmd_vel geometry_msgs/msg/Twist \
  "{linear: {x: 1.0}, angular: {z: 0.5}}"
```

## File Organization

### New Files
- Add to appropriate package directory
- Include file header with description
- Use clear, descriptive names
- Add to CMakeLists.txt if needed

### Modified Files
- Add comment explaining modification
- Preserve existing functionality
- Keep changes minimal
- Update related documentation

## Common Pitfalls

### Avoid
- ❌ Using eventlet with Flask-SocketIO (use threading)
- ❌ Hardcoding paths like `/home/loong/...`
- ❌ Modifying ros_gz_project_template
- ❌ Changing topic names without updating all consumers
- ❌ Adding CDN dependencies (breaks offline operation)
- ❌ Scope creep (adding Phase 2+ features)

### Instead
- ✅ Use threading mode for Socket.IO
- ✅ Use relative paths or `package://` URIs
- ✅ Create new packages for integration
- ✅ Keep topic names consistent
- ✅ Download assets to `static/` directory
- ✅ Focus on Phase 1 objectives

## Communication

### Code Comments
- Explain WHY, not just WHAT
- Mark TODOs for future phases
- Document assumptions
- Note dependencies

### Commit Messages
- Clear, descriptive messages
- Reference issue/task if applicable
- Explain rationale for non-obvious changes

### Documentation
- Update README.md for user-facing changes
- Update CLAUDE.md for architecture changes
- Update integration_plan.md for scope changes
- Keep docs in sync with code

## Phase Boundaries

### Phase 1 (Current)
**Goal**: Minimal viable harbour scene integration
**Deliverables**: Working harbour scene, functional web dashboard, clean documentation

### Phase 2 (Future)
**Goal**: Advanced sensing and risk assessment
**Includes**: InSAR, GNSS, risk computation

### Phase 3 (Future)
**Goal**: Multi-vehicle and mission planning
**Includes**: Fleet coordination, path planning, mission interface

## When in Doubt

1. Check [docs/integration_plan.md](docs/integration_plan.md) for scope
2. Check [CLAUDE.md](CLAUDE.md) for architecture
3. Check [README.md](README.md) for usage
4. Ask before making significant changes
5. Prefer minimal changes over clever solutions

## Success Metrics

- ✅ Build succeeds without warnings
- ✅ Launch files start reliably
- ✅ Web dashboard connects on first try
- ✅ No hardcoded paths in code
- ✅ Documentation is up-to-date
- ✅ New developer can follow README to run system
