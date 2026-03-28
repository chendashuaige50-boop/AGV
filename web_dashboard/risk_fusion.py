#!/usr/bin/env python3
"""
risk_fusion.py - Minimum Rule-Based Risk Fusion (Development Period)

Takes vehicle state + terrain query result → risk_score, risk_state, reason.

This is the development-period placeholder for a future probabilistic model.
No D-S evidence theory, no Bayesian network, no fuzzy system.
Pure threshold rules, easy to audit, tune, and replace.

Risk states:
  safe    risk_score in [0.00, 0.40)
  warn    risk_score in [0.40, 0.70)
  danger  risk_score in [0.70, 1.00]

Inputs:
  vehicle_state  dict  : {x, y, speed, heading, last_update}
  terrain_query  dict  : output of risk_layer.query(x, y)

Output:
  dict:
    risk_score      float  0-1
    risk_state      str    "safe" | "warn" | "danger"
    warning_reason  str    human-readable (Chinese + English)
    terrain_risk    float  raw terrain risk value
    gradient_mag    float  ||dRisk||
"""

import math

# ---------------------------------------------------------------------------
# Tunable thresholds
# ---------------------------------------------------------------------------
T_TERRAIN_DANGER = 0.70    # terrain risk → danger
T_TERRAIN_WARN   = 0.40    # terrain risk → warn
T_SPEED_DANGER   = 0.35    # m/s: speed threshold for compound risk rule
T_SPEED_TERRAIN  = 0.50    # terrain value above which speed matters
T_GRAD_WARN      = 0.05    # gradient magnitude → warn
T_GRAD_TERRAIN   = 0.35    # terrain value above which gradient matters


def fuse(vehicle_state: dict, terrain_query: dict) -> dict:
    """
    Compute risk assessment from vehicle state and terrain query.

    Args:
        vehicle_state : dict with at least {x, y, speed}
        terrain_query : dict from risk_layer.query()

    Returns:
        dict with risk_score, risk_state, warning_reason, terrain_risk,
        gradient_mag
    """
    terrain_risk = terrain_query.get('risk', 0.0)
    grad_mag     = terrain_query.get('gradient_mag', 0.0)
    speed        = vehicle_state.get('speed', 0.0)

    # Continuous risk score:
    #   70% terrain value  +  30% gradient signal (tanh-normalised)
    gradient_factor = math.tanh(grad_mag * 10.0)
    risk_score = 0.70 * terrain_risk + 0.30 * gradient_factor
    risk_score = max(0.0, min(1.0, risk_score))

    # --- Rule evaluation (first match wins, ordered by severity) ---

    risk_state     = 'safe'
    warning_reason = '正常运行 / Normal operation'

    # Rule 1: high raw terrain risk
    if terrain_risk >= T_TERRAIN_DANGER:
        risk_state     = 'danger'
        warning_reason = (
            f'地面沉降高风险区域 / High ground subsidence risk '
            f'(terrain={terrain_risk:.2f})'
        )

    # Rule 2: speed + terrain compound
    elif speed >= T_SPEED_DANGER and terrain_risk >= T_SPEED_TERRAIN:
        risk_state     = 'danger'
        warning_reason = (
            f'中高风险区速度过快 / Excessive speed in risk zone '
            f'(speed={speed:.2f} m/s, terrain={terrain_risk:.2f})'
        )

    # Rule 3: moderate terrain risk
    elif terrain_risk >= T_TERRAIN_WARN:
        risk_state     = 'warn'
        warning_reason = (
            f'地面沉降中等风险 / Moderate ground subsidence risk '
            f'(terrain={terrain_risk:.2f})'
        )

    # Rule 4: steep deformation gradient
    elif grad_mag >= T_GRAD_WARN and terrain_risk >= T_GRAD_TERRAIN:
        risk_state     = 'warn'
        warning_reason = (
            f'形变梯度较大 / Steep deformation gradient '
            f'(|∇|={grad_mag:.4f})'
        )

    return {
        'risk_score':      round(risk_score, 3),
        'risk_state':      risk_state,
        'warning_reason':  warning_reason,
        'terrain_risk':    round(terrain_risk, 3),
        'gradient_mag':    round(grad_mag, 5),
    }
