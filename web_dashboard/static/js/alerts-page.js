(function () {
    const P = window.Platform;
    let alerts = [];
    let selectedAlertId = null;
    let activeQuickFilter = 'all';
    let agvSnapshot = {
        id: 'YK-AGV-001',
        online: '等待接入',
        mode: '待命',
        task: '待命巡检',
        risk: '低风险',
        poseTime: '--',
    };

    const TYPE_CN = {
        deformation: '地面形变',
        monitor_zone: '重点监测区',
        overspeed: '超速',
        communication: '通信异常',
        mission: '任务异常',
        offline: '离线',
        system: '系统运行',
    };
    const STATUS_CN = {
        pending: '未处理',
        processing: '处理中',
        handled: '已处理',
        closed: '已关闭',
    };

    function levelBadge(level) {
        return ({critical: 'badge badge-danger', warn: 'badge badge-warn', info: 'badge badge-info'})[level] || 'badge badge-idle';
    }
    function statusBadge(status) {
        return ({
            pending: 'badge badge-pending',
            processing: 'badge badge-processing',
            handled: 'badge badge-handled',
            closed: 'badge badge-closed',
        })[status] || 'badge badge-idle';
    }
    function levelText(alert) {
        return alert.level_cn || ({critical: '高等级', warn: '中等级', info: '低等级'})[alert.level] || alert.level || '--';
    }
    function levelPriority(level) {
        return ({critical: 3, warn: 2, info: 1})[level] || 0;
    }
    function inferType(raw) {
        const text = `${raw.title || ''} ${raw.message || ''}`.toLowerCase();
        if (text.includes('形变') || text.includes('沉降') || text.includes('ground')) return 'deformation';
        if (text.includes('风险区域') || text.includes('重点') || text.includes('risk')) return 'monitor_zone';
        if (text.includes('速度') || text.includes('超速') || text.includes('speed')) return 'overspeed';
        if (text.includes('离线') || text.includes('接入')) return 'offline';
        if (text.includes('任务') || text.includes('路线') || text.includes('mission')) return 'mission';
        if (text.includes('系统') || text.includes('启动') || text.includes('重置')) return 'system';
        return raw.level === 'critical' ? 'monitor_zone' : raw.level === 'warn' ? 'deformation' : 'system';
    }
    function inferStatus(raw, type) {
        if (raw.level === 'critical') return 'pending';
        if (raw.level === 'warn') return 'processing';
        if (type === 'system') return 'closed';
        return 'handled';
    }
    function inferZone(type, level) {
        if (type === 'monitor_zone' || type === 'deformation') return '周口港重点监测区';
        if (type === 'mission') return '港区主通行走廊';
        if (type === 'offline' || type === 'communication') return '车辆接入点';
        if (level === 'critical') return '重点监测区 C';
        if (level === 'warn') return '重点监测区 B';
        return '港机作业区';
    }
    function zoneKey(zone) {
        if (zone.includes('重点')) return 'focus';
        if (zone.includes('堆场')) return 'yard';
        if (zone.includes('接入')) return 'gate';
        return 'operation';
    }
    function alertId(raw, index) {
        if (raw.id) return raw.id;
        const stamp = raw.timestamp ? String(Date.parse(raw.timestamp)).slice(-8) : String(Date.now()).slice(-8);
        return `AL-${stamp}-${String(index + 1).padStart(2, '0')}`;
    }
    function minutesSince(timestamp) {
        const t = timestamp ? new Date(timestamp).getTime() : Date.now();
        if (Number.isNaN(t)) return 0;
        return Math.max(0, Math.round((Date.now() - t) / 60000));
    }
    function durationText(alert) {
        if (alert.status === 'closed' || alert.status === 'handled') return alert.duration_min <= 0 ? '已闭环' : `${alert.duration_min} 分钟`;
        if (alert.duration_min < 1) return '持续中';
        if (alert.duration_min < 60) return `${alert.duration_min} 分钟`;
        return `${Math.floor(alert.duration_min / 60)} 小时 ${alert.duration_min % 60} 分钟`;
    }
    function riskProfile(level, type) {
        if (level === 'critical') {
            return {
                score: 0.86,
                terrain: type === 'deformation' ? 0.78 : 0.72,
                gradient: 0.018,
                source: type === 'offline' ? '车辆接入异常 / 位姿中断' : '重点风险区 / 车辆状态叠加',
                verdict: '综合判定为高优先级风险事件，需人工确认并跟踪处置闭环。',
            };
        }
        if (level === 'warn') {
            return {
                score: 0.56,
                terrain: 0.48,
                gradient: 0.009,
                source: type === 'mission' ? '任务执行偏差 / 运行状态异常' : '中等风险区域 / 地面风险叠加',
                verdict: '综合判定为持续关注事件，建议核对车辆任务状态与所在区域风险。',
            };
        }
        return {
            score: 0.18,
            terrain: 0.12,
            gradient: 0.002,
            source: '系统状态事件 / 常规运行信息',
            verdict: '当前不构成高优先级风险，作为运行记录归档追溯。',
        };
    }
    function handlingProfile(level, status, type) {
        if (status === 'closed') {
            return {
                manual: '否',
                advice: '事件已归档，保持常规监测。',
                action: '系统自动记录并完成闭环。',
                condition: '关闭条件：事件状态稳定，未触发持续风险。',
            };
        }
        if (status === 'handled') {
            return {
                manual: '否',
                advice: '已处理，后续保持态势观察。',
                action: '已记录事件并同步至运行日志。',
                condition: '关闭条件：风险解除或同类事件无新增。',
            };
        }
        if (level === 'critical') {
            return {
                manual: '是',
                advice: type === 'offline' ? '优先确认车辆接入和位姿回传链路。' : '建议人工确认车辆位置、风险区边界与任务状态。',
                action: '已推送高等级告警，等待处置确认。',
                condition: '关闭条件：车辆离开风险区、位姿恢复或风险等级降级。',
            };
        }
        return {
            manual: '视情况',
            advice: '持续观察风险变化，必要时调整车辆任务或速度策略。',
            action: '系统已标记为处理中并持续接收状态更新。',
            condition: '关闭条件：风险评分回落并连续稳定。',
        };
    }
    function normalizeAlert(raw, index) {
        const type = raw.type || inferType(raw);
        const status = raw.status || inferStatus(raw, type);
        const zone = raw.zone_name || inferZone(type, raw.level);
        const risk = riskProfile(raw.level, type);
        const handling = handlingProfile(raw.level, status, type);
        const duration = minutesSince(raw.timestamp);
        const endTime = status === 'closed' || status === 'handled'
            ? P.fmtTime(new Date((raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now()) + Math.min(duration + 2, 12) * 60000))
            : '--';
        const id = alertId(raw, index);
        return Object.assign({}, raw, {
            id,
            type,
            type_cn: TYPE_CN[type] || type,
            status,
            status_cn: STATUS_CN[status] || status,
            zone_name: zone,
            zone_key: zoneKey(zone),
            agv_id: raw.agv_id || 'agv-001',
            task_name: raw.task_name || (type === 'mission' ? '港区转运任务' : '周口港运行监测'),
            monitor_zone: zone.includes('重点') ? '是' : '否',
            risk_score: raw.risk_score ?? risk.score,
            terrain_risk: raw.terrain_risk ?? risk.terrain,
            gradient_mag: raw.gradient_mag ?? risk.gradient,
            risk_source: raw.risk_source || risk.source,
            risk_verdict: raw.risk_verdict || risk.verdict,
            handling_manual: handling.manual,
            handling_advice: raw.handling_advice || handling.advice,
            handling_action: raw.handling_action || handling.action,
            close_condition: raw.close_condition || handling.condition,
            duration_min: duration,
            end_time_text: endTime,
            impact: raw.impact || buildImpactText(raw.level, type, zone),
            timeline: buildTimeline(raw, status, type, zone),
        });
    }
    function buildImpactText(level, type, zone) {
        if (level === 'critical') return `事件影响 ${zone} 的车辆安全运行，需要优先确认车辆位置、接入状态和风险区叠加情况。`;
        if (level === 'warn') return `事件与 ${zone} 的风险监测相关，当前建议保持跟踪并关注任务执行状态。`;
        if (type === 'system') return '该事件主要用于运行状态追溯，不影响当前车辆作业。';
        return '事件已记录，用于后续运行态势分析。';
    }
    function buildTimeline(raw, status, type, zone) {
        const t = P.fmtTime(raw.timestamp);
        const items = [
            {title: '告警生成', meta: `${t} · 系统接收事件并写入告警中心`},
            {title: '风险识别', meta: `${zone} · ${TYPE_CN[type] || type} 触发规则匹配`},
            {title: raw.level === 'critical' ? '优先级提升' : '事件分级', meta: `${levelText(raw)} · ${raw.message || raw.title || '事件进入研判流程'}`},
        ];
        if (status === 'pending') items.push({title: '等待确认', meta: '当前事件未处理，建议人工确认处置。'});
        if (status === 'processing') items.push({title: '处置跟踪', meta: '系统持续跟踪车辆、区域和任务状态。'});
        if (status === 'handled' || status === 'closed') items.push({title: '事件闭环', meta: '事件已处理或归档，进入追溯记录。'});
        return items;
    }
    function createFallbackAlerts() {
        const now = Date.now();
        return [
            {
                timestamp: new Date(now - 7 * 60000).toISOString(),
                level: 'critical',
                level_cn: '严重',
                title: '高风险区域车辆告警',
                message: 'YK-AGV-001 进入重点监测区 C，风险评分升高。',
                agv_id: 'YK-AGV-001',
            },
            {
                timestamp: new Date(now - 18 * 60000).toISOString(),
                level: 'warn',
                level_cn: '警告',
                title: '地面形变风险提示',
                message: '堆场通道附近形变梯度升高，建议持续观察。',
                agv_id: 'YK-AGV-003',
            },
            {
                timestamp: new Date(now - 32 * 60000).toISOString(),
                level: 'info',
                level_cn: '信息',
                title: '系统运行状态记录',
                message: '告警中心完成运行状态同步。',
                agv_id: 'system',
            },
        ];
    }
    function normalizeAll(items) {
        return items.map((item, index) => normalizeAlert(item, index));
    }
    function getFilters() {
        return {
            query: (document.getElementById('alertSearch').value || '').trim().toLowerCase(),
            level: document.getElementById('alertLevelFilter').value,
            status: document.getElementById('alertStatusFilter').value,
            type: document.getElementById('alertTypeFilter').value,
            zone: document.getElementById('alertZoneFilter').value,
        };
    }
    function filteredAlerts() {
        const filter = getFilters();
        return alerts.filter((item) => {
            const queryText = `${item.title} ${item.message} ${item.agv_id} ${item.zone_name}`.toLowerCase();
            const queryMatch = !filter.query || queryText.includes(filter.query);
            const levelMatch = filter.level === 'all' || item.level === filter.level;
            const statusMatch = filter.status === 'all' || item.status === filter.status || (filter.status === 'handled' && item.status === 'closed');
            const typeMatch = filter.type === 'all' || item.type === filter.type;
            const zoneMatch = filter.zone === 'all' || item.zone_key === filter.zone;
            const quickMatch = activeQuickFilter !== 'active' || ['pending', 'processing'].includes(item.status);
            return queryMatch && levelMatch && statusMatch && typeMatch && zoneMatch && quickMatch;
        });
    }
    function selectedAlert() {
        const rows = filteredAlerts();
        return rows.find((item) => item.id === selectedAlertId) || rows[0] || alerts[0] || null;
    }
    function ensureSelectedVisible() {
        const rows = filteredAlerts();
        if (!rows.length) return;
        if (!rows.some((item) => item.id === selectedAlertId)) selectedAlertId = rows[0].id;
    }
    function renderStats() {
        const total = alerts.length;
        const critical = alerts.filter((item) => item.level === 'critical').length;
        const warn = alerts.filter((item) => item.level === 'warn').length;
        const handled = alerts.filter((item) => ['handled', 'closed'].includes(item.status)).length;
        const pending = alerts.filter((item) => item.status === 'pending').length;
        const active = alerts.filter((item) => ['pending', 'processing'].includes(item.status)).length;
        document.getElementById('alertKpiTotal').textContent = total;
        document.getElementById('alertKpiCritical').textContent = critical;
        document.getElementById('alertKpiWarn').textContent = warn;
        document.getElementById('alertKpiHandled').textContent = handled;
        document.getElementById('alertKpiPending').textContent = pending;
        document.getElementById('alertKpiActive').textContent = active;
        document.querySelectorAll('[data-alert-quick]').forEach((button) => {
            button.classList.toggle('is-active', button.dataset.alertQuick === activeQuickFilter);
        });
    }
    function renderFilterSummary(rows) {
        const filter = getFilters();
        const parts = [];
        if (filter.query) parts.push(`搜索 "${filter.query}"`);
        if (filter.level !== 'all') parts.push(({critical: '高等级', warn: '中等级', info: '低等级'})[filter.level]);
        if (filter.status !== 'all') parts.push(STATUS_CN[filter.status]);
        if (filter.type !== 'all') parts.push(TYPE_CN[filter.type]);
        if (filter.zone !== 'all') parts.push(({focus: '重点监测区', yard: '集装箱堆场', operation: '港机作业区', gate: '港区接入点'})[filter.zone]);
        if (activeQuickFilter === 'active') parts.push('持续告警');
        document.getElementById('alertFilterSummary').textContent = `${parts.length ? parts.join(' / ') : '显示全部告警'} · ${rows.length}/${alerts.length} 条`;
    }
    function renderList() {
        const rows = filteredAlerts();
        renderFilterSummary(rows);
        document.getElementById('alertListCount').textContent = `${rows.length} 条`;
        const list = document.getElementById('alertCenterList');
        if (!rows.length) {
            list.innerHTML = '<div class="support-empty">暂无匹配告警，请调整筛选条件</div>';
            return;
        }
        list.innerHTML = rows.map((alert) => `<button class="alert-row ${alert.id === selectedAlertId ? 'is-selected' : ''} ${alert.level === 'critical' ? 'is-critical' : ''}" data-alert-id="${P.escapeHtml(alert.id)}" type="button">
            <div class="alert-row-main">
                <span class="alert-row-title">${P.escapeHtml(alert.title || '告警事件')}</span>
                <span class="${levelBadge(alert.level)}">${P.escapeHtml(levelText(alert))}</span>
            </div>
            <div class="alert-row-tags">
                <span class="${statusBadge(alert.status)}">${P.escapeHtml(alert.status_cn)}</span>
                <span class="badge badge-idle">${P.escapeHtml(alert.type_cn)}</span>
                ${['pending', 'processing'].includes(alert.status) ? '<span class="badge badge-danger">持续</span>' : ''}
            </div>
            <div class="alert-row-meta">
                <span>${P.escapeHtml(alert.agv_id)} · ${P.escapeHtml(alert.zone_name)}</span>
                <span>${P.fmtTime(alert.timestamp)}</span>
            </div>
            <div class="alert-row-meta">
                <span>${P.escapeHtml(alert.message || '无事件描述')}</span>
            </div>
        </button>`).join('');
    }
    function renderDetail() {
        const alert = selectedAlert();
        if (!alert) {
            document.getElementById('alertHeroCurrent').textContent = '等待告警接入';
            document.getElementById('alertDetailTitle').textContent = '--';
            document.getElementById('alertTimeline').innerHTML = '<div class="alert-timeline-item"><strong>等待告警事件接入</strong><span>暂无事件过程。</span></div>';
            return;
        }
        document.getElementById('alertHeroCurrent').textContent = alert.id;
        document.getElementById('alertDataTime').textContent = P.fmtTime(alert.timestamp);
        document.getElementById('alertDetailTitle').textContent = alert.title || '告警事件';
        document.getElementById('alertDetailLevel').textContent = levelText(alert);
        document.getElementById('alertDetailLevel').className = levelBadge(alert.level);
        document.getElementById('alertDetailStatusBadge').textContent = alert.status_cn;
        document.getElementById('alertDetailStatusBadge').className = statusBadge(alert.status);
        document.getElementById('alertDetailId').textContent = alert.id;
        document.getElementById('alertDetailTime').textContent = P.fmtTime(alert.timestamp);
        document.getElementById('alertDetailDuration').textContent = durationText(alert);
        document.getElementById('alertDetailEndTime').textContent = alert.end_time_text;
        document.getElementById('alertDetailAgv').textContent = alert.agv_id;
        document.getElementById('alertDetailZone').textContent = alert.zone_name;
        document.getElementById('alertDetailTask').textContent = alert.task_name;
        document.getElementById('alertDetailMonitorZone').textContent = alert.monitor_zone;
        document.getElementById('alertDetailMessage').textContent = alert.message || '--';
        document.getElementById('alertDetailImpact').textContent = alert.impact;
        document.getElementById('alertRiskSource').textContent = alert.risk_source;
        document.getElementById('alertRiskScore').textContent = P.fmtNumber(alert.risk_score, 3);
        document.getElementById('alertTerrainRisk').textContent = P.fmtNumber(alert.terrain_risk, 3);
        document.getElementById('alertGradientRisk').textContent = P.fmtNumber(alert.gradient_mag, 5);
        const verdict = document.getElementById('alertRiskVerdict');
        verdict.textContent = alert.risk_verdict;
        verdict.className = `risk-verdict ${alert.level === 'critical' ? 'is-critical' : alert.level === 'warn' ? 'is-warn' : ''}`;
        document.getElementById('alertHandlingStatus').textContent = alert.status_cn;
        document.getElementById('alertManualConfirm').textContent = alert.handling_manual;
        document.getElementById('alertHandlingAdvice').textContent = alert.handling_advice;
        document.getElementById('alertHandlingAction').textContent = alert.handling_action;
        document.getElementById('alertCloseCondition').textContent = alert.close_condition;
        renderTimeline(alert);
        renderVehicleSummary(alert);
        renderHints(alert);
    }
    function renderTimeline(alert) {
        document.getElementById('alertTimeline').innerHTML = alert.timeline.map((item) => `<div class="alert-timeline-item">
            <strong>${P.escapeHtml(item.title)}</strong>
            <span>${P.escapeHtml(item.meta)}</span>
        </div>`).join('');
    }
    function renderVehicleSummary(alert) {
        document.getElementById('alertVehicleId').textContent = alert.agv_id;
        document.getElementById('alertVehicleOnline').textContent = agvSnapshot.online;
        document.getElementById('alertVehicleMode').textContent = agvSnapshot.mode;
        document.getElementById('alertVehicleTask').textContent = alert.task_name || agvSnapshot.task;
        document.getElementById('alertVehicleRisk').textContent = levelText(alert);
        document.getElementById('alertVehiclePoseTime').textContent = agvSnapshot.poseTime;
    }
    function renderHints(alert) {
        const hints = [];
        if (['pending', 'processing'].includes(alert.status)) hints.push({hot: true, text: '持续告警：当前事件尚未闭环，需要保持跟踪。'});
        if (alert.level === 'critical') hints.push({hot: true, text: '高优先级：建议人工确认车辆位置、风险区域和任务状态。'});
        if (alert.monitor_zone === '是') hints.push({hot: false, text: '重点监测区：事件与重点风险区有关，建议保留追溯记录。'});
        if (alert.type === 'offline') hints.push({hot: true, text: '接入异常：需核对车辆实时位姿回传链路。'});
        if (!hints.length) hints.push({hot: false, text: '当前事件已归档，可作为运行状态追溯。'});
        document.getElementById('alertHintList').innerHTML = hints.map((hint) => `<div class="alert-hint ${hint.hot ? 'is-hot' : ''}">${P.escapeHtml(hint.text)}</div>`).join('');
    }
    function renderSupport() {
        const priority = alerts.slice().sort((a, b) => levelPriority(b.level) - levelPriority(a.level) || b.risk_score - a.risk_score).slice(0, 4);
        document.getElementById('alertPriorityCount').textContent = `Top ${priority.length}`;
        document.getElementById('alertPriorityList').innerHTML = priority.map((alert) => `<div class="support-row">
            <div><strong>${P.escapeHtml(alert.title)}</strong><span>${P.escapeHtml(alert.agv_id)} · ${P.escapeHtml(alert.zone_name)} · ${P.escapeHtml(alert.status_cn)}</span></div>
            <span class="${levelBadge(alert.level)}">${P.escapeHtml(levelText(alert))}</span>
        </div>`).join('') || '<div class="support-empty">暂无重点关注告警</div>';
        renderCountSummary('alertTypeSummary', countBy(alerts, 'type_cn'));
        renderCountSummary('alertZoneSummary', countBy(alerts, 'zone_name'));
    }
    function countBy(items, field) {
        return items.reduce((acc, item) => {
            const key = item[field] || '--';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
    }
    function renderCountSummary(id, counts) {
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
        document.getElementById(id).innerHTML = entries.map(([name, count]) => `<div class="support-row">
            <div><strong>${P.escapeHtml(name)}</strong><span>告警事件 ${count} 条</span></div>
            <span class="badge badge-info">${count}</span>
        </div>`).join('') || '<div class="support-empty">暂无统计数据</div>';
    }
    function renderAll() {
        ensureSelectedVisible();
        renderStats();
        renderList();
        renderDetail();
        renderSupport();
    }
    function addAlert(raw) {
        const normalized = normalizeAlert(Object.assign({zone_name: P.FOCUS_ZONE_NAME}, raw), 0);
        alerts = [normalized].concat(alerts.filter((item) => item.id !== normalized.id)).slice(0, 80);
        selectedAlertId = normalized.id;
        activeQuickFilter = 'all';
        renderAll();
    }
    function applyQuickFilter(filterName) {
        activeQuickFilter = filterName;
        document.getElementById('alertSearch').value = '';
        document.getElementById('alertLevelFilter').value = 'all';
        document.getElementById('alertStatusFilter').value = 'all';
        document.getElementById('alertTypeFilter').value = 'all';
        document.getElementById('alertZoneFilter').value = 'all';
        if (filterName === 'critical') document.getElementById('alertLevelFilter').value = 'critical';
        if (filterName === 'warn') document.getElementById('alertLevelFilter').value = 'warn';
        if (filterName === 'handled') document.getElementById('alertStatusFilter').value = 'handled';
        if (filterName === 'pending') document.getElementById('alertStatusFilter').value = 'pending';
        renderAll();
    }
    async function loadInitialAlerts() {
        try {
            const data = await P.fetchJson('/api/alerts/recent?limit=60');
            const sourceAlerts = data.alerts && data.alerts.length ? data.alerts : createFallbackAlerts();
            alerts = normalizeAll(sourceAlerts);
            selectedAlertId = alerts[0] ? alerts[0].id : null;
            renderAll();
        } catch (e) {
            alerts = normalizeAll(createFallbackAlerts());
            selectedAlertId = alerts[0] ? alerts[0].id : null;
            renderAll();
        }
        try { P.updateSystemStatus(await P.fetchJson('/api/system/status')); } catch (e) {}
    }
    function bindEvents() {
        ['alertSearch', 'alertLevelFilter', 'alertStatusFilter', 'alertTypeFilter', 'alertZoneFilter'].forEach((id) => {
            document.getElementById(id).addEventListener(id === 'alertSearch' ? 'input' : 'change', () => {
                activeQuickFilter = 'custom';
                renderAll();
            });
        });
        document.getElementById('alertCenterList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-alert-id]');
            if (!row) return;
            selectedAlertId = row.dataset.alertId;
            renderAll();
        });
        document.querySelectorAll('[data-alert-quick]').forEach((button) => {
            button.addEventListener('click', () => applyQuickFilter(button.dataset.alertQuick));
        });
    }
    function handleAgv(data) {
        agvSnapshot.id = data.id || 'agv-001';
        agvSnapshot.online = data.source === 'ros2' ? '在线' : '无实时位姿';
        agvSnapshot.mode = P.modeText(data.mode || 'idle');
        agvSnapshot.poseTime = P.fmtTime(data.timestamp);
        renderDetail();
    }
    function handleRisk(data) {
        agvSnapshot.risk = data.risk_level_cn || P.riskLevelText(data.risk_level || P.riskStateToLevel(data.risk_state || 'safe'));
        renderDetail();
    }
    function handleMission(data) {
        agvSnapshot.task = data.route_name || '待命巡检';
        agvSnapshot.mode = data.running ? '任务执行中' : P.modeText(data.mode || 'idle');
        renderDetail();
    }
    document.addEventListener('DOMContentLoaded', async () => {
        P.startClock();
        bindEvents();
        renderAll();
        P.connectLiveData({onAlert: addAlert, onAgv: handleAgv, onRisk: handleRisk, onMission: handleMission, onSystem: P.updateSystemStatus});
        await loadInitialAlerts();
    });
})();
