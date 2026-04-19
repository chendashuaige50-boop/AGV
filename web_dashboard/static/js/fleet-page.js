(function () {
    const P = window.Platform;
    let fleet = enrichFleet(P.createInitialFleetState());
    let selectedVehicleId = P.DISPLAY_ALIAS.vehicleName;
    let activeQuickFilter = 'all';
    let map = null;
    const markerRefs = {};
    const fleetPanes = {
        base: 'fleet-base-pane',
        area: 'fleet-area-pane',
        corridor: 'fleet-corridor-pane',
        risk: 'fleet-risk-pane',
        vehicle: 'fleet-vehicle-pane',
        label: 'fleet-label-pane',
    };
    const eventFeed = [
        {vehicle_id: 'YK-AGV-003', level: 'warn', text: '进入周口港重点监测区，风险等级中风险', time: '最近 5 秒'},
        {vehicle_id: 'YK-AGV-002', level: 'info', text: '完成车辆心跳同步，处于待命状态', time: '最近 12 秒'},
        {vehicle_id: 'YK-AGV-004', level: 'critical', text: '车辆离线，等待重新接入', time: '离线'},
    ];

    function enrichFleet(items) {
        const defaults = {
            'YK-AGV-001': {
                sim_x: 0,
                sim_y: 0,
                risk_score: 0,
                risk_source: '车辆终端 / 风险引擎',
                risk_reason: '等待车辆实时风险回传',
                monitor_zone: '否',
                task_stage: '待命监测',
                target_area: '周口港重点监测区',
                task_progress: 0,
                event_log: ['等待车辆实时回传', '平台服务已接入', '风险引擎待同步'],
            },
            'YK-AGV-002': {
                sim_x: 72,
                sim_y: -52,
                risk_score: 0.12,
                risk_source: '低速待命 / 无风险区叠加',
                risk_reason: '车辆位于作业缓冲区，当前无明显风险',
                monitor_zone: '否',
                task_stage: '待命',
                target_area: '堆场装卸口',
                task_progress: 0,
                event_log: ['完成心跳同步', '处于待命区域', '无风险告警'],
            },
            'YK-AGV-003': {
                sim_x: -36,
                sim_y: 18,
                risk_score: 0.52,
                risk_source: '重点监测区 / 地面风险叠加',
                risk_reason: '车辆靠近重点监测区，建议关注速度与路线执行',
                monitor_zone: '是',
                task_stage: '港区转运',
                target_area: '集装箱堆场',
                task_progress: 58,
                event_log: ['进入重点监测区', '任务执行中', '风险等级中风险'],
            },
            'YK-AGV-004': {
                sim_x: 126,
                sim_y: -72,
                risk_score: 0,
                risk_source: '无实时数据',
                risk_reason: '车辆离线，暂无实时风险评估',
                monitor_zone: '未知',
                task_stage: '离线',
                target_area: '待命区',
                task_progress: 0,
                event_log: ['车辆离线', '等待重新接入', '任务未绑定'],
            },
        };
        return items.map((item) => Object.assign({}, defaults[item.vehicle_id] || {}, item));
    }
    function selectedVehicle() {
        return fleet.find((vehicle) => vehicle.vehicle_id === selectedVehicleId) || fleet[0];
    }
    function getFilters() {
        return {
            query: (document.getElementById('fleetSearch').value || '').trim().toLowerCase(),
            online: document.getElementById('fleetOnlineFilter').value,
            task: document.getElementById('fleetTaskFilter').value,
            risk: document.getElementById('fleetRiskFilter').value,
        };
    }
    function isAlertVehicle(vehicle) {
        return vehicle.online && ['medium', 'high'].includes(vehicle.risk_key);
    }
    function onlineText(vehicle) {
        return vehicle.online ? '在线' : '离线';
    }
    function taskText(vehicle) {
        return vehicle.online ? (vehicle.task_status || '待命') : '离线';
    }
    function riskText(vehicle) {
        return vehicle.online ? (vehicle.risk_level || '低风险') : '--';
    }
    function riskBadgeClass(vehicle) {
        if (!vehicle.online) return 'badge badge-idle';
        if (vehicle.risk_key === 'high') return 'badge badge-danger';
        if (vehicle.risk_key === 'medium') return 'badge badge-warn';
        return 'badge badge-safe';
    }
    function taskFilterMatches(vehicle, filter) {
        if (filter === 'all') return true;
        if (filter === 'active') return vehicle.task_status === '作业中';
        if (filter === 'standby') return vehicle.online && vehicle.task_status === '待命';
        if (filter === 'manual') return vehicle.task_status === '人工接管';
        if (filter === 'offline') return !vehicle.online;
        return true;
    }
    function riskFilterMatches(vehicle, filter) {
        if (filter === 'all') return true;
        if (filter === 'alert') return isAlertVehicle(vehicle);
        return vehicle.online && vehicle.risk_key === filter;
    }
    function filteredFleet() {
        const filter = getFilters();
        return fleet.filter((vehicle) => {
            const queryMatch = !filter.query ||
                vehicle.vehicle_id.toLowerCase().includes(filter.query) ||
                (vehicle.display_name || '').toLowerCase().includes(filter.query);
            const onlineMatch = filter.online === 'all' ||
                (filter.online === 'online' && vehicle.online) ||
                (filter.online === 'offline' && !vehicle.online);
            return queryMatch && onlineMatch && taskFilterMatches(vehicle, filter.task) && riskFilterMatches(vehicle, filter.risk);
        });
    }
    function markerColor(vehicle) {
        if (!vehicle.online) return '#64748b';
        if (vehicle.risk_key === 'high') return '#ff5f7f';
        if (vehicle.risk_key === 'medium') return '#ffd44f';
        if (vehicle.task_status === '作业中') return '#ff9e4a';
        return '#65f3b4';
    }
    function rectFromCenter(center, size, padX = 0, padY = 0) {
        const [cx, cy] = center;
        const [sx, sy] = size;
        return [[cy - sy / 2 - padY, cx - sx / 2 - padX], [cy + sy / 2 + padY, cx + sx / 2 + padX]];
    }
    function addMapLabel(latlng, title, subtitle, variant) {
        return L.marker(latlng, {
            pane: fleetPanes.label,
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
                className: '',
                iconSize: [0, 0],
                iconAnchor: [0, 0],
                html: `<div class="fleet-map-label ${variant || ''}">${P.escapeHtml(title)}${subtitle ? `<small>${P.escapeHtml(subtitle)}</small>` : ''}</div>`,
            }),
        }).addTo(map);
    }
    function drawArea(center, size, title, subtitle, variant) {
        const styles = {
            operation: {color: '#5de8ff', fill: 'rgba(45, 151, 197, .24)', opacity: .78},
            yard: {color: '#4d88ff', fill: 'rgba(63, 104, 179, .18)', opacity: .62},
            staging: {color: '#65f3b4', fill: 'rgba(54, 174, 131, .16)', opacity: .58},
            gate: {color: '#ff9e4a', fill: 'rgba(255, 158, 74, .14)', opacity: .62},
        }[variant] || {color: '#5de8ff', fill: 'rgba(93,232,255,.12)', opacity: .58};
        L.rectangle(rectFromCenter(center, size, 5, 5), {
            pane: fleetPanes.area,
            className: `fleet-area fleet-area-${variant || 'default'}`,
            color: styles.color,
            weight: 2,
            opacity: styles.opacity * .55,
            fillColor: styles.fill,
            fillOpacity: .22,
        }).addTo(map);
        L.rectangle(rectFromCenter(center, size), {
            pane: fleetPanes.area,
            className: `fleet-area-core fleet-area-${variant || 'default'}`,
            color: styles.color,
            weight: 1.2,
            opacity: styles.opacity,
            fillColor: styles.fill,
            fillOpacity: .7,
        }).addTo(map);
        addMapLabel([center[1], center[0]], title, subtitle, variant === 'operation' ? 'is-strong' : '');
    }
    function drawCorridor(points, width, title, subtitle, tone) {
        const palette = {
            primary: {halo: '#5de8ff', core: '#9cf9ff', fill: 'rgba(93, 232, 255, .22)', axis: '#d7fdff', weight: 18},
            secondary: {halo: '#4d88ff', core: '#8fc3ff', fill: 'rgba(77, 136, 255, .16)', axis: '#bedaff', weight: 14},
            connector: {halo: '#65f3b4', core: '#9ff7cd', fill: 'rgba(101, 243, 180, .12)', axis: '#ccffe4', weight: 13},
        }[tone] || {halo: '#5de8ff', core: '#9cf9ff', fill: 'rgba(93, 232, 255, .18)', axis: '#d7fdff', weight: 14};
        const latlngs = points.map(([x, y]) => [y, x]);
        L.polyline(latlngs, {
            pane: fleetPanes.corridor,
            className: 'fleet-corridor-halo',
            color: palette.halo,
            weight: width + palette.weight,
            opacity: .18,
            lineCap: 'round',
            lineJoin: 'round',
        }).addTo(map);
        L.polyline(latlngs, {
            pane: fleetPanes.corridor,
            className: 'fleet-corridor-band',
            color: palette.halo,
            weight: width + 6,
            opacity: .32,
            lineCap: 'round',
            lineJoin: 'round',
        }).addTo(map);
        L.polyline(latlngs, {
            pane: fleetPanes.corridor,
            className: 'fleet-corridor-core',
            color: palette.core,
            weight: Math.max(6, width * .42),
            opacity: .72,
            lineCap: 'round',
            lineJoin: 'round',
        }).addTo(map);
        L.polyline(latlngs, {
            pane: fleetPanes.corridor,
            className: 'fleet-corridor-axis',
            color: palette.axis,
            weight: 1.5,
            opacity: .82,
            dashArray: '10 10',
            lineCap: 'round',
            lineJoin: 'round',
        }).addTo(map);
        const mid = points[Math.floor(points.length / 2)];
        addMapLabel([mid[1], mid[0]], title, subtitle, 'is-corridor');
    }
    function drawRiskZone(center, size, title, subtitle, level) {
        const palette = {
            low: {color: '#65f3b4', fill: 'rgba(101, 243, 180, .14)'},
            medium: {color: '#ffd44f', fill: 'rgba(255, 212, 79, .16)'},
            high: {color: '#ff5f7f', fill: 'rgba(255, 95, 127, .18)'},
        }[level] || {color: '#ffd44f', fill: 'rgba(255, 212, 79, .14)'};
        L.rectangle(rectFromCenter(center, size, 8, 8), {
            pane: fleetPanes.risk,
            className: `fleet-risk-zone fleet-risk-${level}`,
            color: palette.color,
            weight: 2.4,
            opacity: .32,
            fillColor: palette.fill,
            fillOpacity: .16,
            dashArray: '8 8',
        }).addTo(map);
        L.rectangle(rectFromCenter(center, size), {
            pane: fleetPanes.risk,
            className: `fleet-risk-zone-core fleet-risk-${level}`,
            color: palette.color,
            weight: 1.3,
            opacity: .78,
            fillColor: palette.fill,
            fillOpacity: .42,
        }).addTo(map);
        addMapLabel([center[1], center[0]], title, subtitle, `is-risk is-${level}`);
    }
    function initFleetOperationalMap() {
        const bounds = (window.SCENE_CONTEXT && window.SCENE_CONTEXT.local_map_bounds) || {min_x: -200, max_x: 200, min_y: -200, max_y: 200};
        map = L.map('fleetMap', {crs: L.CRS.Simple, minZoom: -3, maxZoom: 6, zoomControl: true}).setView([0, 0], 1);
        [
            [fleetPanes.base, 300, 'none'],
            [fleetPanes.area, 330, 'none'],
            [fleetPanes.corridor, 360, 'none'],
            [fleetPanes.risk, 390, 'none'],
            [fleetPanes.vehicle, 470, 'auto'],
            [fleetPanes.label, 520, 'none'],
        ].forEach(([name, zIndex, pointerEvents]) => {
            const pane = map.createPane(name);
            pane.style.zIndex = zIndex;
            pane.style.pointerEvents = pointerEvents;
        });
        const southWest = [bounds.min_y, bounds.min_x];
        const northEast = [bounds.max_y, bounds.max_x];
        L.rectangle([southWest, northEast], {
            pane: fleetPanes.base,
            className: 'fleet-map-base',
            color: '#102132',
            weight: 2,
            opacity: .92,
            fillColor: '#050b14',
            fillOpacity: 1,
        }).addTo(map);
        L.rectangle([[bounds.min_y + 12, bounds.min_x + 12], [bounds.max_y - 12, bounds.max_x - 12]], {
            pane: fleetPanes.base,
            className: 'fleet-map-inner-frame',
            color: '#1d5d80',
            weight: 1.4,
            opacity: .46,
            fillColor: 'rgba(7, 18, 34, .54)',
            fillOpacity: .82,
        }).addTo(map);
        L.polygon([[55, -168], [84, -138], [96, 138], [65, 168], [42, 166], [32, -166]], {
            pane: fleetPanes.area,
            className: 'fleet-dock-water',
            color: '#1f5f83',
            weight: 1.4,
            opacity: .28,
            fillColor: 'rgba(24, 86, 121, .22)',
            fillOpacity: .64,
        }).addTo(map);
        drawArea([0, 22], [304, 58], '港机作业区', '装卸作业面', 'operation');
        drawArea([-18, -74], [180, 72], '集装箱堆场', '核心堆存区', 'yard');
        drawArea([116, -58], [90, 60], '车辆待命区', '调度缓冲', 'staging');
        drawArea([156, 18], [48, 44], '港区接入点', '车辆出入', 'gate');
        drawCorridor([[-128, 10], [132, 10]], 14, '主通行走廊', '无人集卡主运行带', 'primary');
        drawCorridor([[-118, -42], [128, -42]], 12, '辅助通行走廊', '堆场转运运行带', 'secondary');
        drawCorridor([[128, 10], [128, -42], [72, -42]], 11, '联络通道', '区域切换带', 'connector');
        drawRiskZone([-20, 10], [42, 18], '重点监测区 A', '低风险监测', 'low');
        drawRiskZone([36, 10], [54, 18], '重点监测区 B', '中风险预警', 'medium');
        L.circle([-40, 0], {
            pane: fleetPanes.risk,
            className: 'fleet-risk-zone fleet-risk-high',
            radius: 18,
            color: '#ff5f7f',
            weight: 2,
            opacity: .36,
            fillColor: 'rgba(255,95,127,.16)',
            fillOpacity: .24,
            dashArray: '8 8',
        }).addTo(map);
        L.circle([-40, 0], {
            pane: fleetPanes.risk,
            className: 'fleet-risk-zone-core fleet-risk-high',
            radius: 10,
            color: '#ff8fa3',
            weight: 1.4,
            opacity: .82,
            fillColor: 'rgba(255,95,127,.28)',
            fillOpacity: .48,
        }).addTo(map);
        addMapLabel([-40, 0], '重点监测区 C', '高风险预警', 'is-risk is-high');
        addMapLabel([0, 0], '港区参考点', '0,0', 'is-subtle');
        map.fitBounds([southWest, northEast], {padding: [16, 16]});
        if (map.attributionControl) map.attributionControl.setPrefix('');
    }
    function simPoint(vehicle, index) {
        if (typeof vehicle.sim_x === 'number' && typeof vehicle.sim_y === 'number') return [vehicle.sim_x, vehicle.sim_y];
        return [[0, 0], [72, -52], [-36, 18], [126, -72]][index] || [0, 0];
    }
    function riskSortValue(vehicle) {
        return typeof vehicle.risk_score === 'number' ? vehicle.risk_score : ({high: 0.9, medium: 0.55, low: 0.12})[vehicle.risk_key] || 0;
    }
    function applyQuickFilter(filterName) {
        activeQuickFilter = filterName;
        document.getElementById('fleetSearch').value = '';
        document.getElementById('fleetOnlineFilter').value = 'all';
        document.getElementById('fleetTaskFilter').value = 'all';
        document.getElementById('fleetRiskFilter').value = 'all';
        if (filterName === 'online') document.getElementById('fleetOnlineFilter').value = 'online';
        if (filterName === 'offline') document.getElementById('fleetOnlineFilter').value = 'offline';
        if (filterName === 'active') document.getElementById('fleetTaskFilter').value = 'active';
        if (filterName === 'alert') document.getElementById('fleetRiskFilter').value = 'alert';
        renderAll();
    }
    function updateKpiActiveState() {
        document.querySelectorAll('[data-kpi-filter]').forEach((node) => {
            node.classList.toggle('is-active', node.dataset.kpiFilter === activeQuickFilter);
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
        document.getElementById('mapAlertCount').textContent = `预警 ${stats.alert}`;
        document.getElementById('mapRiskCount').textContent = stats.alert;
        updateKpiActiveState();
    }
    function renderFilterSummary(rows) {
        const filter = getFilters();
        const parts = [];
        if (filter.query) parts.push(`搜索 "${filter.query}"`);
        if (filter.online !== 'all') parts.push(filter.online === 'online' ? '仅在线' : '仅离线');
        if (filter.task !== 'all') parts.push(({active: '作业中', standby: '待命', manual: '人工接管', offline: '离线'})[filter.task]);
        if (filter.risk !== 'all') parts.push(({low: '低风险', medium: '中风险', high: '高风险', alert: '仅预警'})[filter.risk]);
        document.getElementById('fleetFilterSummary').textContent = `${parts.length ? parts.join(' / ') : '显示全部车辆'} · ${rows.length}/${fleet.length} 台`;
    }
    function renderList() {
        const rows = filteredFleet();
        renderFilterSummary(rows);
        document.getElementById('fleetListCount').textContent = `${rows.length} 台`;
        const list = document.getElementById('fleetPageList');
        if (!rows.length) {
            list.innerHTML = '<div class="support-empty">暂无匹配车辆，请调整筛选条件</div>';
            return;
        }
        list.innerHTML = rows.map((vehicle) => {
            const selected = vehicle.vehicle_id === selectedVehicleId;
            const speed = vehicle.online && typeof vehicle.speed === 'number' ? `${vehicle.speed.toFixed(2)} m/s` : '--';
            return `<button class="fleet-row ${selected ? 'is-selected' : ''}" data-vehicle="${P.escapeHtml(vehicle.vehicle_id)}" type="button">
                <div class="fleet-row-main">
                    <span class="fleet-row-id">${P.escapeHtml(vehicle.vehicle_id)}</span>
                    <span class="fleet-row-speed">${P.escapeHtml(speed)}</span>
                </div>
                <div class="fleet-row-tags">
                    <span class="badge ${vehicle.online ? 'badge-online' : 'badge-offline'}">${onlineText(vehicle)}</span>
                    <span class="${P.taskBadgeClass(taskText(vehicle))}">${P.escapeHtml(taskText(vehicle))}</span>
                    <span class="${riskBadgeClass(vehicle)}">${P.escapeHtml(riskText(vehicle))}</span>
                </div>
                <div class="fleet-row-meta">
                    <span>${P.escapeHtml(vehicle.zone_name || P.FOCUS_ZONE_NAME)}</span>
                    <span class="focus-tag">当前关注</span>
                </div>
            </button>`;
        }).join('');
    }
    function renderDetail() {
        const vehicle = selectedVehicle();
        if (!vehicle) return;
        const riskKey = vehicle.online ? (vehicle.risk_key || 'low') : 'idle';
        const progress = Math.max(0, Math.min(100, vehicle.task_progress || 0));
        document.getElementById('heroFocusVehicle').textContent = vehicle.vehicle_id;
        document.getElementById('mapFocusVehicle').textContent = vehicle.vehicle_id;
        document.getElementById('mapFocusMeta').textContent = `${vehicle.zone_name || P.FOCUS_ZONE_NAME} · ${taskText(vehicle)}`;
        document.getElementById('fleetDetailId').textContent = vehicle.vehicle_id;
        document.getElementById('fleetDetailOnline').textContent = onlineText(vehicle);
        document.getElementById('fleetDetailOnline').className = `badge ${vehicle.online ? 'badge-online' : 'badge-offline'}`;
        document.getElementById('fleetDetailRiskBadge').textContent = riskText(vehicle);
        document.getElementById('fleetDetailRiskBadge').className = riskBadgeClass(vehicle);
        document.getElementById('fleetDetailTask').textContent = taskText(vehicle);
        document.getElementById('fleetDetailZone').textContent = vehicle.zone_name || P.FOCUS_ZONE_NAME;
        document.getElementById('fleetDetailLng').textContent = P.fmtNumber(vehicle.longitude, 6);
        document.getElementById('fleetDetailLat').textContent = P.fmtNumber(vehicle.latitude, 6);
        document.getElementById('fleetDetailSpeed').textContent = vehicle.online && typeof vehicle.speed === 'number' ? `${vehicle.speed.toFixed(3)} m/s` : '--';
        document.getElementById('fleetDetailHeading').textContent = typeof vehicle.heading === 'number' ? `${vehicle.heading.toFixed(1)}°` : '--';
        document.getElementById('fleetDetailCurrentTask').textContent = vehicle.current_task || taskText(vehicle);
        document.getElementById('fleetDetailTaskStage').textContent = vehicle.task_stage || taskText(vehicle);
        document.getElementById('fleetDetailTarget').textContent = vehicle.target_area || '周口港重点监测区';
        document.getElementById('fleetDetailProgressFill').style.width = `${progress}%`;
        document.getElementById('fleetDetailProgressText').textContent = `任务进度 ${progress}%`;
        document.getElementById('fleetDetailRiskScore').textContent = vehicle.online ? P.fmtNumber(vehicle.risk_score, 3) : '--';
        document.getElementById('fleetDetailRiskSource').textContent = vehicle.risk_source || '--';
        document.getElementById('fleetDetailMonitorZone').textContent = vehicle.monitor_zone || '否';
        document.getElementById('fleetDetailRiskReason').textContent = vehicle.risk_reason || '正常运行';
        const riskCard = document.getElementById('fleetRiskSummaryCard');
        riskCard.className = `risk-summary-card ${riskKey === 'high' ? 'is-danger' : riskKey === 'medium' ? 'is-warn' : ''}`;
        const events = vehicle.event_log || [];
        document.getElementById('fleetDetailTimeline').innerHTML = events.slice(0, 5).map((item) => `<div class="timeline-item">${P.escapeHtml(item)}</div>`).join('');
        document.getElementById('fleetMapHud').textContent = `${vehicle.vehicle_id} · ${vehicle.zone_name || P.FOCUS_ZONE_NAME} · ${riskText(vehicle)}`;
    }
    function renderMap() {
        if (!map) return;
        const visibleIds = new Set(filteredFleet().map((vehicle) => vehicle.vehicle_id));
        fleet.forEach((vehicle, index) => {
            const selected = vehicle.vehicle_id === selectedVehicleId;
            const visible = visibleIds.has(vehicle.vehicle_id);
            const [x, y] = simPoint(vehicle, index);
            const latlng = P.simToLatLng(x, y);
            const color = markerColor(vehicle);
            const faded = visible ? '' : 'is-filtered-out';
            const selectedClass = selected ? 'is-selected' : '';
            const statusClass = !vehicle.online ? 'is-offline' : isAlertVehicle(vehicle) ? 'is-alert' : vehicle.task_status === '作业中' ? 'is-active' : 'is-online';
            const markerHtml = `<div class="fleet-vehicle-marker ${statusClass} ${selectedClass} ${faded}" style="--marker-color:${color}">
                <span class="vehicle-pulse"></span>
                <span class="vehicle-ring"></span>
                <span class="vehicle-core"></span>
            </div>`;
            if (!markerRefs[vehicle.vehicle_id]) {
                const marker = L.marker(latlng, {
                    pane: fleetPanes.vehicle,
                    interactive: true,
                    keyboard: false,
                    icon: L.divIcon({
                        className: '',
                        html: markerHtml,
                        iconSize: [42, 42],
                        iconAnchor: [21, 21],
                    }),
                }).addTo(map);
                const label = L.marker(latlng, {
                    pane: fleetPanes.label,
                    interactive: false,
                    icon: L.divIcon({
                        className: '',
                        html: `<div class="fleet-marker-label">${P.escapeHtml(vehicle.vehicle_id)}</div>`,
                        iconSize: [0, 0],
                        iconAnchor: [-10, -12],
                    }),
                }).addTo(map);
                marker.on('click', () => {
                    selectedVehicleId = vehicle.vehicle_id;
                    renderAll();
                    map.setView(latlng, Math.max(map.getZoom(), 2));
                });
                markerRefs[vehicle.vehicle_id] = {marker, label};
            } else {
                markerRefs[vehicle.vehicle_id].marker.setLatLng(latlng);
                markerRefs[vehicle.vehicle_id].marker.setIcon(L.divIcon({
                    className: '',
                    html: markerHtml,
                    iconSize: [42, 42],
                    iconAnchor: [21, 21],
                }));
                markerRefs[vehicle.vehicle_id].label.setLatLng(latlng);
                if (markerRefs[vehicle.vehicle_id].label._icon) {
                    markerRefs[vehicle.vehicle_id].label._icon.style.opacity = visible ? '1' : '.26';
                }
            }
            markerRefs[vehicle.vehicle_id].marker.bindTooltip(`${vehicle.vehicle_id} · ${taskText(vehicle)} · ${riskText(vehicle)}`);
        });
    }
    function renderSupport() {
        const riskVehicles = fleet
            .filter((vehicle) => vehicle.online)
            .slice()
            .sort((a, b) => riskSortValue(b) - riskSortValue(a))
            .slice(0, 4);
        document.getElementById('riskRankCount').textContent = `Top ${riskVehicles.length}`;
        document.getElementById('fleetRiskRank').innerHTML = riskVehicles.map((vehicle, index) => `<div class="support-row">
            <div><strong>${index + 1}. ${P.escapeHtml(vehicle.vehicle_id)}</strong><span>${P.escapeHtml(vehicle.zone_name || P.FOCUS_ZONE_NAME)} · ${P.escapeHtml(vehicle.risk_reason || '正常运行')}</span></div>
            <span class="${riskBadgeClass(vehicle)}">${P.escapeHtml(riskText(vehicle))}</span>
        </div>`).join('');

        const focusVehicles = fleet.filter((vehicle) => vehicle.vehicle_id === selectedVehicleId || isAlertVehicle(vehicle) || vehicle.task_status === '作业中').slice(0, 4);
        document.getElementById('fleetFocusList').innerHTML = focusVehicles.map((vehicle) => `<div class="support-row">
            <div><strong>${P.escapeHtml(vehicle.vehicle_id)}</strong><span>${P.escapeHtml(vehicle.current_task || taskText(vehicle))} · ${P.escapeHtml(vehicle.zone_name || P.FOCUS_ZONE_NAME)}</span></div>
            <span class="${vehicle.vehicle_id === selectedVehicleId ? 'badge badge-info' : riskBadgeClass(vehicle)}">${vehicle.vehicle_id === selectedVehicleId ? '关注' : P.escapeHtml(riskText(vehicle))}</span>
        </div>`).join('') || '<div class="support-empty">暂无重点关注车辆</div>';

        document.getElementById('fleetEventCount').textContent = `${eventFeed.length} 条`;
        document.getElementById('fleetEventList').innerHTML = eventFeed.slice(0, 5).map((item) => `<div class="support-row">
            <div><strong>${P.escapeHtml(item.vehicle_id)}</strong><span>${P.escapeHtml(item.time)} · ${P.escapeHtml(item.text)}</span></div>
            <span class="${item.level === 'critical' ? 'badge badge-danger' : item.level === 'warn' ? 'badge badge-warn' : 'badge badge-info'}">${item.level === 'critical' ? '严重' : item.level === 'warn' ? '预警' : '信息'}</span>
        </div>`).join('');
    }
    function renderAll() {
        renderStats();
        renderList();
        renderDetail();
        renderMap();
        renderSupport();
    }
    function pushVehicleEvent(vehicleId, level, text) {
        const now = new Date().toLocaleTimeString('zh-CN');
        eventFeed.unshift({vehicle_id: vehicleId, level, text, time: now});
        eventFeed.splice(20);
        fleet = fleet.map((vehicle) => {
            if (vehicle.vehicle_id !== vehicleId) return vehicle;
            const eventLog = [text].concat(vehicle.event_log || []).slice(0, 5);
            return Object.assign({}, vehicle, {event_log: eventLog, latest_event: text});
        });
    }
    function patchFocusVehicle(patch, eventLevel, eventText) {
        fleet = P.upsertVehicle(fleet, P.DISPLAY_ALIAS.vehicleName, patch);
        fleet = enrichFleet(fleet);
        if (eventText) pushVehicleEvent(P.DISPLAY_ALIAS.vehicleName, eventLevel || 'info', eventText);
        renderAll();
    }
    function handleAgv(data) {
        const mode = data.mode || 'idle';
        const position = data.position || {};
        const eventText = data.source === 'ros2' ? '车辆位置实时更新' : '等待车辆实时回传';
        patchFocusVehicle({
            online: data.source === 'ros2',
            task_status: P.taskStatus(mode, mode === 'mission'),
            speed: typeof data.speed === 'number' ? data.speed : 0,
            longitude: typeof position.x === 'number' ? position.x : null,
            latitude: typeof position.y === 'number' ? position.y : null,
            sim_x: typeof position.x === 'number' ? position.x : 0,
            sim_y: typeof position.y === 'number' ? position.y : 0,
            heading: data.orientation ? data.orientation.yaw : null,
            task_stage: mode === 'mission' ? '路线执行' : P.modeText(mode),
            latest_event: eventText,
            last_update: data.timestamp || new Date().toISOString(),
        }, 'info', eventText);
        document.getElementById('fleetDataTime').textContent = P.fmtTime(data.timestamp || new Date());
    }
    function handleRisk(data) {
        const level = data.risk_level || P.riskStateToLevel(data.risk_state || 'safe');
        const reason = data.reasons && data.reasons.length ? data.reasons[0] : '风险状态更新';
        patchFocusVehicle({
            risk_level: data.risk_level_cn || P.riskLevelText(level),
            risk_key: level,
            risk_score: typeof data.risk_score === 'number' ? data.risk_score : 0,
            risk_source: `地面风险 ${P.fmtNumber(data.terrain_risk, 3)} / 梯度 ${P.fmtNumber(data.gradient_mag, 5)}`,
            risk_reason: reason,
            monitor_zone: level === 'low' ? '否' : '是',
            latest_event: reason,
        }, level === 'high' ? 'critical' : level === 'medium' ? 'warn' : 'info', reason);
    }
    function handleMission(data) {
        const running = Boolean(data.running);
        const total = data.total_waypoints || 0;
        const progress = running && total ? Math.round(((data.waypoint_index || 0) / total) * 100) : 0;
        const text = running ? `执行 ${data.route_name || '任务'} ${data.waypoint_index || 0}/${total}` : '任务监测中';
        patchFocusVehicle({
            task_status: running ? '作业中' : P.taskStatus(data.mode || 'idle', false),
            current_task: data.route_name || '待命巡检',
            task_stage: running ? '航点跟踪' : '待命监测',
            target_area: running ? '任务路线下一航点' : '周口港重点监测区',
            task_progress: progress,
            latest_event: text,
        }, 'info', text);
    }
    async function loadInitialState() {
        try { handleAgv(await P.fetchJson('/api/agv/latest')); } catch (e) {}
        try { handleRisk(await P.fetchJson('/api/risk/current')); } catch (e) {}
        try { handleMission(await P.fetchJson('/api/mission/status')); } catch (e) {}
        try { P.updateSystemStatus(await P.fetchJson('/api/system/status')); } catch (e) {}
    }
    function bindEvents() {
        ['fleetSearch', 'fleetOnlineFilter', 'fleetTaskFilter', 'fleetRiskFilter'].forEach((id) => {
            document.getElementById(id).addEventListener(id === 'fleetSearch' ? 'input' : 'change', () => {
                activeQuickFilter = 'custom';
                renderAll();
            });
        });
        document.getElementById('fleetPageList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-vehicle]');
            if (!row) return;
            selectedVehicleId = row.dataset.vehicle;
            renderAll();
        });
        document.querySelectorAll('[data-kpi-filter]').forEach((button) => {
            button.addEventListener('click', () => applyQuickFilter(button.dataset.kpiFilter));
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
        initFleetOperationalMap();
        bindEvents();
        renderAll();
        P.connectLiveData({onAgv: handleAgv, onRisk: handleRisk, onMission: handleMission, onSystem: P.updateSystemStatus});
        await loadInitialState();
    });
})();
