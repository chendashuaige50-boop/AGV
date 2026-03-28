#!/usr/bin/env python3
"""
risk_layer.py - Minimum Risk Layer for Port AGV Digital Twin

Provides a static synthetic risk grid for the development period.
Simulates ground deformation / subsidence risk in a port environment.

In production, this module would:
  - Load a real GeoTIFF via rasterio
  - Apply coordinate transforms (UTM <-> sim frame)
  - Support dynamic updates as new InSAR data arrives

For development: uses a numpy-based grid with synthetic hotspots
calibrated to the harbour_diff_drive simulation layout.

Grid parameters:
  - Coverage: -100m to +100m in x and y (simulation frame)
  - Resolution: 1.0 m per cell  (200 x 200 grid)
  - Origin: sim frame (0, 0) = harbour centre

Risk hotspot layout (matching harbour_diff_drive.sdf poses):
  - Near crane   (-15,  8) : settlement risk under heavy equipment
  - Near container stack (-5, -15) : loading-induced stress
  - Harbour-edge zone   (20,  20) : peripheral subsidence
  - Pier zone           ( 0, -40) : waterfront deformation
"""

import math
import numpy as np

# ---------------------------------------------------------------------------
# Grid configuration
# ---------------------------------------------------------------------------
GRID_MIN_M = -100.0   # metres (sim frame)
GRID_MAX_M =  100.0
GRID_RES_M =   1.0    # metres per cell
GRID_CELLS = int((GRID_MAX_M - GRID_MIN_M) / GRID_RES_M)  # 200

_risk_grid: np.ndarray | None = None   # lazy-initialised


def _build_grid() -> np.ndarray:
    """Build synthetic risk grid once on first query."""
    xs = np.linspace(GRID_MIN_M, GRID_MAX_M, GRID_CELLS)
    ys = np.linspace(GRID_MIN_M, GRID_MAX_M, GRID_CELLS)
    XX, YY = np.meshgrid(xs, ys)   # shape (GRID_CELLS, GRID_CELLS)

    # Base background risk
    grid = np.full((GRID_CELLS, GRID_CELLS), 0.08, dtype=np.float32)

    # Hotspot 1: port crane foundation settlement
    r = np.sqrt((XX + 15)**2 + (YY - 8)**2)
    grid += 0.55 * np.exp(-r**2 / (2 * 7.0**2))

    # Hotspot 2: container stack loading stress
    r = np.sqrt((XX + 5)**2 + (YY + 15)**2)
    grid += 0.45 * np.exp(-r**2 / (2 * 5.5**2))

    # Hotspot 3: harbour peripheral subsidence (top-right)
    r = np.sqrt((XX - 20)**2 + (YY - 20)**2)
    grid += 0.35 * np.exp(-r**2 / (2 * 10.0**2))

    # Hotspot 4: pier/waterfront deformation (bottom)
    r = np.sqrt((XX)**2 + (YY + 40)**2)
    grid += 0.40 * np.exp(-r**2 / (2 * 8.0**2))

    return np.clip(grid, 0.0, 1.0)


def _get_grid() -> np.ndarray:
    """Return cached grid, building it on first call."""
    global _risk_grid
    if _risk_grid is None:
        _risk_grid = _build_grid()
    return _risk_grid


def _xy_to_idx(x: float, y: float) -> tuple[int, int]:
    """Convert world coords (m) → (col, row) grid index, clamped to bounds."""
    ix = int((x - GRID_MIN_M) / GRID_RES_M)
    iy = int((y - GRID_MIN_M) / GRID_RES_M)
    ix = max(0, min(GRID_CELLS - 1, ix))
    iy = max(0, min(GRID_CELLS - 1, iy))
    return ix, iy


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def query(x: float, y: float) -> dict:
    """
    Query risk value and spatial gradient at position (x, y).

    This is the terrain_query interface.  The Flask app calls this
    inside the ROS2 odometry callback on every pose update.

    Args:
        x: x position in metres (simulation frame)
        y: y position in metres (simulation frame)

    Returns:
        dict:
            risk          (float 0-1) : risk value at this location
            gradient_x    (float)     : dRisk/dx  (per metre)
            gradient_y    (float)     : dRisk/dy  (per metre)
            gradient_mag  (float)     : ||gradient||
            in_bounds     (bool)      : whether position is within grid
    """
    grid = _get_grid()
    in_bounds = (GRID_MIN_M <= x <= GRID_MAX_M) and (GRID_MIN_M <= y <= GRID_MAX_M)

    ix, iy = _xy_to_idx(x, y)
    risk = float(grid[iy, ix])

    # Central-difference gradient
    ix_l = max(0, ix - 1)
    ix_r = min(GRID_CELLS - 1, ix + 1)
    iy_b = max(0, iy - 1)
    iy_t = min(GRID_CELLS - 1, iy + 1)

    grad_x = float(grid[iy, ix_r] - grid[iy, ix_l]) / (2.0 * GRID_RES_M)
    grad_y = float(grid[iy_t, ix] - grid[iy_b, ix]) / (2.0 * GRID_RES_M)
    grad_mag = math.sqrt(grad_x**2 + grad_y**2)

    return {
        'risk':         round(risk, 4),
        'gradient_x':  round(grad_x, 6),
        'gradient_y':  round(grad_y, 6),
        'gradient_mag': round(grad_mag, 6),
        'in_bounds':   in_bounds,
    }


def get_heatmap_data(step: int = 4) -> list[dict]:
    """
    Export sampled grid as list of {x, y, risk} for Leaflet heatmap.

    Args:
        step: sample every N cells (reduces payload size)

    Returns:
        list of {x, y, risk} dicts (only cells with risk > 0.15)
    """
    grid = _get_grid()
    result = []
    for iy in range(0, GRID_CELLS, step):
        for ix in range(0, GRID_CELLS, step):
            risk = float(grid[iy, ix])
            if risk > 0.15:
                x = GRID_MIN_M + ix * GRID_RES_M
                y = GRID_MIN_M + iy * GRID_RES_M
                result.append({'x': x, 'y': y, 'risk': round(risk, 3)})
    return result
