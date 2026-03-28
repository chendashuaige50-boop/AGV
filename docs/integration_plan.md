# Integration Plan - Phase 1: Minimal Viable Harbour Scene

## Objective

Create a minimal viable integration of port harbour models with the existing diff_drive AGV simulation, maintaining full functionality of the web dashboard.

## Scope

### In Scope (Phase 1)
- ✅ Integrate 2-3 static harbour models into Gazebo scene
- ✅ Maintain existing diff_drive AGV functionality
- ✅ Keep /diff_drive/odometry topic unchanged
- ✅ Ensure web dashboard continues to work
- ✅ Reorganize directory structure
- ✅ Fix hardcoded paths
- ✅ Create comprehensive documentation

### Out of Scope (Future Phases)
- ❌ InSAR risk assessment integration
- ❌ GNSS positioning system
- ❌ Dynamic terrain deformation
- ❌ Multi-vehicle coordination
- ❌ Advanced sensor fusion
- ❌ Real-time risk computation
- ❌ Complex vehicle models (volvofh16, etc.)

## Implementation Strategy

### 1. Directory Restructuring
- Rename `backend/` → `web_dashboard/` for clarity
- Fix `start_server.sh` to use relative paths
- Create proper documentation structure

### 2. Harbour Assets Package
Create new ROS2 package: `harbour_assets_description`

**Selected Models:**
1. **crane1** - Port crane (岸桥)
2. **container40** - 40ft shipping container
3. **container-multi-stack** - Container stack

**Rationale:**
- Lightweight models for initial integration
- Clearly identifiable as port/harbour environment
- Static models (no complex physics)
- Won't interfere with AGV navigation

### 3. Scene Creation
Create `harbour_diff_drive.sdf`:
- Include existing diff_drive robot
- Add 3 harbour models with appropriate poses
- Maintain simple ground plane
- Keep existing lighting
- Ensure no collision with AGV spawn point

### 4. Launch Configuration
Create `harbour_diff_drive.launch.py`:
- Launch new harbour scene
- Reuse existing ros_gz_bridge configuration
- Maintain all existing topic mappings
- No changes to /diff_drive/odometry

### 5. Web Dashboard
- Verify static assets load correctly
- Extract configuration to config.yaml
- Test Socket.IO connection
- Verify real-time data flow

## Constraints

### Must Not
- ❌ Modify ros_gz_project_template internals
- ❌ Change /diff_drive/odometry topic name
- ❌ Replace diff_drive with complex vehicle
- ❌ Add external network dependencies
- ❌ Implement features beyond Phase 1 scope

### Must Do
- ✅ Use relative paths everywhere
- ✅ Test build and launch after each change
- ✅ Document all modifications
- ✅ Maintain backward compatibility
- ✅ Keep changes minimal and reviewable

## Verification Checklist

- [ ] `colcon build --symlink-install` succeeds
- [ ] `source install/setup.bash` works
- [ ] `ros2 launch ros_gz_example_bringup harbour_diff_drive.launch.py` starts
- [ ] Gazebo shows harbour models and AGV
- [ ] `/diff_drive/odometry` publishes at expected rate
- [ ] `ros2 topic echo /diff_drive/odometry --once` returns data
- [ ] Web dashboard starts without errors
- [ ] Browser connects to `http://localhost:5000`
- [ ] Socket.IO connection established
- [ ] Real-time AGV position updates in browser
- [ ] Trajectory line renders correctly
- [ ] Heatmap API returns data

## Success Criteria

1. **Functional**: AGV moves in harbour scene, web dashboard shows real-time data
2. **Maintainable**: Clear directory structure, no hardcoded paths
3. **Documented**: README, integration plan, and code comments complete
4. **Minimal**: Only necessary changes made, no scope creep
5. **Testable**: All verification steps pass

## Next Steps (Phase 2+)

After Phase 1 is stable:
1. Add GNSS simulation for absolute positioning
2. Integrate InSAR risk data layers
3. Implement dynamic terrain deformation
4. Add multi-vehicle support
5. Develop advanced risk assessment algorithms
6. Create mission planning interface

## Timeline

- Phase 1: 1-2 hours (current)
- Phase 2: TBD
- Phase 3: TBD

## Notes

- Keep ros_gz_project_template as read-only reference
- All integration work in new packages
- Prioritize stability over features
- Document assumptions and limitations
