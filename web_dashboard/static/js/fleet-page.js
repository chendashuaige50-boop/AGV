(function () {
    const P = window.Platform;
    let fleet = P.createInitialFleetState();
    let selectedVehicleId = P.DISPLAY_ALIAS.vehicleName;
    let map = null;
    let markers = {};

    function simPoint(vehicle, index) {
        if (typeof vehicle.sim_x === 'number' && typeof vehicle.sim_y === 'number') return [vehicle.sim_x, vehicle.sim_y];
        const fallback = [[0, 0], [72, -52], [-36, 18], [126, -72]][index] || [0, 0];
        return fallback;
    }
    function markerColor(vehicle) {
        if (!vehicle.online) return '#64748b';
        if (vehicle.risk_key === 'high') return '#ff5f7f';
        if (vehicle.risk_key === 'medium') return '#ffd44f';
        if (vehicle.task_status === '作业中') return '#ff9e4a';
        return '#65f3b4';
    }
    function filteredFleet() {
        const q = (document.getElementById('fleetSearch').value || '').trim().toLowerCase();
        const f = document.getElementById('fleetFilter').value;
        return fleet.filter((vehicle) => {
            const queryMatch = !q || vehicle.vehicle_id.toLowerCase().includes(q) || (vehicle.display_name || '').toLowerCase().includes(q);
            const filterMatch =
                f === 'all' ||
                (f === 'online' && vehicle.online) ||
                (f === 'offline' && !vehicle.online) ||
                (f === 'active' && vehicle.task_status === '作业中') ||
                (f === 'alert' && vehicle.online && !['低风险', '--'].includes(vehicle.risk_level));
            return queryMatch && filterMatch;
        });
    }
    function renderStats() {
        const stats = P.calcFleetStats(fleet);
        document.getElementById('fleetKpiTotal').textContent = stats.total;
        document.getElementById('fleetKpiOnline').textContent = stats.online;
        document.getElementById('fleetKpiActive').textContent = stats.active;
        document.getElementById('fleetKpiAlert').textContent = stats.alert;
        document.getElementById('fleetKpiOffline').textContent = stats.offline;
        document.getElementById('fleetKpiSpeed').textContent = stats.avgSpeed.toFixed(1);
    }
    function renderList() {
        const rows = filteredFleet();
        document.getElementById('fleetListCount').textContent = `${rows.length} 台`;
        const list = document.getElementById('fleetPageList');
        if (!rows.length) {
            list.innerHTML = '<div class="list-row"><div class="row-meta">暂无匹配车辆</div></div>';
            return;
        }
        list.innerHTML = rows.map((vehicle) => {
            const onlineText = vehicle.online ? '在线' : '离线';
            const speed = vehicle.online && typeof vehicle.speed === 'number' ? `${vehicle.speed.toFixed(2)} m/s` : '--';
            return `<button class="list-row ${vehicle.vehicle_id === selectedVehicleId ? 'is-selected' : ''}" data-vehicle="${P.escapeHtml(vehicle.vehicle_id)}" type="button" style="text-align:left;cursor:pointer">
                <div class="row-top">
                    <span class="row-title">${P.escapeHtml(vehicle.vehicle_id)}</span>
                    <span class="row-meta">${P.escapeHtml(speed)}</span>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
                    <span class="badge ${vehicle.online ? 'badge-online' : 'badge-offline'}">${onlineText}</span>
                    <span class="${P.taskBadgeClass(vehicle.online ? vehicle.task_status : '离线')}">${P.escapeHtml(vehicle.online ? vehicle.task_status : '离线')}</span>
                    <span class="${vehicle.risk_key === 'medium' ? 'badge badge-warn' : vehicle.risk_key === 'high' ? 'badge badge-danger' : vehicle.online ? 'badge badge-safe' : 'badge badge-idle'}">${P.escapeHtml(vehicle.online ? vehicle.risk_level : '--')}</span>
                </div>
            </button>`;
        }).join('');
    }
    function selectedVehicle() {
        return fleet.find((vehicle) => vehicle.vehicle_id === selectedVehicleId) || fleet[0];
    }
    function renderDetail() {
        const vehicle = selectedVehicle();
        if (!vehicle) return;
        document.getElementById('fleetDetailId').textContent = vehicle.vehicle_id;
        document.getElementById('fleetDetailOnline').textContent = vehicle.online ? '在线' : '离线';
        document.getElementById('fleetDetailOnline').className = `badge ${vehicle.online ? 'badge-online' : 'badge-offline'}`;
        document.getElementById('fleetDetailTask').textContent = vehicle.online ? vehicle.task_status : '离线';
        document.getElementById('fleetDetailZone').textContent = vehicle.zone_name || P.FOCUS_ZONE_NAME;
        document.getElementById('fleetDetailRisk').textContent = vehicle.online ? vehicle.risk_level : '--';
        document.getElementById('fleetDetailLng').textContent = P.fmtNumber(vehicle.longitude, 6);
        document.getElementById('fleetDetailLat').textContent = P.fmtNumber(vehicle.latitude, 6);
        document.getElementById('fleetDetailSpeed').textContent = vehicle.online && typeof vehicle.speed === 'number' ? `${vehicle.speed.toFixed(3)} m/s` : '--';
        document.getElementById('fleetDetailHeading').textContent = typeof vehicle.heading === 'number' ? `${vehicle.heading.toFixed(1)}°` : '--';
        document.getElementById('fleetDetailCurrentTask').textContent = vehicle.current_task || vehicle.task_status || '--';
        document.getElementById('fleetDetailEvent').textContent = vehicle.latest_event || '--';
        document.getElementById('fleetDetailTimeline').innerHTML = [
            `${vehicle.last_update || '--'} · ${vehicle.online ? '车辆状态在线' : '车辆离线'}`,
            `${vehicle.zone_name || P.FOCUS_ZONE_NAME} · ${vehicle.risk_level || '--'}`,
            `${vehicle.current_task || '待命'} · ${vehicle.latest_event || '--'}`,
        ].map((item) => `<div class="timeline-item">${P.escapeHtml(item)}</div>`).join('');
        document.getElementById('fleetMapHud').textContent = `${vehicle.vehicle_id} · ${vehicle.zone_name || P.FOCUS_ZONE_NAME}`;
    }
    function renderMap() {
        if (!map) return;
        fleet.forEach((vehicle, index) => {
            const [x, y] = simPoint(vehicle, index);
            const latlng = P.simToLatLng(x, y);
            const style = {
                radius: vehicle.vehicle_id === selectedVehicleId ? 9 : 7,
                color: markerColor(vehicle),
                fillColor: markerColor(vehicle),
                fillOpacity: vehicle.online ? .82 : .38,
                weight: vehicle.vehicle_id === selectedVehicleId ? 3 : 1.4,
            };
            if (!markers[vehicle.vehicle_id]) {
                markers[vehicle.vehicle_id] = L.circleMarker(latlng, style).addTo(map);
                markers[vehicle.vehicle_id].on('click', () => {
                    selectedVehicleId = vehicle.vehicle_id;
                    renderAll();
                });
            } else {
                markers[vehicle.vehicle_id].setLatLng(latlng);
                markers[vehicle.vehicle_id].setStyle(style);
            }
            markers[vehicle.vehicle_id].bindTooltip(`${vehicle.vehicle_id} · ${vehicle.online ? vehicle.task_status : '离线'}`);
        });
    }
    function renderAll() {
        renderStats();
        renderList();
        renderDetail();
        renderMap();
    }
    function patchFocusVehicle(patch) {
        fleet = P.upsertVehicle(fleet, P.DISPLAY_ALIAS.vehicleName, patch);
        renderAll();
    }
    function handleAgv(data) {
        const mode = data.mode || 'idle';
        const position = data.position || {};
        patchFocusVehicle({
            online: data.source === 'ros2',
            task_status: P.taskStatus(mode, mode === 'mission'),
            speed: typeof data.speed === 'number' ? data.speed : 0,
            longitude: typeof position.x === 'number' ? position.x : null,
            latitude: typeof position.y === 'number' ? position.y : null,
            sim_x: typeof position.x === 'number' ? position.x : 0,
            sim_y: typeof position.y === 'number' ? position.y : 0,
            heading: data.orientation ? data.orientation.yaw : null,
            latest_event: data.source === 'ros2' ? '车辆位置实时更新' : '等待车辆实时回传',
            last_update: data.timestamp || new Date().toISOString(),
        });
    }
    function handleRisk(data) {
        const level = data.risk_level || P.riskStateToLevel(data.risk_state || 'safe');
        patchFocusVehicle({
            risk_level: data.risk_level_cn || P.riskLevelText(level),
            risk_key: level,
            latest_event: data.reasons && data.reasons.length ? data.reasons[0] : '风险状态更新',
        });
    }
    function handleMission(data) {
        patchFocusVehicle({
            task_status: data.running ? '作业中' : P.taskStatus(data.mode || 'idle', false),
            current_task: data.route_name || '待命巡检',
            latest_event: data.running ? `执行 ${data.route_name || '任务'} ${data.waypoint_index || 0}/${data.total_waypoints || 0}` : '任务监测中',
        });
    }
    async function loadInitialState() {
        try { handleAgv(await P.fetchJson('/api/agv/latest')); } catch (e) {}
        try { handleRisk(await P.fetchJson('/api/risk/current')); } catch (e) {}
        try { handleMission(await P.fetchJson('/api/mission/status')); } catch (e) {}
        try { P.updateSystemStatus(await P.fetchJson('/api/system/status')); } catch (e) {}
    }
    function bindEvents() {
        document.getElementById('fleetSearch').addEventListener('input', renderAll);
        document.getElementById('fleetFilter').addEventListener('change', renderAll);
        document.getElementById('fleetPageList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-vehicle]');
            if (!row) return;
            selectedVehicleId = row.dataset.vehicle;
            renderAll();
        });
        document.getElementById('fleetLocateBtn').addEventListener('click', () => {
            const vehicle = selectedVehicle();
            const index = fleet.findIndex((item) => item.vehicle_id === vehicle.vehicle_id);
            const [x, y] = simPoint(vehicle, index);
            map.setView(P.simToLatLng(x, y), 2);
        });
    }
    document.addEventListener('DOMContentLoaded', async () => {
        P.startClock();
        map = P.initSimpleMap('fleetMap', {noAttribution: true});
        bindEvents();
        renderAll();
        P.connectLiveData({onAgv: handleAgv, onRisk: handleRisk, onMission: handleMission, onSystem: P.updateSystemStatus});
        await loadInitialState();
    });
})();
