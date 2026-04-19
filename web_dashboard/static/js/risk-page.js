(function () {
    const P = window.Platform;
    const SCENE = window.SCENE_CONTEXT || {};
    const MAP_ANCHOR = SCENE.map_anchor || {lat: 33.631, lng: 114.65};
    const METERS_PER_DEG_LAT = 111320.0;
    const METERS_PER_DEG_LNG = 111320.0 * Math.cos((MAP_ANCHOR.lat || 33.631) * Math.PI / 180);
    const ZONE_PRESETS = {
        zone_A: {
            title: 'A区主通道缓变沉降带',
            location: '主测试走廊 A 段',
            source: '沉降速率异常',
            explanation: '该区域以连续缓慢沉降为主，属于需要持续观测的基础风险带。',
        },
        zone_B: {
            title: 'B区差异沉降敏感带',
            location: '主测试走廊 B 段',
            source: '形变梯度异常',
            explanation: '该区域存在明显空间梯度变化，更容易放大车辆定位误差和姿态波动。',
        },
        zone_C: {
            title: 'C区局部陷落敏感点',
            location: '连接通道局部敏感点',
            source: '局部沉降与漂移风险叠加',
            explanation: '该区域空间尺度小、局部变化陡，进入后更容易触发高等级告警。',
        },
    };
    const state = {
        map: null,
        layerVisibility: {zones: true, heat: true, insar: true, trajectory: true},
        layers: {
            zoneGroup: null,
            insarGroup: null,
            trajectoryGroup: null,
            vehicleGroup: null,
            vehicleMarker: null,
            vehicleHalo: null,
            trajectoryLine: null,
            heatLayer: null,
            heatVersion: -1,
            zoneById: {},
            insarGeoJson: null,
        },
        zoneDefs: buildZoneDefs(),
        zoneStats: [],
        zoneEvidence: {},
        selected: {type: 'zone', id: ''},
        agv: null,
        risk: null,
        mission: null,
        system: null,
        alerts: [],
        heatPoints: [],
        heatVersion: 0,
        path: [],
        vehicleEvidence: null,
        insarLayers: null,
        insarGeoJson: null,
        insarAligned: false,
        history: {
            riskScore: [],
            speed: [],
            drift: [],
            alerts: [],
            zoneSeries: {},
        },
    };
    let lastVehicleEvidenceAt = 0;
    let vehicleEvidencePending = false;

    function buildZoneDefs() {
        const zones = SCENE.zones || {};
        return Object.keys(zones).sort().map((key) => {
            const zone = zones[key] || {};
            const preset = ZONE_PRESETS[key] || {};
            return {
                id: key,
                name: preset.title || zone.name || key,
                originalName: zone.name || key,
                location: preset.location || buildLocationText(zone),
                mainSource: preset.source || sourceFromType(zone.type),
                explanation: preset.explanation || '',
                center: Array.isArray(zone.center_xy) ? zone.center_xy : [0, 0],
                size: Array.isArray(zone.size_m) ? zone.size_m : null,
                radius: typeof zone.radius_m === 'number' ? zone.radius_m : null,
                shape: zone.shape || 'rectangle',
                type: zone.type || 'unknown',
            };
        });
    }
    function buildLocationText(zone) {
        const center = Array.isArray(zone.center_xy) ? zone.center_xy : [0, 0];
        return `坐标 ${P.fmtNumber(center[0], 1)}, ${P.fmtNumber(center[1], 1)}`;
    }
    function sourceFromType(type) {
        if (type === 'uniform_settlement') return '沉降速率异常';
        if (type === 'differential_settlement') return '形变梯度异常';
        if (type === 'local_sudden_drop') return '局部沉降与漂移风险叠加';
        return '地基风险异常';
    }
    function riskLevel(score) {
        if (score >= 0.7) return 'high';
        if (score >= 0.3) return 'medium';
        return 'low';
    }
    function levelWeight(level) {
        return ({high: 3, medium: 2, low: 1})[level] || 0;
    }
    function formatTime(value, fallback = '--') {
        return value ? P.fmtTime(value) : fallback;
    }
    function escape(value) {
        return P.escapeHtml(value == null ? '--' : value);
    }
    function formatNumber(value, digits = 2, suffix = '', fallback = '--') {
        const base = P.fmtNumber(value, digits, fallback);
        return base === fallback ? fallback : `${base}${suffix}`;
    }
    function simToLatLng(x, y) {
        return P.simToLatLng(x, y);
    }
    function wgs84ToSim(lat, lng) {
        return [
            (lng - (MAP_ANCHOR.lng || 114.65)) * METERS_PER_DEG_LNG,
            (lat - (MAP_ANCHOR.lat || 33.631)) * METERS_PER_DEG_LAT,
        ];
    }
    function zoneBounds(zone) {
        const [cx, cy] = zone.center;
        if (zone.shape === 'circle') {
            const radius = zone.radius || 2.0;
            return [[cy - radius, cx - radius], [cy + radius, cx + radius]];
        }
        const size = zone.size || [12, 12];
        return [[cy - size[1] / 2, cx - size[0] / 2], [cy + size[1] / 2, cx + size[0] / 2]];
    }
    function pointInZone(point, zone, buffer = 0) {
        if (!point) return false;
        const [cx, cy] = zone.center;
        if (zone.shape === 'circle') {
            const radius = (zone.radius || 2.0) + buffer;
            return Math.hypot(point.x - cx, point.y - cy) <= radius;
        }
        const size = zone.size || [12, 12];
        return (
            Math.abs(point.x - cx) <= size[0] / 2 + buffer &&
            Math.abs(point.y - cy) <= size[1] / 2 + buffer
        );
    }
    function distanceToZone(point, zone) {
        if (!point) return Number.POSITIVE_INFINITY;
        if (pointInZone(point, zone)) return 0;
        const [cx, cy] = zone.center;
        return Math.hypot(point.x - cx, point.y - cy);
    }
    function currentAgvPoint() {
        const position = state.agv && state.agv.position;
        if (position && typeof position.x === 'number' && typeof position.y === 'number') {
            return {x: position.x, y: position.y};
        }
        const last = state.path[state.path.length - 1];
        return last ? {x: last.x, y: last.y} : null;
    }
    function currentZoneStat() {
        const point = currentAgvPoint();
        if (!point || !state.zoneStats.length) return null;
        const direct = state.zoneStats.find((zone) => pointInZone(point, zone, 1.2));
        if (direct) return direct;
        const nearest = state.zoneStats
            .map((zone) => ({zone, dist: distanceToZone(point, zone)}))
            .sort((a, b) => a.dist - b.dist)[0];
        return nearest && nearest.dist <= 18 ? nearest.zone : null;
    }
    function selectedZoneStat() {
        return state.zoneStats.find((zone) => zone.id === state.selected.id) || null;
    }
    function findZoneStatById(zoneId) {
        return state.zoneStats.find((zone) => zone.id === zoneId) || null;
    }
    function selectedObject() {
        if (state.selected.type === 'vehicle') {
            return {
                type: 'vehicle',
                agv: state.agv,
                zone: currentZoneStat(),
            };
        }
        return {
            type: 'zone',
            zone: selectedZoneStat() || currentZoneStat() || state.zoneStats[0] || null,
        };
    }
    function latestAlert() {
        return state.alerts[0] || null;
    }
    function currentRiskLevel() {
        if (state.risk && state.risk.risk_level) return state.risk.risk_level;
        if (state.risk && state.risk.risk_state) return P.riskStateToLevel(state.risk.risk_state);
        return 'low';
    }
    function runInteraction(update, options = {}) {
        if (typeof update === 'function') update();
        if (options.render === 'map') {
            renderMap();
            syncLayerButtons();
        } else {
            renderAll();
        }
        if (typeof options.afterRender === 'function') {
            options.afterRender();
        }
    }
    function focusZone(zoneId) {
        if (!state.map) return;
        const zone = findZoneStatById(zoneId);
        if (!zone) return;
        state.map.fitBounds(zoneBounds(zone), {padding: [18, 18]});
    }
    function selectZone(zoneId, options = {}) {
        if (!zoneId) return;
        if (!findZoneStatById(zoneId) && !state.zoneDefs.some((zone) => zone.id === zoneId)) return;
        runInteraction(() => {
            state.selected = {type: 'zone', id: zoneId};
        }, {
            afterRender: options.focus !== false ? () => focusZone(zoneId) : null,
        });
    }
    function selectVehicle(options = {}) {
        const vehicleId = (state.agv && state.agv.id) || 'agv-001';
        runInteraction(() => {
            state.selected = {type: 'vehicle', id: vehicleId};
            if (options.ensureTrajectory) state.layerVisibility.trajectory = true;
        }, {
            afterRender: options.focus ? locateSelectedObject : null,
        });
    }
    function toggleLayer(key) {
        if (!Object.prototype.hasOwnProperty.call(state.layerVisibility, key)) return;
        runInteraction(() => {
            state.layerVisibility[key] = !state.layerVisibility[key];
        }, {render: 'map'});
    }
    function handleLocateAction() {
        runInteraction(null, {afterRender: locateSelectedObject});
    }
    function handleTraceAction() {
        selectVehicle({ensureTrajectory: true, focus: true});
    }
    function handleHistoryAction() {
        runInteraction(null, {
            afterRender: () => {
                const target = document.getElementById('riskTrendSparkline');
                if (target) target.scrollIntoView({block: 'nearest', behavior: 'smooth'});
            },
        });
    }
    function alarmPresentation() {
        const latest = latestAlert();
        const riskLevelKey = currentRiskLevel();
        if (riskLevelKey === 'high' || (latest && latest.level === 'critical')) {
            return {text: '重点告警', note: '高风险区域已触发告警', badge: 'badge badge-danger'};
        }
        if (riskLevelKey === 'medium' || (latest && latest.level === 'warn')) {
            return {text: '运行预警', note: '建议减速通行或绕行', badge: 'badge badge-warn'};
        }
        if (latest && latest.level === 'info') {
            return {text: '风险提示', note: '建议持续监视重点区域', badge: 'badge badge-info'};
        }
        return {text: '正常监视', note: '未触发运行级告警', badge: 'badge badge-safe'};
    }
    function dataHealthPresentation() {
        if (!state.system || state.system.ros2 !== 'online') {
            return {text: '降级', badge: 'badge badge-danger'};
        }
        if (!state.insarAligned) {
            return {text: '坐标待校准', badge: 'badge badge-warn'};
        }
        return {text: '正常', badge: 'badge badge-safe'};
    }
    function evidenceStatus(value, warnThreshold, dangerThreshold, reverse = false) {
        if (value == null || !Number.isFinite(value)) return {text: '降级', badge: 'badge badge-idle'};
        if (!reverse) {
            if (value >= dangerThreshold) return {text: '高', badge: 'badge badge-danger'};
            if (value >= warnThreshold) return {text: '中', badge: 'badge badge-warn'};
            return {text: '低', badge: 'badge badge-safe'};
        }
        if (value <= dangerThreshold) return {text: '高', badge: 'badge badge-danger'};
        if (value <= warnThreshold) return {text: '中', badge: 'badge badge-warn'};
        return {text: '低', badge: 'badge badge-safe'};
    }
    function stabilityStatus(points) {
        const variance = computePositionVariance(points);
        if (variance == null) return {text: '待接入', badge: 'badge badge-idle'};
        const spread = Math.sqrt(variance);
        if (spread >= 0.9) return {text: '波动', badge: 'badge badge-danger'};
        if (spread >= 0.45) return {text: '轻微波动', badge: 'badge badge-warn'};
        return {text: '稳定', badge: 'badge badge-safe'};
    }
    function computePositionVariance(points) {
        if (!Array.isArray(points) || points.length < 3) return null;
        const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
        return points.reduce((sum, point) => {
            const dx = point.x - cx;
            const dy = point.y - cy;
            return sum + dx * dx + dy * dy;
        }, 0) / points.length;
    }
    function computeDriftTrend(points) {
        if (!Array.isArray(points) || points.length < 8) {
            return {label: '数据不足', badge: 'badge badge-idle', delta: null};
        }
        const mid = Math.floor(points.length / 2);
        const first = Math.sqrt(computePositionVariance(points.slice(0, mid)) || 0);
        const second = Math.sqrt(computePositionVariance(points.slice(mid)) || 0);
        const delta = second - first;
        if (delta > 0.18) return {label: '上升', badge: 'badge badge-danger', delta};
        if (delta > 0.05) return {label: '轻微上升', badge: 'badge badge-warn', delta};
        if (delta < -0.08) return {label: '回落', badge: 'badge badge-safe', delta};
        return {label: '平稳', badge: 'badge badge-info', delta};
    }
    function pushLimited(list, item, limit = 24) {
        list.push(item);
        while (list.length > limit) list.shift();
    }
    function ensureZoneSeries(zoneId) {
        if (!state.history.zoneSeries[zoneId]) state.history.zoneSeries[zoneId] = [];
        return state.history.zoneSeries[zoneId];
    }
    function pushZoneHistory(zone) {
        const series = ensureZoneSeries(zone.id);
        const now = Date.now();
        const last = series[series.length - 1];
        if (last && now - last.tsMs < 4000 && Math.abs(last.value - zone.meanRisk) < 0.01) return;
        pushLimited(series, {
            value: zone.meanRisk,
            ts: zone.dataTimestamp || (state.risk && state.risk.timestamp) || new Date().toISOString(),
            tsMs: now,
            level: zone.level,
        }, 18);
    }
    function pushRiskHistory() {
        if (!state.risk) return;
        const now = Date.now();
        const last = state.history.riskScore[state.history.riskScore.length - 1];
        const value = typeof state.risk.risk_score === 'number' ? state.risk.risk_score : 0;
        if (last && now - last.tsMs < 1500 && Math.abs(last.value - value) < 0.02) return;
        pushLimited(state.history.riskScore, {
            value,
            level: currentRiskLevel(),
            ts: state.risk.timestamp || new Date().toISOString(),
            tsMs: now,
        }, 24);
    }
    function pushSpeedHistory(speed) {
        if (typeof speed !== 'number') return;
        const now = Date.now();
        const last = state.history.speed[state.history.speed.length - 1];
        if (last && now - last.tsMs < 1500 && Math.abs(last.value - speed) < 0.05) return;
        pushLimited(state.history.speed, {value: speed, tsMs: now}, 24);
    }
    function pushDriftHistory(points) {
        const variance = computePositionVariance(points);
        if (variance == null) return;
        const value = Math.sqrt(variance);
        const now = Date.now();
        const last = state.history.drift[state.history.drift.length - 1];
        if (last && now - last.tsMs < 1500 && Math.abs(last.value - value) < 0.05) return;
        pushLimited(state.history.drift, {value, tsMs: now}, 24);
    }
    function deriveZoneStats() {
        const agvPoint = currentAgvPoint();
        const next = state.zoneDefs.map((zone) => {
            const zonePoints = state.heatPoints.filter((point) => pointInZone(point, zone, 2.0));
            const sumRisk = zonePoints.reduce((sum, point) => sum + (point.risk || 0), 0);
            const meanRisk = zonePoints.length ? sumRisk / zonePoints.length : 0;
            const maxRisk = zonePoints.reduce((max, point) => Math.max(max, point.risk || 0), 0);
            const level = riskLevel(maxRisk || meanRisk);
            const evidence = state.zoneEvidence[zone.id] || {};
            const affectedVehicles = agvPoint && pointInZone(agvPoint, zone, 1.2) ? 1 : 0;
            const recentAlert = latestAlert();
            const recentAlertTime = recentAlert && affectedVehicles ? recentAlert.timestamp : null;
            return {
                ...zone,
                sampleCount: zonePoints.length,
                meanRisk,
                maxRisk,
                level,
                levelCn: P.riskLevelText(level),
                posteriorProbability: Math.round(Math.max(maxRisk, meanRisk) * 100),
                deformationRate: evidence.valid ? evidence.deformation_velocity : null,
                deformationGradient: evidence.valid ? evidence.deformation_gradient : null,
                evidenceValid: Boolean(evidence.valid),
                dataTimestamp: evidence.timestamp || null,
                affectedVehicles,
                recentAlertTime,
            };
        }).sort((a, b) => {
            const diff = levelWeight(b.level) - levelWeight(a.level);
            if (diff !== 0) return diff;
            return b.maxRisk - a.maxRisk;
        });
        state.zoneStats = next;
        state.zoneStats.forEach(pushZoneHistory);
    }
    function ensureSelection() {
        const currentZone = currentZoneStat();
        if (state.selected.type === 'vehicle') return;
        const selected = selectedZoneStat();
        if (selected) return;
        if (currentZone) {
            state.selected = {type: 'zone', id: currentZone.id};
            return;
        }
        if (state.zoneStats[0]) state.selected = {type: 'zone', id: state.zoneStats[0].id};
    }
    function zoneStyle(level, selected, active) {
        const palette = {
            low: {stroke: '#65f3b4', fill: 'rgba(101,243,180,.10)'},
            medium: {stroke: '#ffd44f', fill: 'rgba(255,212,79,.12)'},
            high: {stroke: '#ff5f7f', fill: 'rgba(255,95,127,.16)'},
        }[level] || {stroke: '#5de8ff', fill: 'rgba(93,232,255,.10)'};
        return {
            color: palette.stroke,
            fillColor: palette.fill,
            fillOpacity: selected ? 0.26 : active ? 0.18 : 0.12,
            weight: selected ? 2.8 : active ? 2.0 : 1.4,
            dashArray: active && !selected ? '6 4' : '',
        };
    }
    function vehicleRiskHaloLevel() {
        const zone = currentZoneStat();
        return zone ? zone.level : currentRiskLevel();
    }
    function tooltipForZone(zone) {
        return [
            `<strong>${escape(zone.name)}</strong>`,
            `风险等级: ${escape(zone.levelCn)}`,
            `形变速率: ${zone.deformationRate == null ? '--' : `${Math.abs(zone.deformationRate).toFixed(2)} mm/yr`}`,
            `形变梯度: ${zone.deformationGradient == null ? '--' : zone.deformationGradient.toFixed(5)}`,
            `影响车辆: ${escape(zone.affectedVehicles)}`,
        ].join('<br>');
    }
    function initMap() {
        if (state.map) return;
        state.map = P.initSimpleMap('riskMap', {noAttribution: true});
        state.layers.zoneGroup = L.layerGroup().addTo(state.map);
        state.layers.insarGroup = L.layerGroup().addTo(state.map);
        state.layers.trajectoryGroup = L.layerGroup().addTo(state.map);
        state.layers.vehicleGroup = L.layerGroup().addTo(state.map);
        renderLegend();
    }
    function setGroupVisibility(group, visible) {
        if (!state.map || !group) return;
        const onMap = state.map.hasLayer(group);
        if (visible && !onMap) group.addTo(state.map);
        if (!visible && onMap) state.map.removeLayer(group);
    }
    function renderZoneLayers() {
        if (!state.map || !state.layers.zoneGroup) return;
        if (!Object.keys(state.layers.zoneById).length) {
            state.zoneStats.forEach((zone) => {
                let layer = null;
                if (zone.shape === 'circle') {
                    layer = L.circle(simToLatLng(zone.center[0], zone.center[1]), {
                        radius: zone.radius || 2.0,
                    });
                } else {
                    layer = L.rectangle(zoneBounds(zone));
                }
                layer.on('click', () => {
                    selectZone(zone.id);
                });
                layer.bindTooltip(tooltipForZone(zone), {sticky: true});
                layer.addTo(state.layers.zoneGroup);
                state.layers.zoneById[zone.id] = layer;
            });
        }
        const activeZone = currentZoneStat();
        state.zoneStats.forEach((zone) => {
            const layer = state.layers.zoneById[zone.id];
            if (!layer) return;
            const isSelected = state.selected.type === 'zone' && state.selected.id === zone.id;
            const isActive = activeZone && activeZone.id === zone.id;
            layer.setStyle(zoneStyle(zone.level, isSelected, isActive));
            layer.setTooltipContent(tooltipForZone(zone));
        });
        setGroupVisibility(state.layers.zoneGroup, state.layerVisibility.zones);
    }
    function renderHeatLayer() {
        if (!state.map) return;
        if (!state.layerVisibility.heat) {
            if (state.layers.heatLayer && state.map.hasLayer(state.layers.heatLayer)) {
                state.map.removeLayer(state.layers.heatLayer);
            }
            return;
        }
        if (state.layers.heatVersion === state.heatVersion && state.layers.heatLayer) {
            if (!state.map.hasLayer(state.layers.heatLayer)) state.layers.heatLayer.addTo(state.map);
            return;
        }
        if (state.layers.heatLayer && state.map.hasLayer(state.layers.heatLayer)) {
            state.map.removeLayer(state.layers.heatLayer);
        }
        const heatPoints = state.heatPoints.map((point) => {
            const latlng = simToLatLng(point.x, point.y);
            return [latlng[0], latlng[1], point.risk || 0.4];
        });
        if (heatPoints.length && L.heatLayer) {
            state.layers.heatLayer = L.heatLayer(heatPoints, {
                radius: 30,
                blur: 18,
                max: 1,
                minOpacity: 0.20,
                gradient: {0: '#2dd4bf', 0.35: '#65f3b4', 0.62: '#ffd44f', 0.82: '#ff9e4a', 1: '#ff5f7f'},
            }).addTo(state.map);
            state.layers.heatVersion = state.heatVersion;
        }
    }
    function buildInsarGeoJsonLayer() {
        if (!state.map || !state.insarGeoJson || state.layers.insarGeoJson) return;
        state.layers.insarGeoJson = L.geoJSON(state.insarGeoJson, {
            coordsToLatLng: (coords) => {
                const sim = wgs84ToSim(coords[1], coords[0]);
                return L.latLng(sim[1], sim[0]);
            },
            style: (feature) => {
                const level = feature && feature.properties ? feature.properties.risk_level : 'low';
                return {
                    color: level === 'high' ? '#ff5f7f' : level === 'medium' ? '#ff9e4a' : '#65f3b4',
                    weight: 1.0,
                    fillColor: level === 'high' ? 'rgba(255,95,127,.12)' : level === 'medium' ? 'rgba(255,158,74,.10)' : 'rgba(101,243,180,.08)',
                    fillOpacity: 0.10,
                };
            },
            onEachFeature: (feature, layer) => {
                const props = feature.properties || {};
                const levelCn = props.risk_level_cn || P.riskLevelText(props.risk_level || 'low');
                const velocity = typeof props.mean_velocity_mm_yr === 'number'
                    ? `${Math.abs(props.mean_velocity_mm_yr).toFixed(2)} mm/yr`
                    : '--';
                layer.bindTooltip([
                    '<strong>InSAR 风险分区</strong>',
                    `等级: ${escape(levelCn)}`,
                    `形变速率: ${escape(velocity)}`,
                ].join('<br>'), {sticky: true});
                layer.on('click', () => {
                    const nearest = state.zoneStats
                        .map((zone) => ({zone, dist: distanceToZone(featureCenterToSim(feature), zone)}))
                        .sort((a, b) => a.dist - b.dist)[0];
                    if (nearest && nearest.zone) {
                        selectZone(nearest.zone.id, {focus: false});
                    }
                });
            },
        }).addTo(state.layers.insarGroup);
    }
    function featureCenterToSim(feature) {
        try {
            const geometry = feature.geometry || {};
            const coords = geometry.type === 'Polygon'
                ? geometry.coordinates[0]
                : geometry.type === 'MultiPolygon'
                    ? geometry.coordinates[0][0]
                    : [];
            if (!coords.length) return {x: 0, y: 0};
            const sum = coords.reduce((acc, pair) => {
                acc.lng += pair[0];
                acc.lat += pair[1];
                return acc;
            }, {lng: 0, lat: 0});
            const sim = wgs84ToSim(sum.lat / coords.length, sum.lng / coords.length);
            return {x: sim[0], y: sim[1]};
        } catch (e) {
            return {x: 0, y: 0};
        }
    }
    function renderInsarLayer() {
        if (!state.map || !state.layers.insarGroup) return;
        if (state.insarAligned) buildInsarGeoJsonLayer();
        setGroupVisibility(state.layers.insarGroup, state.layerVisibility.insar && state.insarAligned && Boolean(state.layers.insarGeoJson));
    }
    function renderTrajectoryLayer() {
        if (!state.map || !state.layers.trajectoryGroup) return;
        const latlngs = state.path.slice(-120).map((point) => simToLatLng(point.x, point.y));
        if (!state.layers.trajectoryLine) {
            state.layers.trajectoryLine = L.polyline(latlngs, {
                color: '#5de8ff',
                weight: 2.2,
                opacity: 0.82,
            }).addTo(state.layers.trajectoryGroup);
        } else {
            state.layers.trajectoryLine.setLatLngs(latlngs);
        }
        setGroupVisibility(state.layers.trajectoryGroup, state.layerVisibility.trajectory && latlngs.length > 1);
    }
    function renderVehicleLayer() {
        if (!state.map || !state.layers.vehicleGroup) return;
        const point = currentAgvPoint();
        if (!point) return;
        const latlng = simToLatLng(point.x, point.y);
        const level = vehicleRiskHaloLevel();
        const palette = {
            low: '#65f3b4',
            medium: '#ffd44f',
            high: '#ff5f7f',
        }[level] || '#5de8ff';
        if (!state.layers.vehicleMarker) {
            state.layers.vehicleMarker = L.circleMarker(latlng, {
                radius: 7,
                color: palette,
                fillColor: palette,
                fillOpacity: 0.92,
                weight: 2.4,
            }).addTo(state.layers.vehicleGroup);
            state.layers.vehicleMarker.on('click', () => {
                selectVehicle();
            });
        } else {
            state.layers.vehicleMarker.setLatLng(latlng);
            state.layers.vehicleMarker.setStyle({
                radius: 7,
                color: palette,
                fillColor: palette,
                fillOpacity: 0.92,
                weight: 2.4,
            });
        }
        const currentZone = currentZoneStat();
        if (!state.layers.vehicleHalo) {
            state.layers.vehicleHalo = L.circle(latlng, {
                radius: currentZone && currentZone.level === 'high' ? 8 : 5,
                color: palette,
                weight: 1.2,
                opacity: 0.70,
                fillOpacity: 0.05,
            }).addTo(state.layers.vehicleGroup);
        } else {
            state.layers.vehicleHalo.setLatLng(latlng);
            state.layers.vehicleHalo.setStyle({
                color: palette,
                weight: 1.2,
                opacity: 0.70,
                fillOpacity: 0.05,
            });
            state.layers.vehicleHalo.setRadius(currentZone && currentZone.level === 'high' ? 8 : 5);
        }
        const vehicleTitle = (state.agv && state.agv.id) || 'agv-001';
        const zoneName = currentZone ? currentZone.name : '通行区域';
        state.layers.vehicleMarker.bindTooltip(`${escape(vehicleTitle)} · ${escape(zoneName)}`);
    }
    function renderLegend() {
        document.getElementById('riskMapLegend').innerHTML = [
            '<div class="risk-legend-title">图层图例</div>',
            '<div class="risk-legend-row"><span class="risk-legend-dot risk-low"></span><span>低风险分区</span></div>',
            '<div class="risk-legend-row"><span class="risk-legend-dot risk-medium"></span><span>中风险分区</span></div>',
            '<div class="risk-legend-row"><span class="risk-legend-dot risk-high"></span><span>高风险分区</span></div>',
            '<div class="risk-legend-row"><span class="risk-legend-line"></span><span>车辆轨迹</span></div>',
            '<div class="risk-legend-row"><span class="risk-legend-marker"></span><span>车辆实时位置</span></div>',
        ].join('');
    }
    function renderMapHud() {
        const target = selectedObject();
        const currentZone = currentZoneStat();
        if (target.type === 'vehicle') {
            const speed = state.agv && typeof state.agv.speed === 'number' ? `${state.agv.speed.toFixed(2)} m/s` : '--';
            document.getElementById('riskMapHud').textContent = `车辆位置 · ${currentZone ? currentZone.name : '通行区域'} · 速度 ${speed}`;
            return;
        }
        const zone = target.zone;
        if (!zone) {
            document.getElementById('riskMapHud').textContent = '风险图层已加载';
            return;
        }
        document.getElementById('riskMapHud').textContent = `${zone.name} · ${zone.levelCn} · 影响车辆 ${zone.affectedVehicles}`;
    }
    function renderMap() {
        initMap();
        renderZoneLayers();
        renderHeatLayer();
        renderInsarLayer();
        renderTrajectoryLayer();
        renderVehicleLayer();
        renderMapHud();
    }
    function currentEvidenceForObject(target) {
        if (target.type === 'vehicle') {
            return {
                rate: state.vehicleEvidence && state.vehicleEvidence.valid ? state.vehicleEvidence.deformation_velocity : null,
                gradient: state.vehicleEvidence && state.vehicleEvidence.valid
                    ? state.vehicleEvidence.deformation_gradient
                    : state.risk && typeof state.risk.gradient_mag === 'number'
                        ? state.risk.gradient_mag
                        : null,
            };
        }
        const zone = target.zone;
        return {
            rate: zone ? zone.deformationRate : null,
            gradient: zone ? zone.deformationGradient : null,
        };
    }
    function renderKpis() {
        const alarm = alarmPresentation();
        const highZones = state.zoneStats.filter((zone) => zone.level === 'high').length;
        const mediumZones = state.zoneStats.filter((zone) => zone.level === 'medium').length;
        const alertVehicles = currentRiskLevel() === 'low' ? 0 : 1;
        document.getElementById('riskSummaryScore').textContent = P.fmtNumber(state.risk && state.risk.risk_score, 3);
        document.getElementById('riskSummaryScoreNote').textContent = '模型判定结果';
        document.getElementById('riskSummaryLevel').textContent = state.risk && state.risk.risk_level_cn
            ? state.risk.risk_level_cn
            : P.riskLevelText(currentRiskLevel());
        document.getElementById('riskSummaryLevelNote').textContent = '风险分级结果';
        document.getElementById('riskSummaryHighZones').textContent = highZones;
        document.getElementById('riskSummaryMediumZones').textContent = mediumZones;
        document.getElementById('riskSummaryFocusZones').textContent = state.zoneStats.length;
        document.getElementById('riskSummaryAlertVehicles').textContent = alertVehicles;
        document.getElementById('riskSummaryAlarmState').textContent = alarm.text;
        document.getElementById('riskSummaryAlarmNote').textContent = alarm.note;
        document.getElementById('riskSummaryUpdateTime').textContent = formatTime(state.risk && state.risk.timestamp);
        document.getElementById('riskSummaryUpdateNote').textContent = state.system && state.system.last_update
            ? `定位更新时间 ${formatTime(state.system.last_update)}`
            : '最新风险计算时间';
    }
    function renderZoneList() {
        document.getElementById('riskZoneCount').textContent = `${state.zoneStats.length} 区`;
        document.getElementById('riskHeatmapCount').textContent = `${state.heatPoints.length} 点`;
        document.getElementById('riskZoneList').innerHTML = state.zoneStats.map((zone) => {
            const selected = state.selected.type === 'zone' && state.selected.id === zone.id;
            const rateText = zone.deformationRate == null ? '--' : `${Math.abs(zone.deformationRate).toFixed(2)} mm/yr`;
            const gradientText = zone.deformationGradient == null ? '--' : zone.deformationGradient.toFixed(5);
            return `<button type="button" class="list-row risk-zone-row ${selected ? 'is-selected' : ''}" data-zone-id="${zone.id}" aria-pressed="${selected ? 'true' : 'false'}" style="text-align:left;cursor:pointer">
                <div class="row-top">
                    <span class="row-title">${escape(zone.name)}</span>
                    <span class="${P.riskBadgeClass(zone.level)}">${escape(zone.levelCn)}</span>
                </div>
                <div class="row-meta" style="margin-top:8px">${escape(zone.location)} · 坐标 ${P.fmtNumber(zone.center[0], 1)}, ${P.fmtNumber(zone.center[1], 1)}</div>
                <div class="risk-inline-meta">
                    <span>主要来源: ${escape(zone.mainSource)}</span>
                    <span>影响车辆: ${escape(zone.affectedVehicles)}</span>
                </div>
                <div class="risk-inline-meta">
                    <span>最近告警: ${escape(formatTime(zone.recentAlertTime))}</span>
                    <span>证据: ${escape(rateText)} / ${escape(gradientText)}</span>
                </div>
            </button>`;
        }).join('');
        document.querySelectorAll('#riskZoneList [data-zone-id]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                selectZone(button.dataset.zoneId);
            });
        });
    }
    function infoCard(label, value, extraClass = '') {
        const labelText = label == null ? '--' : String(label);
        const valueText = value == null ? '--' : String(value);
        return `<div class="detail-card ${extraClass}" title="${escape(valueText)}">
            <div class="detail-label" title="${escape(labelText)}">${escape(labelText)}</div>
            <div class="detail-value risk-inline-value" title="${escape(valueText)}">${escape(valueText)}</div>
        </div>`;
    }
    function evidenceCard(card) {
        return `<div class="risk-evidence-card">
            <div class="row-top">
                <span class="row-title">${escape(card.label)}</span>
                <span class="${card.badge}">${escape(card.status)}</span>
            </div>
            <div class="detail-value">${escape(card.value)}</div>
            <div class="risk-evidence-note">${escape(card.note)}</div>
        </div>`;
    }
    function alertMetaCard(label, value) {
        const labelText = label == null ? '--' : String(label);
        const valueText = value == null ? '--' : String(value);
        return `<div class="detail-card" title="${escape(valueText)}">
            <div class="detail-label" title="${escape(labelText)}">${escape(labelText)}</div>
            <div class="detail-value risk-meta-value risk-inline-value" title="${escape(valueText)}">${escape(valueText)}</div>
        </div>`;
    }
    function sparkline(values, level) {
        if (!values.length) {
            return '<div class="row-meta">等待历史样本接入</div>';
        }
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = Math.max(max - min, 0.001);
        const points = values.map((value, index) => {
            const x = (index / Math.max(values.length - 1, 1)) * 100;
            const y = 26 - ((value - min) / span) * 22;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(' ');
        const stroke = level === 'high' ? '#ff5f7f' : level === 'medium' ? '#ffd44f' : '#5de8ff';
        return `<svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
            <polyline fill="none" stroke="${stroke}" stroke-width="2.2" points="${points}"></polyline>
        </svg>`;
    }
    function selectedTrendSeries(target) {
        if (target.type === 'vehicle') {
            return state.history.riskScore.map((item) => item.value);
        }
        const zone = target.zone;
        return zone ? ensureZoneSeries(zone.id).map((item) => item.value) : [];
    }
    function renderTrend(target) {
        const values = selectedTrendSeries(target);
        const level = target.type === 'vehicle'
            ? currentRiskLevel()
            : (target.zone && target.zone.level) || 'low';
        document.getElementById('riskTrendSparkline').innerHTML = sparkline(values, level);
        document.getElementById('riskTrendMeta').textContent = values.length
            ? `最近 ${values.length} 个监测样本`
            : '最近样本尚少';
    }
    function renderHistoryList(target) {
        const alertItems = state.history.alerts.slice(-3).reverse().map((item) => {
            const title = item.title || '风险事件';
            return `${formatTime(item.timestamp)} · ${title}`;
        });
        let entries = [];
        if (target.type === 'vehicle') {
            entries = state.history.riskScore.slice(-5).reverse().map((item) => {
                return `${formatTime(item.ts)} · 风险指数 ${item.value.toFixed(3)} · ${P.riskLevelText(item.level)}`;
            });
            const drift = computeDriftTrend(state.path.slice(-20));
            entries.unshift(`最近轨迹窗口 · 漂移趋势 ${drift.label}`);
        } else if (target.zone) {
            const series = ensureZoneSeries(target.zone.id).slice(-5).reverse();
            entries = series.map((item) => `${formatTime(item.ts)} · 区域风险 ${item.value.toFixed(3)} · ${P.riskLevelText(item.level)}`);
            if (target.zone.affectedVehicles) {
                entries.unshift(`当前有车辆进入或接近 ${target.zone.name}`);
            } else {
                entries.unshift(`${target.zone.name} 当前无直接运行影响`);
            }
        }
        entries = entries.concat(alertItems).slice(0, 6);
        document.getElementById('riskHistoryList').innerHTML = entries.length
            ? entries.map((item) => `<div class="timeline-item">${escape(item)}</div>`).join('')
            : '<div class="timeline-item">等待历史样本接入</div>';
    }
    function buildZoneReason(zone) {
        const rateText = zone.deformationRate == null ? '形变速率待校准' : `形变速率 ${Math.abs(zone.deformationRate).toFixed(2)} mm/yr`;
        const gradientText = zone.deformationGradient == null ? '形变梯度待校准' : `形变梯度 ${zone.deformationGradient.toFixed(5)}`;
        const influence = zone.affectedVehicles
            ? '当前已有车辆进入或接近该区域，需要同步关注定位稳定性与通行速度。'
            : '当前暂无车辆直接进入，但仍建议持续观测并保留预警阈值。';
        return `${zone.explanation || `${zone.name} 当前判定为 ${zone.levelCn}。`} ${rateText}，${gradientText}。${influence}`;
    }
    function buildVehicleReason(zone, evidence, variance, drift) {
        const zoneText = zone ? `${zone.name}（${zone.levelCn}）` : '一般通行区域';
        const rateText = evidence.rate == null ? '形变速率待校准' : `形变速率 ${Math.abs(evidence.rate).toFixed(2)} mm/yr`;
        const gradientText = evidence.gradient == null ? '形变梯度待校准' : `形变梯度 ${Number(evidence.gradient).toFixed(5)}`;
        const varianceText = variance == null ? '定位方差待接入' : `定位方差 ${variance.toFixed(3)} m²`;
        return `车辆当前位于 ${zoneText}，综合风险等级为 ${state.risk && state.risk.risk_level_cn ? state.risk.risk_level_cn : P.riskLevelText(currentRiskLevel())}。${rateText}，${gradientText}，${varianceText}，轨迹漂移趋势 ${drift.label}，需结合车速与路径保持稳定通行。`;
    }
    function recommendationForZone(zone) {
        if (!zone) return '持续观测';
        if (zone.level === 'high') return '绕行 / 禁入 / 人工复核';
        if (zone.level === 'medium') return '减速通行 / 人工复核 / 持续观测';
        return '持续观测 / 正常通行';
    }
    function recommendationForVehicle(level) {
        if (level === 'high') return '立即减速并绕行或停靠复核';
        if (level === 'medium') return '降低速度并保持定位观测';
        return '按计划通行并保持常规巡检';
    }
    function renderDetail() {
        const target = selectedObject();
        if (target.type === 'vehicle') {
            renderVehicleDetail(target);
        } else {
            renderZoneDetail(target.zone);
        }
        renderTrend(target);
        renderHistoryList(target);
        renderDataStatus();
    }
    function renderZoneDetail(zone) {
        const badgeLevel = zone ? zone.level : 'low';
        document.getElementById('riskDetailType').textContent = '区域对象';
        document.getElementById('riskCurrentBadge').textContent = zone ? zone.levelCn : '低风险';
        document.getElementById('riskCurrentBadge').className = P.riskBadgeClass(badgeLevel);
        document.getElementById('riskDetailMeta').textContent = zone
            ? `${zone.location} · 后验概率 ${zone.posteriorProbability}%`
            : '等待区域对象接入';
        if (!zone) {
            document.getElementById('riskInfoGrid').innerHTML = '';
            document.getElementById('riskEvidenceGrid').innerHTML = '';
            document.getElementById('riskAlertMeta').innerHTML = '';
            document.getElementById('riskReasonText').textContent = '等待风险区域接入';
            document.getElementById('riskDispatchSummary').textContent = '暂无处置建议';
            return;
        }
        const evidence = currentEvidenceForObject({type: 'zone', zone});
        const variance = computePositionVariance(state.path.slice(-20));
        const drift = computeDriftTrend(state.path.slice(-20));
        document.getElementById('riskInfoGrid').innerHTML = [
            infoCard('区域名称', zone.name),
            infoCard('风险等级', zone.levelCn),
            infoCard('后验风险概率', `${zone.posteriorProbability}%`),
            infoCard('所在路段', zone.location),
            infoCard('形变速率', evidence.rate == null ? '--' : `${Math.abs(evidence.rate).toFixed(2)} mm/yr`),
            infoCard('形变梯度', evidence.gradient == null ? '--' : Number(evidence.gradient).toFixed(5)),
            infoCard('当前影响车辆数', zone.affectedVehicles),
            infoCard('最近风险更新时间', formatTime(zone.dataTimestamp || (state.risk && state.risk.timestamp))),
        ].join('');
        document.getElementById('riskEvidenceGrid').innerHTML = [
            evidenceCard({
                label: '形变速率',
                value: evidence.rate == null ? '--' : `${Math.abs(evidence.rate).toFixed(2)} mm/yr`,
                status: evidenceStatus(evidence.rate == null ? null : Math.abs(evidence.rate), 5.0, 15.0).text,
                badge: evidenceStatus(evidence.rate == null ? null : Math.abs(evidence.rate), 5.0, 15.0).badge,
                note: '反映区域缓变沉降强度',
            }),
            evidenceCard({
                label: '形变梯度',
                value: evidence.gradient == null ? '--' : Number(evidence.gradient).toFixed(5),
                status: evidenceStatus(evidence.gradient, 0.01, 0.03).text,
                badge: evidenceStatus(evidence.gradient, 0.01, 0.03).badge,
                note: '反映空间变化陡峭程度',
            }),
            evidenceCard({
                label: '定位方差',
                value: zone.affectedVehicles && variance != null ? `${variance.toFixed(3)} m²` : '--',
                status: zone.affectedVehicles ? evidenceStatus(variance, 0.20, 0.65).text : '待关联',
                badge: zone.affectedVehicles ? evidenceStatus(variance, 0.20, 0.65).badge : 'badge badge-idle',
                note: '基于最近轨迹窗口离散度估计',
            }),
            evidenceCard({
                label: '漂移趋势',
                value: zone.affectedVehicles ? drift.label : '--',
                status: zone.affectedVehicles ? drift.label : '待关联',
                badge: zone.affectedVehicles ? drift.badge : 'badge badge-idle',
                note: '用于判断车辆进入风险区后的稳定性变化',
            }),
        ].join('');
        document.getElementById('riskReasonText').textContent = buildZoneReason(zone);
        document.getElementById('riskAlertMeta').innerHTML = [
            alertMetaCard('告警等级', zone.levelCn),
            alertMetaCard('告警触发原因', zone.mainSource),
            alertMetaCard('告警对象', zone.name),
            alertMetaCard('告警触发时间', formatTime(zone.recentAlertTime || zone.dataTimestamp)),
            alertMetaCard('当前建议动作', recommendationForZone(zone)),
            alertMetaCard('调度建议摘要', zone.level === 'high' ? '建议优先绕行该区域，避免连续穿越。' : zone.level === 'medium' ? '建议下调车速并增加人工复核频次。' : '保持巡检频率并关注趋势变化。'),
        ].join('');
        document.getElementById('riskDispatchSummary').textContent = zone.level === 'high'
            ? '该区域应优先纳入重点防控对象，建议调度侧限制连续通过并保留禁入策略。'
            : zone.level === 'medium'
                ? '该区域建议执行减速通行与持续观测联动，必要时触发人工复核。'
                : '该区域当前可维持正常通行，但应保留趋势跟踪与阈值预警。';
    }
    function renderVehicleDetail(target) {
        const agv = target.agv || {};
        const zone = target.zone;
        const evidence = currentEvidenceForObject(target);
        const recentPath = state.path.slice(-20);
        const variance = computePositionVariance(recentPath);
        const drift = computeDriftTrend(recentPath);
        const stability = stabilityStatus(recentPath);
        const riskLevelKey = currentRiskLevel();
        const alert = latestAlert();
        document.getElementById('riskDetailType').textContent = '车辆对象';
        document.getElementById('riskCurrentBadge').textContent = state.risk && state.risk.risk_level_cn
            ? state.risk.risk_level_cn
            : P.riskLevelText(riskLevelKey);
        document.getElementById('riskCurrentBadge').className = P.riskBadgeClass(riskLevelKey);
        document.getElementById('riskDetailMeta').textContent = zone
            ? `${zone.name} · ${stability.text}`
            : '运行状态联动详情';
        const position = agv.position || {};
        document.getElementById('riskInfoGrid').innerHTML = [
            infoCard('车辆 ID', agv.id || 'agv-001'),
            infoCard('当前坐标', `${P.fmtNumber(position.x, 1)}, ${P.fmtNumber(position.y, 1)}`),
            infoCard('所在区域', zone ? zone.name : '通行区域'),
            infoCard('当前速度', typeof agv.speed === 'number' ? `${agv.speed.toFixed(3)} m/s` : '--'),
            infoCard('航向状态', agv.orientation && typeof agv.orientation.yaw === 'number' ? `${agv.orientation.yaw.toFixed(1)}°` : '--'),
            infoCard('定位稳定性', stability.text),
            infoCard('定位方差', variance == null ? '--' : `${variance.toFixed(3)} m²`),
            infoCard('当前关联风险', state.risk && state.risk.risk_level_cn ? state.risk.risk_level_cn : P.riskLevelText(riskLevelKey)),
        ].join('');
        document.getElementById('riskEvidenceGrid').innerHTML = [
            evidenceCard({
                label: '形变速率',
                value: evidence.rate == null ? '--' : `${Math.abs(evidence.rate).toFixed(2)} mm/yr`,
                status: evidenceStatus(evidence.rate == null ? null : Math.abs(evidence.rate), 5.0, 15.0).text,
                badge: evidenceStatus(evidence.rate == null ? null : Math.abs(evidence.rate), 5.0, 15.0).badge,
                note: '反映车辆当前位置的缓变沉降强度',
            }),
            evidenceCard({
                label: '形变梯度',
                value: evidence.gradient == null ? '--' : Number(evidence.gradient).toFixed(5),
                status: evidenceStatus(evidence.gradient, 0.01, 0.03).text,
                badge: evidenceStatus(evidence.gradient, 0.01, 0.03).badge,
                note: '当前位置空间梯度变化程度',
            }),
            evidenceCard({
                label: '定位方差',
                value: variance == null ? '--' : `${variance.toFixed(3)} m²`,
                status: evidenceStatus(variance, 0.20, 0.65).text,
                badge: evidenceStatus(variance, 0.20, 0.65).badge,
                note: '基于最近轨迹窗口离散度估计',
            }),
            evidenceCard({
                label: '漂移趋势',
                value: drift.label,
                status: drift.label,
                badge: drift.badge,
                note: '用于判断车辆状态是否继续恶化',
            }),
        ].join('');
        document.getElementById('riskReasonText').textContent = buildVehicleReason(zone, evidence, variance, drift);
        document.getElementById('riskAlertMeta').innerHTML = [
            alertMetaCard('告警等级', alert ? (alert.level_cn || alert.level || '--') : (state.risk && state.risk.risk_level_cn ? state.risk.risk_level_cn : P.riskLevelText(riskLevelKey))),
            alertMetaCard('告警触发原因', state.risk && state.risk.reasons && state.risk.reasons.length ? state.risk.reasons[0] : '风险状态更新'),
            alertMetaCard('告警对象', agv.id || 'agv-001'),
            alertMetaCard('告警触发时间', formatTime((alert && alert.timestamp) || (state.risk && state.risk.timestamp))),
            alertMetaCard('当前建议动作', recommendationForVehicle(riskLevelKey)),
            alertMetaCard('调度建议摘要', riskLevelKey === 'high' ? '建议优先绕行高风险区并降低目标速度。' : riskLevelKey === 'medium' ? '建议减速并保持定位稳定性观测。' : '按计划执行并持续监测风险指标。'),
        ].join('');
        document.getElementById('riskDispatchSummary').textContent = riskLevelKey === 'high'
            ? '车辆已与高风险区域形成运行关联，建议立即执行减速、绕行或停靠复核。'
            : riskLevelKey === 'medium'
                ? '车辆处于预警状态，建议继续观察定位稳定性和漂移趋势。'
                : '车辆当前处于可控状态，可保持正常运行与常规巡检。';
    }
    function renderDataStatus() {
        const health = dataHealthPresentation();
        const riskTime = state.risk && state.risk.timestamp;
        const systemTime = state.system && state.system.last_update;
        const insarTime = state.insarLayers && state.insarLayers.timestamp;
        const currentZone = currentZoneStat();
        document.getElementById('riskDataHealth').textContent = health.text;
        document.getElementById('riskDataStatusList').innerHTML = [
            statusRow('InSAR 图层更新时间', formatTime(insarTime), state.insarAligned ? '正常' : '降级', state.insarAligned ? 'badge badge-safe' : 'badge badge-warn'),
            statusRow('定位更新时间', formatTime(systemTime), state.system && state.system.ros2 === 'online' ? '正常' : '延迟', state.system && state.system.ros2 === 'online' ? 'badge badge-safe' : 'badge badge-danger'),
            statusRow('风险计算时间', formatTime(riskTime), riskTime ? '正常' : '缺测', riskTime ? 'badge badge-safe' : 'badge badge-idle'),
            statusRow('数据状态', health.text, health.text === '正常' ? '正常' : '降级', health.badge),
            statusRow('坐标与时间基准', state.insarAligned ? '已对齐' : '坐标待校准', currentZone ? '已关联运行区域' : '待关联', state.insarAligned ? 'badge badge-safe' : 'badge badge-warn'),
        ].join('');
    }
    function statusRow(label, value, status, badge) {
        return `<div class="risk-status-row">
            <span class="detail-label">${escape(label)}</span>
            <strong>${escape(value)}</strong>
            <span class="${badge}">${escape(status)}</span>
        </div>`;
    }
    function syncLayerButtons() {
        document.querySelectorAll('[data-layer-toggle]').forEach((button) => {
            const key = button.dataset.layerToggle;
            button.classList.toggle('is-active', Boolean(state.layerVisibility[key]));
        });
    }
    function locateSelectedObject() {
        if (!state.map) return;
        const target = selectedObject();
        if (target.type === 'vehicle') {
            const point = currentAgvPoint();
            if (!point) return;
            state.map.setView(simToLatLng(point.x, point.y), 2);
            return;
        }
        const zone = target.zone;
        if (!zone) return;
        state.map.fitBounds(zoneBounds(zone), {padding: [18, 18]});
    }
    function renderAll() {
        deriveZoneStats();
        ensureSelection();
        renderKpis();
        renderZoneList();
        renderMap();
        renderDetail();
        syncLayerButtons();
    }
    function bindEvents() {
        document.getElementById('riskRefreshBtn').addEventListener('click', async () => {
            await refreshRiskLayers();
            renderAll();
        });
        document.getElementById('riskZoneList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-zone-id]');
            if (!row) return;
            event.preventDefault();
            selectZone(row.dataset.zoneId);
        });
        document.getElementById('riskMapLayerControls').addEventListener('click', (event) => {
            const button = event.target.closest('[data-layer-toggle]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            const key = button.dataset.layerToggle;
            toggleLayer(key);
        });
        document.getElementById('riskLocateBtn').addEventListener('click', (event) => {
            event.preventDefault();
            handleLocateAction();
        });
        document.getElementById('riskTraceBtn').addEventListener('click', (event) => {
            event.preventDefault();
            handleTraceAction();
        });
        document.getElementById('riskHistoryBtn').addEventListener('click', (event) => {
            event.preventDefault();
            handleHistoryAction();
        });
    }
    function handleAgv(data) {
        state.agv = data;
        const position = data.position || {};
        if (typeof position.x === 'number' && typeof position.y === 'number') {
            pushLimited(state.path, {
                x: position.x,
                y: position.y,
                timestamp: data.timestamp || new Date().toISOString(),
            }, 120);
        }
        pushSpeedHistory(data.speed);
        pushDriftHistory(state.path.slice(-20));
        maybeRefreshVehicleEvidence();
        renderAll();
    }
    function handleRisk(data) {
        state.risk = data;
        pushRiskHistory();
        renderAll();
    }
    function handleSystem(data) {
        state.system = data;
        P.updateSystemStatus(data);
        renderAll();
    }
    function handleMission(data) {
        state.mission = data;
    }
    function handleAlert(alert) {
        state.alerts.unshift(alert);
        state.alerts = state.alerts.slice(0, 40);
        pushLimited(state.history.alerts, alert, 16);
        renderAll();
    }
    async function fetchZoneEvidence() {
        const tasks = state.zoneDefs.map((zone) => {
            return P.fetchJson(`/api/insar/query?x=${zone.center[0]}&y=${zone.center[1]}`);
        });
        const results = await Promise.allSettled(tasks);
        state.insarAligned = false;
        results.forEach((result, index) => {
            const zone = state.zoneDefs[index];
            if (result.status === 'fulfilled') {
                state.zoneEvidence[zone.id] = result.value;
                if (result.value && result.value.valid) state.insarAligned = true;
            } else {
                state.zoneEvidence[zone.id] = {valid: false};
            }
        });
    }
    async function refreshVehicleEvidence(force = false) {
        if (vehicleEvidencePending) return;
        const point = currentAgvPoint();
        if (!point) return;
        const now = Date.now();
        if (!force && now - lastVehicleEvidenceAt < 2500) return;
        vehicleEvidencePending = true;
        try {
            state.vehicleEvidence = await P.fetchJson(`/api/insar/query?x=${point.x}&y=${point.y}`);
            lastVehicleEvidenceAt = now;
            if (state.vehicleEvidence && state.vehicleEvidence.valid) state.insarAligned = true;
        } catch (e) {
            state.vehicleEvidence = {valid: false};
        } finally {
            vehicleEvidencePending = false;
        }
    }
    function maybeRefreshVehicleEvidence() {
        refreshVehicleEvidence(false).then(() => renderAll()).catch(() => {});
    }
    async function refreshRiskLayers() {
        const jobs = await Promise.allSettled([
            P.fetchJson('/api/risk/heatmap'),
            P.fetchJson('/api/agv/path'),
            P.fetchJson('/api/alerts/recent?limit=20'),
            P.fetchJson('/api/insar/layers'),
            P.fetchJson('/api/insar/risk_zones'),
        ]);
        if (jobs[0].status === 'fulfilled') {
            const heatmap = jobs[0].value;
            state.heatPoints = Array.isArray(heatmap.points) ? heatmap.points : [];
            state.heatVersion += 1;
        }
        if (jobs[1].status === 'fulfilled') {
            const path = jobs[1].value;
            state.path = Array.isArray(path.path) ? path.path.slice(-120) : [];
        }
        if (jobs[2].status === 'fulfilled') {
            const alertData = jobs[2].value;
            state.alerts = Array.isArray(alertData.alerts) ? alertData.alerts : [];
            state.history.alerts = state.alerts.slice(0, 6).reverse();
        }
        if (jobs[3].status === 'fulfilled') {
            state.insarLayers = jobs[3].value;
        }
        if (jobs[4].status === 'fulfilled') {
            state.insarGeoJson = jobs[4].value;
        }
        await fetchZoneEvidence();
        await refreshVehicleEvidence(true);
    }
    async function loadInitialState() {
        const jobs = await Promise.allSettled([
            P.fetchJson('/api/risk/current'),
            P.fetchJson('/api/agv/latest'),
            P.fetchJson('/api/system/status'),
            P.fetchJson('/api/mission/status'),
        ]);
        if (jobs[0].status === 'fulfilled') state.risk = jobs[0].value;
        if (jobs[1].status === 'fulfilled') {
            state.agv = jobs[1].value;
            const position = state.agv.position || {};
            if (typeof position.x === 'number' && typeof position.y === 'number') {
                state.path = [{
                    x: position.x,
                    y: position.y,
                    timestamp: state.agv.timestamp || new Date().toISOString(),
                }];
            }
            pushSpeedHistory(state.agv.speed);
        }
        if (jobs[2].status === 'fulfilled') state.system = jobs[2].value;
        if (jobs[3].status === 'fulfilled') state.mission = jobs[3].value;
        P.updateSystemStatus(state.system);
        await refreshRiskLayers();
        pushRiskHistory();
        pushDriftHistory(state.path.slice(-20));
    }
    document.addEventListener('DOMContentLoaded', async () => {
        P.startClock();
        bindEvents();
        P.connectLiveData({
            onRisk: handleRisk,
            onAgv: handleAgv,
            onSystem: handleSystem,
            onMission: handleMission,
            onAlert: handleAlert,
        });
        await loadInitialState();
        renderAll();
    });
})();
