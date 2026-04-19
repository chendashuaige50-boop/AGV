(function () {
    const P = window.Platform;
    let map = null;
    let heatLayer = null;
    let currentAgvSpeed = 0;

    function riskLevel(score) {
        if (score >= 0.7) return 'high';
        if (score >= 0.3) return 'medium';
        return 'low';
    }
    function renderZones() {
        const zones = (window.SCENE_CONTEXT && window.SCENE_CONTEXT.zones) || {};
        const zoneList = [
            {key: 'zone_A', title: '重点关注区 A', level: '低风险监测'},
            {key: 'zone_B', title: '重点关注区 B', level: '中风险预警'},
            {key: 'zone_C', title: '重点关注区 C', level: '高风险预警'},
        ];
        document.getElementById('riskKpiZones').textContent = zoneList.length;
        document.getElementById('riskZoneList').innerHTML = zoneList.map((zone) => {
            const item = zones[zone.key] || {};
            const center = item.center_xy || [0, 0];
            const cls = zone.key === 'zone_C' ? 'badge badge-danger' : zone.key === 'zone_B' ? 'badge badge-warn' : 'badge badge-safe';
            return `<button type="button" class="list-row" data-x="${center[0]}" data-y="${center[1]}" style="text-align:left;cursor:pointer">
                <div class="row-top"><span class="row-title">${zone.title}</span><span class="${cls}">${zone.level}</span></div>
                <div class="row-meta" style="margin-top:8px">坐标 ${P.fmtNumber(center[0], 1)}, ${P.fmtNumber(center[1], 1)}</div>
            </button>`;
        }).join('');
    }
    function renderRiskState(data) {
        const level = data.risk_level || P.riskStateToLevel(data.risk_state || 'safe');
        const levelCn = data.risk_level_cn || P.riskLevelText(level);
        document.getElementById('riskKpiScore').textContent = P.fmtNumber(data.risk_score || 0, 3);
        document.getElementById('riskKpiLevel').textContent = levelCn;
        document.getElementById('riskCurrentBadge').textContent = levelCn;
        document.getElementById('riskCurrentBadge').className = P.riskBadgeClass(level);
        document.getElementById('riskAgvId').textContent = data.agv_id || 'agv-001';
        document.getElementById('riskTerrain').textContent = P.fmtNumber(data.terrain_risk, 3);
        document.getElementById('riskGradient').textContent = P.fmtNumber(data.gradient_mag, 5);
        document.getElementById('riskSpeed').textContent = `${P.fmtNumber(currentAgvSpeed, 3)} m/s`;
        document.getElementById('riskReasonText').textContent = data.reasons && data.reasons.length ? data.reasons.join('; ') : '正常运行';
    }
    function renderHeatmapStats(points) {
        const counts = {low: 0, medium: 0, high: 0};
        points.forEach((point) => counts[riskLevel(point.risk || 0)] += 1);
        document.getElementById('riskKpiLow').textContent = counts.low;
        document.getElementById('riskKpiMedium').textContent = counts.medium;
        document.getElementById('riskKpiHigh').textContent = counts.high;
        document.getElementById('riskHeatmapCount').textContent = `${points.length} 点`;
    }
    function renderRank(points) {
        const top = points.slice().sort((a, b) => (b.risk || 0) - (a.risk || 0)).slice(0, 6);
        document.getElementById('riskRankList').innerHTML = top.map((point, index) => {
            const level = riskLevel(point.risk || 0);
            return `<div class="list-row">
                <div class="row-top"><span class="row-title">风险对象 ${index + 1}</span><span class="${P.riskBadgeClass(level)}">${P.riskLevelText(level)}</span></div>
                <div class="row-meta" style="margin-top:8px">坐标 ${P.fmtNumber(point.x, 1)}, ${P.fmtNumber(point.y, 1)} · 指数 ${P.fmtNumber(point.risk, 3)}</div>
            </div>`;
        }).join('');
    }
    async function loadHeatmap() {
        try {
            const data = await P.fetchJson('/api/risk/heatmap');
            const points = Array.isArray(data.points) ? data.points : Array.isArray(data) ? data : [];
            renderHeatmapStats(points);
            renderRank(points);
            if (heatLayer) map.removeLayer(heatLayer);
            const heatPoints = points.map((point) => {
                const latlng = P.simToLatLng(point.x, point.y);
                return [latlng[0], latlng[1], point.risk || .5];
            });
            if (heatPoints.length && L.heatLayer) {
                heatLayer = L.heatLayer(heatPoints, {
                    radius: 34,
                    blur: 22,
                    max: 1,
                    minOpacity: .32,
                    gradient: {0: '#2dd4bf', .35: '#65f3b4', .58: '#ffd44f', .78: '#ff9e4a', 1: '#ff5f7f'},
                }).addTo(map);
            }
            document.getElementById('riskMapHud').textContent = `风险热力图 · ${points.length} 个采样点`;
        } catch (e) {
            document.getElementById('riskMapHud').textContent = '风险热力图加载失败';
        }
    }
    function bindEvents() {
        document.getElementById('riskRefreshBtn').addEventListener('click', loadHeatmap);
        document.getElementById('riskZoneList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-x]');
            if (!row) return;
            map.setView(P.simToLatLng(Number(row.dataset.x), Number(row.dataset.y)), 2);
        });
    }
    async function loadInitialState() {
        try { renderRiskState(await P.fetchJson('/api/risk/current')); } catch (e) {}
        try {
            const agv = await P.fetchJson('/api/agv/latest');
            currentAgvSpeed = agv.speed || 0;
            document.getElementById('riskSpeed').textContent = `${P.fmtNumber(currentAgvSpeed, 3)} m/s`;
        } catch (e) {}
        try { P.updateSystemStatus(await P.fetchJson('/api/system/status')); } catch (e) {}
    }
    document.addEventListener('DOMContentLoaded', async () => {
        P.startClock();
        map = P.initSimpleMap('riskMap', {noAttribution: true});
        renderZones();
        bindEvents();
        P.connectLiveData({
            onRisk: renderRiskState,
            onAgv: (data) => {
                currentAgvSpeed = data.speed || 0;
                document.getElementById('riskSpeed').textContent = `${P.fmtNumber(currentAgvSpeed, 3)} m/s`;
            },
            onSystem: P.updateSystemStatus,
        });
        await loadInitialState();
        await loadHeatmap();
    });
})();
