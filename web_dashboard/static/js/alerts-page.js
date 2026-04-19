(function () {
    const P = window.Platform;
    let alerts = [];
    let selectedIndex = 0;

    function levelBadge(level) {
        return ({critical: 'badge badge-danger', warn: 'badge badge-warn', info: 'badge badge-info'})[level] || 'badge badge-idle';
    }
    function levelText(alert) {
        return alert.level_cn || ({critical: '严重', warn: '警告', info: '信息'})[alert.level] || alert.level || '--';
    }
    function filteredAlerts() {
        const level = document.getElementById('alertLevelFilter').value;
        return alerts.filter((item) => level === 'all' || item.level === level);
    }
    function renderStats() {
        const total = alerts.length;
        const critical = alerts.filter((item) => item.level === 'critical').length;
        const warn = alerts.filter((item) => item.level === 'warn').length;
        const handled = alerts.filter((item) => item.level === 'info').length;
        const pending = Math.max(0, total - handled);
        document.getElementById('alertKpiTotal').textContent = total;
        document.getElementById('alertKpiCritical').textContent = critical;
        document.getElementById('alertKpiWarn').textContent = warn;
        document.getElementById('alertKpiHandled').textContent = handled;
        document.getElementById('alertKpiPending').textContent = pending;
    }
    function renderList() {
        const rows = filteredAlerts();
        document.getElementById('alertListCount').textContent = `${rows.length} 条`;
        const list = document.getElementById('alertCenterList');
        if (!rows.length) {
            list.innerHTML = '<div class="list-row"><div class="row-meta">暂无告警事件</div></div>';
            return;
        }
        list.innerHTML = rows.map((alert, index) => `<button class="list-row ${index === selectedIndex ? 'is-selected' : ''}" data-index="${index}" type="button" style="text-align:left;cursor:pointer">
            <div class="row-top"><span class="row-title">${P.escapeHtml(alert.title || '告警事件')}</span><span class="${levelBadge(alert.level)}">${P.escapeHtml(levelText(alert))}</span></div>
            <div class="row-meta" style="margin-top:8px">${P.escapeHtml(alert.agv_id || 'agv-001')} · ${P.fmtTime(alert.timestamp)}</div>
        </button>`).join('');
    }
    function selectedAlert() {
        const rows = filteredAlerts();
        return rows[selectedIndex] || rows[0] || null;
    }
    function renderDetail() {
        const alert = selectedAlert();
        if (!alert) {
            document.getElementById('alertDetailTitle').textContent = '--';
            document.getElementById('alertDetailMessage').textContent = '暂无告警';
            document.getElementById('alertTimeline').innerHTML = '<div class="timeline-item">等待告警事件接入</div>';
            return;
        }
        document.getElementById('alertDetailTitle').textContent = alert.title || '告警事件';
        document.getElementById('alertDetailAgv').textContent = alert.agv_id || 'agv-001';
        document.getElementById('alertDetailZone').textContent = alert.zone_name || P.FOCUS_ZONE_NAME;
        document.getElementById('alertDetailTime').textContent = P.fmtTime(alert.timestamp);
        document.getElementById('alertDetailMessage').textContent = alert.message || '--';
        document.getElementById('alertDetailLevel').textContent = levelText(alert);
        document.getElementById('alertDetailLevel').className = levelBadge(alert.level);
        document.getElementById('alertTimeline').innerHTML = [
            `${P.fmtTime(alert.timestamp)} · 告警生成`,
            `${alert.agv_id || 'agv-001'} · ${alert.zone_name || P.FOCUS_ZONE_NAME}`,
            alert.level === 'info' ? '事件已归档' : '等待平台确认与处置',
        ].map((item) => `<div class="timeline-item">${P.escapeHtml(item)}</div>`).join('');
    }
    function renderAll() {
        renderStats();
        renderList();
        renderDetail();
    }
    function addAlert(alert) {
        alerts.unshift(Object.assign({zone_name: P.FOCUS_ZONE_NAME}, alert));
        alerts = alerts.slice(0, 80);
        selectedIndex = 0;
        renderAll();
    }
    async function loadInitialAlerts() {
        try {
            const data = await P.fetchJson('/api/alerts/recent?limit=60');
            alerts = (data.alerts || []).map((item) => Object.assign({zone_name: P.FOCUS_ZONE_NAME}, item));
            renderAll();
        } catch (e) {
            renderAll();
        }
        try { P.updateSystemStatus(await P.fetchJson('/api/system/status')); } catch (e) {}
    }
    function bindEvents() {
        document.getElementById('alertLevelFilter').addEventListener('change', () => {
            selectedIndex = 0;
            renderAll();
        });
        document.getElementById('alertCenterList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-index]');
            if (!row) return;
            selectedIndex = Number(row.dataset.index);
            renderAll();
        });
    }
    document.addEventListener('DOMContentLoaded', async () => {
        P.startClock();
        bindEvents();
        renderAll();
        P.connectLiveData({onAlert: addAlert, onSystem: P.updateSystemStatus});
        await loadInitialAlerts();
    });
})();
