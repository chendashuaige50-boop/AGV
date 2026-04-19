(function () {
    const DISPLAY_ALIAS = {
        siteName: '周口港',
        vehicleName: 'YK-AGV-001',
        sourceRos2: '车辆终端',
        sourceFallback: '平台服务',
    };
    const FOCUS_ZONE_NAME = '周口港重点监测区';
    const MODE_CN = {idle: '待命', manual: '人工接管', mission: '任务执行中'};
    const RISK_LEVEL_CN = {low: '低风险', medium: '中风险', high: '高风险'};
    const RISK_STATE_TO_LEVEL = {safe: 'low', warn: 'medium', danger: 'high'};
    const RISK_BADGE = {low: 'badge badge-safe', medium: 'badge badge-warn', high: 'badge badge-danger'};

    function el(id) { return document.getElementById(id); }
    function setText(id, text) {
        const node = el(id);
        if (node) node.textContent = text;
    }
    function setClass(id, className) {
        const node = el(id);
        if (node) node.className = className;
    }
    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }
    function fmtNumber(value, digits = 2, fallback = '--') {
        return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : fallback;
    }
    function fmtTime(value) {
        if (!value) return '--';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString('zh-CN');
    }
    function riskStateToLevel(riskState) {
        return RISK_STATE_TO_LEVEL[riskState] || 'low';
    }
    function riskLevelText(level) {
        return RISK_LEVEL_CN[level] || level || '低风险';
    }
    function riskBadgeClass(level) {
        return RISK_BADGE[level] || 'badge badge-safe';
    }
    function modeText(mode) {
        return MODE_CN[mode] || mode || '待命';
    }
    function taskStatus(mode, running) {
        if (running) return '作业中';
        if (mode === 'manual') return '人工接管';
        return '待命';
    }
    function taskBadgeClass(task) {
        return ({
            '作业中': 'badge badge-mission',
            '人工接管': 'badge badge-manual',
            '待命': 'badge badge-idle',
            '离线': 'badge badge-offline',
        })[task] || 'badge badge-idle';
    }
    function createInitialFleetState() {
        return [
            {
                vehicle_id: DISPLAY_ALIAS.vehicleName,
                display_name: '无人集卡01',
                online: false,
                task_status: '待命',
                risk_level: '低风险',
                risk_key: 'low',
                speed: 0,
                longitude: null,
                latitude: null,
                heading: null,
                zone_name: FOCUS_ZONE_NAME,
                current_task: '待命巡检',
                latest_event: '等待车辆实时回传',
                last_update: '',
            },
            {
                vehicle_id: 'YK-AGV-002',
                display_name: '无人集卡02',
                online: true,
                task_status: '待命',
                risk_level: '低风险',
                risk_key: 'low',
                speed: 0,
                longitude: 114.650280,
                latitude: 33.631920,
                heading: 18,
                zone_name: '周口港作业缓冲区',
                current_task: '堆场待命',
                latest_event: '最近 12 秒完成心跳',
                last_update: '最近 12 秒',
            },
            {
                vehicle_id: 'YK-AGV-003',
                display_name: '无人集卡03',
                online: true,
                task_status: '作业中',
                risk_level: '中风险',
                risk_key: 'medium',
                speed: 0.8,
                longitude: 114.651130,
                latitude: 33.632310,
                heading: 92,
                zone_name: FOCUS_ZONE_NAME,
                current_task: 'A区至堆场转运',
                latest_event: '进入重点监测区',
                last_update: '最近 5 秒',
            },
            {
                vehicle_id: 'YK-AGV-004',
                display_name: '无人集卡04',
                online: false,
                task_status: '离线',
                risk_level: '--',
                risk_key: 'idle',
                speed: null,
                longitude: null,
                latitude: null,
                heading: null,
                zone_name: '周口港待命区',
                current_task: '无',
                latest_event: '离线',
                last_update: '离线',
            },
        ];
    }
    function upsertVehicle(fleet, vehicleId, patch) {
        let found = false;
        const next = fleet.map((item) => {
            if (item.vehicle_id !== vehicleId) return item;
            found = true;
            return Object.assign({}, item, patch);
        });
        if (!found) next.push(Object.assign({vehicle_id: vehicleId, display_name: vehicleId}, patch));
        return next;
    }
    function calcFleetStats(fleet) {
        const total = fleet.length;
        const online = fleet.filter((v) => v.online).length;
        const active = fleet.filter((v) => v.online && v.task_status === '作业中').length;
        const alert = fleet.filter((v) => v.online && v.risk_level && !['低风险', '--'].includes(v.risk_level)).length;
        const offline = total - online;
        const speeds = fleet.filter((v) => v.online && typeof v.speed === 'number').map((v) => v.speed);
        const avgSpeed = speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : 0;
        return {total, online, active, alert, offline, avgSpeed};
    }
    async function fetchJson(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`${url} ${response.status}`);
        return response.json();
    }
    function updateWsStatus(status) {
        if (status === 'connected') {
            setText('statusWs', '已连接');
            setClass('dotWs', 'dot dg');
        } else if (status === 'disconnected') {
            setText('statusWs', '已断开');
            setClass('dotWs', 'dot dr');
        } else {
            setText('statusWs', '连接中…');
            setClass('dotWs', 'dot dy');
        }
    }
    function updateSystemStatus(data) {
        if (!data) return;
        if (data.backend === 'online') {
            setText('statusBackend', '在线');
            setClass('dotBackend', 'dot dg');
        } else {
            setText('statusBackend', '离线');
            setClass('dotBackend', 'dot dr');
        }
        if (data.ros2 === 'online') {
            setText('statusRos2', '在线');
            setClass('dotRos2', 'dot dg');
        } else {
            setText('statusRos2', '离线');
            setClass('dotRos2', 'dot dr');
        }
        if (data.last_update) setText('statusLastUpdate', fmtTime(data.last_update));
    }
    function connectLiveData(handlers) {
        updateWsStatus('connecting');
        const socket = io({transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity});
        socket.on('connect', () => {
            updateWsStatus('connected');
            if (handlers && handlers.onConnect) handlers.onConnect();
        });
        socket.on('disconnect', () => {
            updateWsStatus('disconnected');
            if (handlers && handlers.onDisconnect) handlers.onDisconnect();
        });
        socket.on('connect_error', () => updateWsStatus('disconnected'));
        socket.on('system_status', (data) => {
            updateSystemStatus(data);
            if (handlers && handlers.onSystem) handlers.onSystem(data);
        });
        socket.on('agv_state', (data) => {
            if (handlers && handlers.onAgv) handlers.onAgv(data);
        });
        socket.on('risk_state', (data) => {
            if (handlers && handlers.onRisk) handlers.onRisk(data);
        });
        socket.on('mission_status', (data) => {
            if (handlers && handlers.onMission) handlers.onMission(data);
        });
        socket.on('alert_event', (data) => {
            if (handlers && handlers.onAlert) handlers.onAlert(data);
        });
        return socket;
    }
    function startClock() {
        const tick = () => setText('bottomTime', new Date().toLocaleString('zh-CN'));
        tick();
        return setInterval(tick, 1000);
    }
    function simToLatLng(x, y) {
        return [y, x];
    }
    function initSimpleMap(containerId, options) {
        const bounds = (window.SCENE_CONTEXT && window.SCENE_CONTEXT.local_map_bounds) || {min_x: -200, max_x: 200, min_y: -200, max_y: 200};
        const map = L.map(containerId, {crs: L.CRS.Simple, minZoom: -3, maxZoom: 6, zoomControl: true}).setView([0, 0], 1);
        L.rectangle([[bounds.min_y, bounds.min_x], [bounds.max_y, bounds.max_x]], {
            color: '#163049',
            weight: 1.6,
            fillColor: '#060d17',
            fillOpacity: 0.98,
        }).addTo(map);
        L.rectangle([[-8, -120], [28, 130]], {
            color: '#5de8ff',
            weight: 1.4,
            fillColor: 'rgba(93,232,255,.14)',
            fillOpacity: .62,
        }).addTo(map);
        L.rectangle([[-78, -100], [-36, 122]], {
            color: '#4d88ff',
            weight: 1.2,
            fillColor: 'rgba(77,136,255,.12)',
            fillOpacity: .52,
        }).addTo(map);
        L.rectangle([[3, -40], [18, 65]], {
            color: '#ff9e4a',
            weight: 1.2,
            fillColor: 'rgba(255,158,74,.18)',
            fillOpacity: .66,
        }).addTo(map);
        L.circle([-40, 0], {
            radius: 12,
            color: '#ff5f7f',
            weight: 1.2,
            fillColor: 'rgba(255,95,127,.16)',
            fillOpacity: .6,
        }).addTo(map);
        map.fitBounds([[bounds.min_y, bounds.min_x], [bounds.max_y, bounds.max_x]], {padding: [14, 14]});
        if (options && options.noAttribution && map.attributionControl) map.attributionControl.setPrefix('');
        return map;
    }

    window.Platform = {
        DISPLAY_ALIAS,
        FOCUS_ZONE_NAME,
        MODE_CN,
        RISK_LEVEL_CN,
        createInitialFleetState,
        upsertVehicle,
        calcFleetStats,
        connectLiveData,
        updateSystemStatus,
        updateWsStatus,
        fetchJson,
        escapeHtml,
        fmtNumber,
        fmtTime,
        riskStateToLevel,
        riskLevelText,
        riskBadgeClass,
        modeText,
        taskStatus,
        taskBadgeClass,
        startClock,
        simToLatLng,
        initSimpleMap,
    };
})();
