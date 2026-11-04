"""Attractor-driven facades (after 点干扰开口, 百叶旋转干扰, 渐变立面, 图像干扰): square frames whose openings follow the
distance to attractor points (or an image's grey levels), and louvre blades that turn with it.

Facades lie flat like perforated_panel: x across [0, width], y up the facade [0, height], +z out of it. Stand one up
with obj.rotation_euler = (math.radians(90), 0, 0), or bend it round a tower with voronoi.wrap()."""
import math

import numpy as np

from .geometry import Mesh, box, check_count, ensure_finite, merged

FALLOFFS = ('linear', 'smooth', 'gaussian')
MAX_ATTRACTORS = 1000
MAX_FIELD_POINTS = 1_000_000
MAX_PANELS = 40_000
MAX_BLADES = 10_000
MAX_VALUES = 4096 * 4096  # cells of a values grid (an image's grey levels)


def _influence(t, falloff):
    if falloff == 'linear':
        return 1.0 - t
    if falloff == 'smooth':
        return 1.0 - t * t * (3.0 - 2.0 * t)
    if falloff == 'gaussian':
        floor = math.exp(-4.5)
        return (np.exp(-4.5 * t * t) - floor) / (1.0 - floor)
    raise ValueError(f'unknown falloff {falloff!r}; one of {FALLOFFS}')


def field(points, attractors, radius=3.0, falloff='smooth'):
    """Influence of the nearest attractor at each point, in 0..1: 1 on an attractor, falling to 0 at `radius` and
    beyond ('linear', 'smooth' = 1 - smoothstep, or 'gaussian' rescaled to reach 0 at radius). Attractors are 2D or
    3D; points use as many coordinates as the attractors have."""
    att = np.asarray(attractors, dtype=np.float64)
    if att.ndim != 2 or len(att) == 0 or att.shape[1] not in (2, 3):
        raise ValueError('attractors must be a non-empty list of (x, y) or (x, y, z)')
    check_count('attractors', len(att), MAX_ATTRACTORS)
    if not radius > 0:
        raise ValueError('radius must be positive')
    _influence(np.zeros(1), falloff)
    pts = np.asarray(points, dtype=np.float64)
    if pts.size == 0:
        return []
    pts = np.atleast_2d(pts)
    check_count('points', len(pts), MAX_FIELD_POINTS)
    if pts.ndim != 2 or pts.shape[1] < att.shape[1]:
        raise ValueError('points have fewer coordinates than the attractors')
    if not (np.all(np.isfinite(att)) and np.all(np.isfinite(pts)) and np.isfinite(radius)):
        raise ValueError('points, attractors and radius must be finite')
    out = np.empty(len(pts))
    # Chunks of at most a million point-attractor pairs keep the distance table near 24 MB whatever the counts.
    step = max(1, 1_000_000 // len(att))
    for start in range(0, len(pts), step):
        chunk = pts[start:start + step, :att.shape[1]]
        d = np.sqrt(((chunk[:, None, :] - att[None, :, :]) ** 2).sum(axis=2)).min(axis=1)
        out[start:start + step] = _influence(np.clip(d / radius, 0.0, 1.0), falloff)
    return np.clip(out, 0.0, 1.0).tolist()


def _sample(values, u, v):
    """Bilinear sample of a 2D grid at u, v in 0..1; values[row][col], row 0 at v = 0 (the bottom, as Blender
    stores image.pixels)."""
    grid = np.asarray(values, dtype=np.float64)
    if grid.ndim != 2 or grid.shape[0] < 1 or grid.shape[1] < 1:
        raise ValueError('values must be a 2D grid of numbers in 0..1')
    check_count('values cells', grid.size, MAX_VALUES)
    if not np.all(np.isfinite(grid)):
        raise ValueError('values must be finite numbers in 0..1')
    rows, cols = grid.shape
    x, y = np.clip(u, 0, 1) * (cols - 1), np.clip(v, 0, 1) * (rows - 1)
    c0, r0 = np.floor(x).astype(int), np.floor(y).astype(int)
    c1, r1 = np.minimum(c0 + 1, cols - 1), np.minimum(r0 + 1, rows - 1)
    fx, fy = x - c0, y - r0
    top = grid[r1, c0] * (1 - fx) + grid[r1, c1] * fx
    bottom = grid[r0, c0] * (1 - fx) + grid[r0, c1] * fx
    return np.clip(bottom * (1 - fy) + top * fy, 0.0, 1.0)


def openings(width=8.0, height=4.0, nx=24, ny=12, attractors=((4.0, 2.0),), radius=3.0, min_open=0.1,
             max_open=0.85, falloff='smooth', invert=False, values=None):
    """The opening (inner square's scale, 0..1) of every panel, as rows[j][i] with j up the facade: min_open at an
    attractor growing to max_open at `radius` (invert=True: the other way round); or, with values (a 2D grid in 0..1,
    e.g. an image's grey levels, row 0 at the bottom), min_open where values is 0 and max_open where it is 1."""
    if not (isinstance(nx, int) and isinstance(ny, int) and nx >= 1 and ny >= 1):
        raise ValueError('nx and ny must be positive integers')
    check_count('panels', nx * ny, MAX_PANELS)
    if not (width > 0 and height > 0):
        raise ValueError('width and height must be positive')
    if not 0.0 <= min_open <= max_open < 1.0:
        raise ValueError('need 0 <= min_open <= max_open < 1')
    i, j = np.meshgrid(np.arange(nx), np.arange(ny))
    cx, cy = (i + 0.5) * width / nx, (j + 0.5) * height / ny
    if values is None:
        s = np.array(field(np.stack([cx.ravel(), cy.ravel()], 1), attractors, radius, falloff)).reshape(ny, nx)
        s = 1.0 - s  # 0 on an attractor, 1 at radius
    else:
        s = _sample(values, cx / width, cy / height)
    if invert:
        s = 1.0 - s
    return (min_open + (max_open - min_open) * s).tolist()


def panels(width=8.0, height=4.0, nx=24, ny=12, attractors=((4.0, 2.0),), radius=3.0, min_open=0.1, max_open=0.85,
           falloff='smooth', invert=False, values=None):
    """A flat facade (z = 0) of nx x ny square frames: each cell is the ring between the cell and its opening, an
    inner rectangle scaled by openings(...) about the cell's centre; a zero opening leaves the cell solid. Frames share
    the grid's corners (one welded mesh). Faces face +z."""
    rows = openings(width, height, nx, ny, attractors, radius, min_open, max_open, falloff, invert, values)
    cw, ch = width / nx, height / ny
    vertices = [(i * cw, j * ch, 0.0) for j in range(ny + 1) for i in range(nx + 1)]
    faces = []
    for j in range(ny):
        for i in range(nx):
            o = (j * (nx + 1) + i, j * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i)
            k = rows[j][i]
            if k <= 1e-9:
                faces.append(o)
                continue
            cx, cy, a, b = (i + 0.5) * cw, (j + 0.5) * ch, 0.5 * k * cw, 0.5 * k * ch
            base = len(vertices)
            vertices += [(cx - a, cy - b, 0.0), (cx + a, cy - b, 0.0), (cx + a, cy + b, 0.0), (cx - a, cy + b, 0.0)]
            inner = (base, base + 1, base + 2, base + 3)
            faces += [(o[e], o[(e + 1) % 4], inner[(e + 1) % 4], inner[e]) for e in range(4)]
    return ensure_finite(Mesh(vertices, faces))


def louvre_angles(width=8.0, height=4.0, count=24, attractors=((4.0, 2.0),), radius=3.0, max_angle_deg=75.0,
                  rows=1, falloff='smooth', invert=False):
    """Each blade segment's turn in degrees, as angles[row][blade]: max_angle_deg at an attractor, 0 at `radius` and
    beyond (invert=True: 0 at an attractor, the full turn far away). Measured at the segment's centre."""
    if not (isinstance(count, int) and isinstance(rows, int) and count >= 1 and rows >= 1):
        raise ValueError('count and rows must be positive integers')
    check_count('blades', count * rows, MAX_BLADES)
    if not 0.0 <= max_angle_deg <= 90.0:
        raise ValueError('max_angle_deg must be in 0..90')
    centres = [((i + 0.5) * width / count, (r + 0.5) * height / rows) for r in range(rows) for i in range(count)]
    s = np.array(field(centres, attractors, radius, falloff)).reshape(rows, count)
    if invert:
        s = 1.0 - s
    return (max_angle_deg * s).tolist()


def louvres(width=8.0, height=4.0, count=24, attractors=((4.0, 2.0),), radius=3.0, max_angle_deg=75.0, depth=0.25,
            thickness=0.02, rows=1, falloff='smooth', invert=False):
    """Vertical louvre blades (boxes) across a flat facade: `count` blades at x = (i + 0.5) * width / count, each cut
    into `rows` segments up the facade; a blade stands `depth` out of the facade (z in [0, depth] when unturned) and
    turns about its own vertical centre line by louvre_angles(...)."""
    if not (depth > 0 and thickness > 0):
        raise ValueError('depth and thickness must be positive')
    angles = louvre_angles(width, height, count, attractors, radius, max_angle_deg, rows, falloff, invert)
    seg = height / rows
    blades = []
    for r in range(rows):
        for i in range(count):
            t = math.radians(angles[r][i])
            axes = ((math.cos(t), 0.0, -math.sin(t)), (0.0, 1.0, 0.0), (math.sin(t), 0.0, math.cos(t)))
            centre = ((i + 0.5) * width / count, (r + 0.5) * seg, depth / 2.0)
            blades.append(box(centre, axes, (thickness / 2.0, seg / 2.0, depth / 2.0)))
    return ensure_finite(merged(*blades))
