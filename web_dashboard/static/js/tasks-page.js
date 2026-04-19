(function () {
    const P = window.Platform;
    let routes = {};
    let mission = {mode: 'idle', running: false, route_name: '', waypoint_index: 0, total_waypoints: 0};
    let riskLevel = 'low';
    let selectedRoute = '';
    let events = [];

    function progressPercent() {
        const total = mission.total_waypoints || 0;
        if (!mission.running || !total) return 0;
        return Math.max(0, Math.min(100, Math.round(((mission.waypoint_index || 0) / total) * 100)));
    }
    function renderStats() {
        const routeCount = Object.keys(routes).length;
        document.getElementById('taskKpiTotal').textContent = routeCount;
        document.getElementById('taskKpiRunning').textContent = mission.running ? 1 : 0;
        document.getElementById('taskKpiDone').textContent = mission.running ? 0 : 1;
        document.getElementById('taskKpiException').textContent = riskLevel === 'high' ? 1 : 0;
        document.getElementById('taskRouteCount').textContent = `${routeCount} 条`;
    }
    function renderRoutes() {
        const entries = Object.entries(routes);
        const list = document.getElementById('taskRouteList');
        if (!entries.length) {
            list.innerHTML = '<div class="list-row"><div class="row-meta">暂无任务路线</div></div>';
            return;
        }
        list.innerHTML = entries.map(([name, desc]) => `<div class="list-row ${name === selectedRoute || name === mission.route_name ? 'is-selected' : ''}">
            <div class="row-top"><span class="row-title">${P.escapeHtml(desc || name)}</span><span class="badge badge-info">${P.escapeHtml(name)}</span></div>
            <div class="row-meta" style="margin-top:8px">绑定车辆 YK-AGV-001 · 港区演示路线</div>
            <button class="btn" data-route="${P.escapeHtml(name)}" type="button" style="margin-top:10px;width:100%">启动任务</button>
        </div>`).join('');
    }
    function renderMission() {
        const percent = progressPercent();
        document.getElementById('taskRouteName').textContent = mission.route_name || '无';
        document.getElementById('taskWaypoint').textContent = mission.running ? `${mission.waypoint_index || 0}/${mission.total_waypoints || 0}` : '--';
        document.getElementById('taskRunningText').textContent = mission.running ? '运行中' : '未运行';
        document.getElementById('taskProgressText').textContent = `${percent}%`;
        document.getElementById('taskProgressFill').style.width = `${percent}%`;
        document.getElementById('taskModeBadge').textContent = mission.running ? '任务执行中' : P.modeText(mission.mode || 'idle');
        document.getElementById('taskModeBadge').className = mission.running ? 'badge badge-mission' : 'badge badge-idle';
    }
    function renderExceptions() {
        const list = [];
        if (riskLevel === 'high') list.push({title: '高风险联动任务', meta: '当前车辆进入高风险区域，建议关注任务执行'});
        if (!mission.running) list.push({title: '无运行中任务', meta: '当前处于待命或监测状态'});
        document.getElementById('taskExceptionList').innerHTML = list.map((item) => `<div class="list-row">
            <div class="row-top"><span class="row-title">${P.escapeHtml(item.title)}</span><span class="badge ${riskLevel === 'high' ? 'badge-danger' : 'badge-idle'}">${riskLevel === 'high' ? '异常' : '正常'}</span></div>
            <div class="row-meta" style="margin-top:8px">${P.escapeHtml(item.meta)}</div>
        </div>`).join('');
        document.getElementById('taskTimeline').innerHTML = events.slice(0, 6).map((item) => `<div class="timeline-item">${P.escapeHtml(item)}</div>`).join('') || '<div class="timeline-item">等待任务事件接入</div>';
    }
    function renderAll() {
        renderStats();
        renderRoutes();
        renderMission();
        renderExceptions();
    }
    async function startMission(routeName) {
        selectedRoute = routeName;
        try {
            await P.fetchJson('/mission/start', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({route_name: routeName}),
            });
            events.unshift(`${new Date().toLocaleTimeString('zh-CN')} · 请求启动 ${routeName}`);
        } catch (e) {
            events.unshift(`${new Date().toLocaleTimeString('zh-CN')} · 任务启动请求未完成`);
        }
        renderAll();
    }
    async function cancelMission() {
        try {
            await P.fetchJson('/mission/cancel', {method: 'POST'});
            events.unshift(`${new Date().toLocaleTimeString('zh-CN')} · 请求取消当前任务`);
        } catch (e) {
            events.unshift(`${new Date().toLocaleTimeString('zh-CN')} · 任务取消请求未完成`);
        }
        renderAll();
    }
    function handleMission(data) {
        mission = Object.assign({}, mission, data || {});
        events.unshift(`${new Date().toLocaleTimeString('zh-CN')} · 任务状态 ${mission.running ? '运行中' : '未运行'} ${mission.route_name || ''}`);
        events = events.slice(0, 20);
        renderAll();
    }
    function handleRisk(data) {
        riskLevel = data.risk_level || P.riskStateToLevel(data.risk_state || 'safe');
        if (riskLevel === 'high') events.unshift(`${new Date().toLocaleTimeString('zh-CN')} · 高风险状态触发任务联动关注`);
        events = events.slice(0, 20);
        renderAll();
    }
    async function loadInitialState() {
        try { routes = await P.fetchJson('/mission/routes'); } catch (e) { routes = {}; }
        try { handleMission(await P.fetchJson('/api/mission/status')); } catch (e) {}
        try { handleRisk(await P.fetchJson('/api/risk/current')); } catch (e) {}
        try { P.updateSystemStatus(await P.fetchJson('/api/system/status')); } catch (e) {}
        renderAll();
    }
    function bindEvents() {
        document.getElementById('taskRouteList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-route]');
            if (!button) return;
            startMission(button.dataset.route);
        });
        document.getElementById('taskCancelBtn').addEventListener('click', cancelMission);
    }
    document.addEventListener('DOMContentLoaded', async () => {
        P.startClock();
        bindEvents();
        renderAll();
        P.connectLiveData({onMission: handleMission, onRisk: handleRisk, onAlert: (alert) => {
            events.unshift(`${P.fmtTime(alert.timestamp)} · ${alert.title || '告警事件'}`);
            events = events.slice(0, 20);
            renderAll();
        }, onSystem: P.updateSystemStatus});
        await loadInitialState();
    });
})();
