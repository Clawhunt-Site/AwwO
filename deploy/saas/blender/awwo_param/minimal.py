"""Minimal surfaces (after the owner's 各种极小曲面的公式 and 极小曲面首饰): triply periodic minimal surfaces as implicit
functions meshed by marching tetrahedra and clipped to a box, sphere or cylinder, and the classical parametric
minimal surfaces. Thicken a surface with awwo_param.blender.solidify (Blender's Solidify modifier); for jewellery,
sheet() builds the lattice as one closed solid with even walls instead, also round a ring's band."""
import math
from collections import namedtuple

import numpy as np

from . import _march
from .geometry import Mesh, check_count, ensure_finite

MAX_GRID = 160          # grid cells along any axis
MAX_PERIODS = 32        # cells (periods) along any axis
# Triangles of one tpms(): many periods at a fine grid would outgrow a workstation's memory long before Blender holds
# the mesh (every one costs a few hundred bytes on the way); they are counted before any is built.
MAX_TRIANGLES = 3_000_000
MAX_PARAMETRIC = 1024   # quads along u or v
MAX_PARAMETRIC_QUADS = 512 * 512


def _gyroid(x, y, z):
    return np.sin(x) * np.cos(y) + np.sin(y) * np.cos(z) + np.sin(z) * np.cos(x)


def _schwarz_p(x, y, z):
    return np.cos(x) + np.cos(y) + np.cos(z)


def _schwarz_d(x, y, z):
    sx, sy, sz, cx, cy, cz = np.sin(x), np.sin(y), np.sin(z), np.cos(x), np.cos(y), np.cos(z)
    return sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz


def _neovius(x, y, z):
    return 3.0 * (np.cos(x) + np.cos(y) + np.cos(z)) + 4.0 * np.cos(x) * np.cos(y) * np.cos(z)


def _lidinoid(x, y, z):
    return (0.5 * (np.sin(2 * x) * np.cos(y) * np.sin(z) + np.sin(2 * y) * np.cos(z) * np.sin(x)
                   + np.sin(2 * z) * np.cos(x) * np.sin(y))
            - 0.5 * (np.cos(2 * x) * np.cos(2 * y) + np.cos(2 * y) * np.cos(2 * z) + np.cos(2 * z) * np.cos(2 * x))
            + 0.15)


def _iwp(x, y, z):
    return (2.0 * (np.cos(x) * np.cos(y) + np.cos(y) * np.cos(z) + np.cos(z) * np.cos(x))
            - (np.cos(2 * x) + np.cos(2 * y) + np.cos(2 * z)))


def _fischer_koch_s(x, y, z):
    return (np.cos(2 * x) * np.sin(y) * np.cos(z) + np.cos(x) * np.cos(2 * y) * np.sin(z)
            + np.sin(x) * np.cos(y) * np.cos(2 * z))


def _split_p(x, y, z):
    return (1.1 * (np.sin(2 * x) * np.sin(z) * np.cos(y) + np.sin(2 * y) * np.sin(x) * np.cos(z)
                   + np.sin(2 * z) * np.sin(y) * np.cos(x))
            - 0.2 * (np.cos(2 * x) * np.cos(2 * y) + np.cos(2 * y) * np.cos(2 * z) + np.cos(2 * z) * np.cos(2 * x))
            - 0.4 * (np.cos(2 * x) + np.cos(2 * y) + np.cos(2 * z)))


# Each takes coordinates in radians (one period = 2 pi along every axis).
TPMS = {'gyroid': _gyroid, 'schwarz_p': _schwarz_p, 'schwarz_d': _schwarz_d, 'diamond': _schwarz_d,
        'neovius': _neovius, 'lidinoid': _lidinoid, 'iwp': _iwp, 'fischer_koch_s': _fischer_koch_s,
        'split_p': _split_p}
SHAPES = ('box', 'sphere', 'cylinder')


def _triple(value, name):
    if isinstance(value, (int, float)):
        value = (value, value, value)
    out = tuple(float(v) for v in value)
    if len(out) != 3 or not all(v > 0 and math.isfinite(v) for v in out):
        raise ValueError(f'{name} must be three positive numbers')
    return out


def _field(kind, size, cells):
    if kind not in TPMS:
        raise ValueError(f'unknown TPMS kind {kind!r}; one of {sorted(TPMS)}')
    size, cells = _triple(size, 'size'), _triple(cells, 'cells')
    for c in cells:
        check_count('cells', c, MAX_PERIODS)
    scale = np.array([2.0 * math.pi * c / s for c, s in zip(cells, size)])
    fn = TPMS[kind]

    def evaluate_points(points):
        q = np.asarray(points, dtype=np.float64).reshape(-1, 3) * scale
        return fn(q[:, 0], q[:, 1], q[:, 2])
    return evaluate_points, size


def evaluate(kind, points, size=(2.0, 2.0, 2.0), cells=(2, 2, 2)):
    """The implicit function tpms() meshes, at points (n, 3) in metres around the box's centre (the origin)."""
    fn, _size = _field(kind, size, cells)
    return fn(points)


def shape_distance(shape, points, size=(2.0, 2.0, 2.0)):
    """Signed distance (negative inside) to the solid tpms() clips to: the box itself, the sphere of diameter
    min(size), or the upright cylinder of diameter min(sx, sy) and height sz, all centred on the origin."""
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    sx, sy, sz = _triple(size, 'size')
    if shape == 'box':
        return np.max(np.abs(p) - np.array([sx, sy, sz]) / 2.0, axis=1)
    if shape == 'sphere':
        return np.linalg.norm(p, axis=1) - min(sx, sy, sz) / 2.0
    if shape == 'cylinder':
        return np.maximum(np.hypot(p[:, 0], p[:, 1]) - min(sx, sy) / 2.0, np.abs(p[:, 2]) - sz / 2.0)
    raise ValueError(f'unknown shape {shape!r}; one of {SHAPES}')


def _clip_distance(shape, points, size):
    """What tpms() cuts the surface by: the solid's signed distance (shape_distance), but a cylinder's radial part
    alone. Its height is the grid's, which ends the surface there already; a second cut along the caps would meet the
    first at the rim's corners and pinch the mesh into vertices two fans share."""
    if shape != 'cylinder':
        return shape_distance(shape, points, size)
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    return np.hypot(p[:, 0], p[:, 1]) - min(size[0], size[1]) / 2.0


def _clip_gradient(shape, p, size):
    if shape == 'sphere':
        return p / np.maximum(np.linalg.norm(p, axis=1), 1e-300)[:, None]
    rho = np.maximum(np.hypot(p[:, 0], p[:, 1]), 1e-300)
    return np.stack([p[:, 0] / rho, p[:, 1] / rho, np.zeros(len(p))], axis=1)


def _onto_rim(points, fn, level, shape, size, step, iterations=4):
    """Moves cut points onto both the surface and the cut's boundary (_clip_distance; Gauss-Newton, minimum-norm
    steps), leaving any point alone whose step would be large, whose two constraints are nearly parallel, or that
    would leave the grid's box: a cylinder's wall runs on past its caps, which the grid's ends make."""
    p = points.copy()
    h = 1e-6 * min(size)
    half = np.array(size) / 2.0
    for _ in range(iterations):
        g1 = fn(p) - level
        g2 = _clip_distance(shape, p, size)
        a = np.stack([(fn(p + e) - fn(p - e)) / (2 * h) for e in np.eye(3) * h], axis=1)
        b = _clip_gradient(shape, p, size)
        aa, ab, bb = (a * a).sum(1), (a * b).sum(1), (b * b).sum(1)
        det = aa * bb - ab * ab
        ok = det > 1e-6 * aa * bb
        det = np.where(ok, det, 1.0)
        l1, l2 = (bb * g1 - ab * g2) / det, (aa * g2 - ab * g1) / det
        move = -(l1[:, None] * a + l2[:, None] * b)
        ok &= (np.linalg.norm(move, axis=1) < 0.5 * step) & np.all(np.abs(p + move) <= half, axis=1)
        p = np.where(ok[:, None], p + move, p)
    # Converged points can sit a hair outside the solid; pull those back onto it along its normal.
    d = _clip_distance(shape, p, size)
    return p - np.maximum(d, 0.0)[:, None] * _clip_gradient(shape, p, size)


def _unfold(before, after, faces, reference):
    """Moving rim points onto the rim can turn a thin rim triangle over (or collapse it): put the points of every
    such triangle back where the cut left them, until none turns more than 84 degrees off the face it came from
    (reference: that face's normal; the cut left every face within 25 degrees of it, so a triangle with all its points
    back passes, and this ends after at most as many rounds as points moved). Those stay a little inside the solid."""
    def normals(v):
        t = v[faces]
        return np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    a0, r = np.linalg.norm(normals(before), axis=1), np.linalg.norm(reference, axis=1)
    moved = np.any(after != before, axis=1)
    while moved.any():
        n1 = normals(after)
        a1 = np.linalg.norm(n1, axis=1)
        # Turned over (or nearly on edge), or shrunk to under a hundredth: two rim points moved onto one spot.
        folded = ((reference * n1).sum(axis=1) <= 0.1 * r * a1) | (a1 < 0.01 * a0)
        undo = np.zeros(len(after), bool)
        undo[faces[folded].ravel()] = True
        undo &= moved
        if not undo.any():
            break
        after = np.where(undo[:, None], before, after)
        moved &= ~undo
    return after


def tpms(kind='gyroid', size=(2.0, 2.0, 2.0), cells=(2, 2, 2), resolution=32, level=0.0, shape='box'):
    """A triply periodic minimal surface {f = level} filling a box of `size` metres centred on the origin with
    `cells` periods along x, y, z, clipped to `shape` ('box', 'sphere' or 'cylinder', see shape_distance) so it ends
    on the solid's surface. `resolution` = grid cells along the longest side (at most MAX_GRID; the default gives
    about 60,000 triangles for the default gyroid, and triangles grow with its square and with the cells, up to
    MAX_TRIANGLES); level != 0 thickens one side's channels (the sheet stays one surface). kind: gyroid, schwarz_p,
    schwarz_d (= diamond), neovius, lidinoid, iwp, fischer_koch_s, split_p. One welded, manifold mesh, faces towards
    f > level."""
    vertices, faces, _turned = _surface(kind, size, cells, resolution, level, shape)
    return ensure_finite(Mesh([tuple(v) for v in vertices.tolist()], [tuple(f) for f in faces.tolist()]))


def _surface(kind, size, cells, resolution, level, shape):
    """tpms()'s mesh as arrays (vertices, faces), with the normal of the marching face each face came from (turned): a
    clipped face never turns against it (_unfold)."""
    if shape not in SHAPES:
        raise ValueError(f'unknown shape {shape!r}; one of {SHAPES}')
    fn, size = _field(kind, size, cells)
    if not isinstance(resolution, int) or resolution < 4:
        raise ValueError('resolution must be an integer >= 4')
    if not math.isfinite(level):
        raise ValueError('level must be a finite number')
    check_count('resolution', resolution, MAX_GRID)
    longest = max(size)
    counts = [max(2, round(resolution * s / longest)) for s in size]
    spacing = np.array(size) / np.array(counts)
    # A clipped surface's grid reaches a cell past its solid, so that the solid never meets the grid's own border: a
    # sphere or cylinder as wide as the box would touch it along points and lines, squeezing the rim there into
    # needles. A cylinder's caps are the grid's ends.
    pad = np.array({'box': (0, 0, 0), 'sphere': (1, 1, 1), 'cylinder': (1, 1, 0)}[shape])
    origin = -np.array(size) / 2.0 - pad * spacing
    axes = [origin[a] + spacing[a] * np.arange(counts[a] + 2 * pad[a] + 1) for a in range(3)]
    gx, gy, gz = np.meshgrid(*axes, indexing='ij')
    values = fn(np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)).reshape(gx.shape)
    vertices, faces = _march.marching_tetrahedra(values, origin, spacing, float(level), max_triangles=MAX_TRIANGLES)
    turned = _march._normals(vertices, faces)
    if shape != 'box' and len(faces):
        vertices, faces, is_cut, source = _march.clip_by_distance(vertices, faces, _clip_distance(shape, vertices, size))
        turned = turned[source]
        if is_cut.any():
            cut = vertices.copy()
            vertices[is_cut] = _onto_rim(vertices[is_cut], fn, float(level), shape, size, float(spacing.min()))
            vertices = _unfold(cut, vertices, faces, turned)
    return vertices, faces, turned


SHEET_SHAPES = SHAPES + ('ring',)
# A sheet's grid must resolve both its smallest period and its wall: fewer grid cells across either breaks the
# lattice into crumbs and holes. The period is its function's finest wave: these kinds have terms at twice their
# period's frequency (sin 2x, cos 2y), so they need twice the grid cells a period.
GRID_PER_PERIOD = 6
GRID_PER_WALL = 2
HARMONICS = {'lidinoid': 2, 'iwp': 2, 'fischer_koch_s': 2, 'split_p': 2}
MAX_SMOOTH = 100        # rounds of smoothing a sheet takes
SHRINK = 0.05           # how much of its volume a part may lose or gain to smoothing before it keeps its marched shape
PAIR_CHUNK = 1 << 20    # how many pairs of faces a crossing check tests at once
MIN_SHEET_SIZE = 1e-6   # metres: a sheet's box along any axis (a micrometre; below, its gradients lose precision)
MIN_CELLS = 0.01        # periods along any axis: fewer leave no lattice in the box
# A sheet's grid with its pad (_sheet_grid), and the work over it: the jump flood's (points × 26 × rounds) and the
# crossings' bisections (each CROSSING_ROUNDS evaluations of the field, EVALUATION_WORK flood steps apiece): about
# 2 GB and 30 s on a workstation at most, within a Blender call's limit.
MAX_SHEET_NODES = 12_000_000
MAX_SHEET_WORK = 3_000_000_000
CROSSING_ROUNDS = 8     # halvings that put a crossing on the surface: to 1/256 of its grid segment
NEWTON_ROUNDS = 3       # Newton steps that take a grid point near the surface onto it
NEWTON_MORE_ROUNDS = 8  # in all, for a point not on the surface after those
ON_SURFACE = 1e-3       # how near (in grid cells, to first order) a Newton foot must end to the surface to count
EVALUATION_WORK = 8
# The 26 neighbours of a grid point, which pass each other the surface's nearest point (_surface_distance).
NEIGHBOURS = tuple((dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1) if (dx, dy, dz) != (0, 0, 0))


def _smooth_max(a, b, k):
    """max(a, b) with its crease rounded: where two distances meet, the solid they bound gets an edge of radius about
    k instead of a sharp one, which a grid would sample into saw teeth. It is max(a, b) itself wherever the two differ
    by k or more (a polynomial blend, smooth to the first derivative), so walls keep their thickness away from edges.
    k = 0 is max itself."""
    if k <= 0:
        return np.maximum(a, b)
    blend = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.maximum(a, b) + 0.25 * k * blend * blend


def _sheet_bound(shape, points, size, inner, k):
    """The solid a sheet is cut to (shape_distance, or a ring's band: the upright tube of outer diameter min(sx, sy),
    inner diameter `inner` and height sz), with its own edges rounded by k."""
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    sx, sy, sz = size
    if shape == 'sphere':
        return np.linalg.norm(p, axis=1) - min(sx, sy, sz) / 2.0
    height = np.abs(p[:, 2]) - sz / 2.0
    if shape == 'box':
        return _smooth_max(_smooth_max(np.abs(p[:, 0]) - sx / 2.0, np.abs(p[:, 1]) - sy / 2.0, k), height, k)
    r = np.hypot(p[:, 0], p[:, 1])
    radial = r - min(sx, sy) / 2.0
    if shape == 'ring':
        radial = _smooth_max(radial, inner / 2.0 - r, k)
    return _smooth_max(radial, height, k)


def _sheet_field(kind, size, cells, inner, wrap):
    """The TPMS function a sheet is built round, on x, y, z arrays in metres: in the box's axes, or wrapped round the z
    axis (cells[0] periods round, cells[1] across the band's wall from its middle, cells[2] up)."""
    fn = TPMS[kind]
    if not wrap:
        k = [2.0 * math.pi * c / s for c, s in zip(cells, size)]
        return lambda x, y, z: fn(x * k[0], y * k[1], z * k[2])
    outer = min(size[0], size[1]) / 2.0
    middle, kr, kz = (outer + inner / 2.0) / 2.0, 2.0 * math.pi * cells[1] / (outer - inner / 2.0), 2.0 * math.pi * cells[2] / size[2]
    return lambda x, y, z: fn(np.arctan2(y, x) * cells[0], (np.hypot(x, y) - middle) * kr, z * kz)


def _sheet_spacing(size, resolution):
    """A sheet grid's cells: `resolution` along the box's longest side, fewer in proportion along the others."""
    longest = max(size)
    counts = [max(2, round(resolution * s / longest)) for s in size]
    return np.array(size) / np.array(counts), counts


def _sheet_grid(size, resolution, reach=0.0):
    """A sheet's grid (origin, spacing, axes): the box's cells (_sheet_spacing) and, past the box on every side, one
    cell, so that the solid closes inside the grid, and as many more as `reach` (metres) takes, so that a point in the
    box has the surface within that reach on the grid even where the nearest of it lies outside the box."""
    spacing, counts = _sheet_spacing(size, resolution)
    pad = np.array([1 + int(math.ceil(reach / s)) for s in spacing])
    origin = -np.array(size) / 2.0 - pad * spacing
    return origin, spacing, [origin[a] + spacing[a] * np.arange(counts[a] + 2 * pad[a] + 1) for a in range(3)]


def _shifted(n, offset):
    """The slices that pair each grid point with the one `offset` (cells per axis) from it: (theirs, its)."""
    return (tuple(slice(max(o, 0), m + min(o, 0)) for o, m in zip(offset, n)),
            tuple(slice(max(-o, 0), m + min(-o, 0)) for o, m in zip(offset, n)))


def _distance_strides(reach_cells):
    """The jump flood's strides for a reach of that many cells: halving from the largest power of two within it down
    to 1, then 1 again (which mends the jump flood's rare misses), so the rounds grow with the log of the reach."""
    strides, stride = [], 1
    while stride * 2 <= max(1, reach_cells):
        stride *= 2
    while stride >= 1:
        strides.append(stride)
        stride //= 2
    return strides + [1]


def _crossing_count(f):
    """How many of the grid's segments to a neighbour (the 13 directions of NEIGHBOURS[13:]) f changes sign along."""
    negative = f < 0
    total = 0
    for offset in NEIGHBOURS[13:]:
        theirs, its = _shifted(negative.shape, offset)
        total += int(np.count_nonzero(negative[its] != negative[theirs]))
    return total


def _surface_distance(field, x, y, z, spacing, reach, f=None, check=None):
    """Each grid point's distance to the surface {f = 0} (x, y, z: the grid's coordinates, spacing its steps along the
    axes; f the field on them, if known), exact to a small part of a grid cell up to `reach` metres and `reach` beyond
    it. Points of the surface itself seed it, two ways. Wherever f changes sign along one of the 13 directions to a
    neighbour (the axes, the faces' and the cube's diagonals), bisection finds the crossing on that segment
    (CROSSING_ROUNDS halvings) and offers it to both ends: about nine feet to a square grid cell. And a grid point within
    a cell of the surface to first order (|f| / |grad f|, central differences) takes itself onto it by Newton's method
    (NEWTON_ROUNDS steps, up to NEWTON_MORE_ROUNDS for one not there yet), which also finds a patch a segment crosses
    twice, in and out between its ends; a foot that
    does not end on the surface (ON_SURFACE: where the field bends within the cell) is dropped. Then a jump flood: each
    round every point takes the nearest foot one of its 26 neighbours a stride away holds (_distance_strides). Every foot
    lies on the surface, so no distance comes out shorter than the true one (by more than the bisection or ON_SURFACE
    leaves): no wall thickens and no channel fills. The distance is measured, never inferred from f: |f| / |grad f| far
    from the surface fills a channel's middle where the gradient vanishes. check(work), if given, sees the evaluations
    of the field the seeds take (in the jump flood's steps, EVALUATION_WORK apiece) before any is made, and may refuse."""
    f = field(x, y, z) if f is None else f
    n = f.shape
    negative = f < 0
    step = float(max(spacing))
    h = 1e-4 * step

    def gradient(px, py, pz):
        return [(field(px + h * e[0], py + h * e[1], pz + h * e[2]) - field(px - h * e[0], py - h * e[1], pz - h * e[2])) / (2 * h)
                for e in np.eye(3)]

    if check is not None:
        check(6 * f.size * EVALUATION_WORK)
    d = gradient(x, y, z)
    # The gradient's length without squaring it (no overflow at small sizes).
    slope = np.hypot(np.hypot(d[0], d[1]), d[2])
    with np.errstate(divide='ignore', invalid='ignore'):
        near = np.flatnonzero((slope > 0) & (np.abs(f) <= step * slope))
    if check is not None:
        check((6 * f.size + len(near) * 7 * NEWTON_ROUNDS + _crossing_count(f) * CROSSING_ROUNDS) * EVALUATION_WORK)
    # Single precision from here (twice as fast): a part in ten million of the box, far below a grid cell.
    centre = [np.asarray(c, dtype=np.float32) for c in (x, y, z)]
    foot = [np.full(n, np.inf, dtype=np.float32) for _ in range(3)]
    best = np.full(n, np.inf, dtype=np.float32)

    def offer(target, candidate):
        """Gives the points in `target` (slices) the feet in `candidate` (three arrays) where they are nearer."""
        d2 = sum((c[target] - q) ** 2 for c, q in zip(centre, candidate))
        better = d2 < best[target]
        if not better.any():
            return
        for q, value in zip(foot, candidate):
            q[target] = np.where(better, value, q[target])
        best[target] = np.where(better, d2, best[target])

    # The same over the grid's points by their flat index (each named once).
    flat = [c.reshape(-1) for c in (*centre, *foot, best)]
    coordinates = [np.ascontiguousarray(c, dtype=np.float64).reshape(-1) for c in (x, y, z)]

    def offer_at(index, candidate):
        d2 = sum((c[index] - q) ** 2 for c, q in zip(flat[:3], candidate))
        better = d2 < flat[6][index]
        index = index[better]
        for q, value in zip(flat[3:6], candidate):
            q[index] = value[better]
        flat[6][index] = d2[better]

    # Newton's method from each point near the surface, a million at a time: a step along the gradient by
    # f / |grad f|^2, then f and its gradient where it lands; a foot counts only where it ends on the surface. A point
    # whose foot is not there yet after NEWTON_ROUNDS steps takes more, up to NEWTON_MORE_ROUNDS in all (a stretched
    # field converges slowly), the extra work told to check first.
    def newton(index, point, value, grad, length, rounds):
        with np.errstate(divide='ignore', invalid='ignore', over='ignore'):
            for _ in range(rounds):
                safe = np.where(length > 0, length, 1.0)
                along = np.where(length > 0, value / safe / safe, 0.0)
                point = [c - along * g for c, g in zip(point, grad)]
                value, grad = field(*point), gradient(*point)
                length = np.hypot(np.hypot(grad[0], grad[1]), grad[2])
            on = (length > 0) & (np.abs(value) <= ON_SURFACE * step * length) & np.all(np.isfinite(point), axis=0)
        offer_at(index[on], [c[on].astype(np.float32) for c in point])
        late = ~on & np.all(np.isfinite(point), axis=0)
        return index[late], [c[late] for c in point], value[late], [g[late] for g in grad], length[late]

    late = []
    for first in range(0, len(near), 1 << 20):
        some = near[first:first + (1 << 20)]
        late.append(newton(some, [c[some] for c in coordinates], f.reshape(-1)[some], [g.reshape(-1)[some] for g in d],
                           slope.reshape(-1)[some], NEWTON_ROUNDS))
    del d, slope
    if check is not None:
        check((6 * f.size + len(near) * 7 * NEWTON_ROUNDS + sum(len(part[0]) for part in late) * 7 * (NEWTON_MORE_ROUNDS - NEWTON_ROUNDS)
               + _crossing_count(f) * CROSSING_ROUNDS) * EVALUATION_WORK)
    for part in late:
        if len(part[0]):
            newton(*part, NEWTON_MORE_ROUNDS - NEWTON_ROUNDS)

    for offset in NEIGHBOURS[13:]:
        theirs, its = _shifted(n, offset)
        found = np.nonzero(negative[its] != negative[theirs])
        if not len(found[0]):
            continue
        # The segment from each such point (`at`) to its neighbour (`to`), and on it the crossing, bracketed in [lo, hi]
        # by where f is on the point's side and where it is not.
        at = np.ravel_multi_index(tuple(i + s.start for i, s in zip(found, its)), n)
        to = np.ravel_multi_index(tuple(i + s.start for i, s in zip(found, theirs)), n)
        start = [c[at] for c in coordinates]
        span = [c[to] - s for c, s in zip(coordinates, start)]
        side = negative.reshape(-1)[at]
        lo, hi = np.zeros(len(at)), np.ones(len(at))
        for _ in range(CROSSING_ROUNDS):
            mid = 0.5 * (lo + hi)
            same = (field(*(s + mid * d for s, d in zip(start, span))) < 0) == side
            lo, hi = np.where(same, mid, lo), np.where(same, hi, mid)
        mid = 0.5 * (lo + hi)
        crossing = [(s + mid * d).astype(np.float32) for s, d in zip(start, span)]
        offer_at(at, crossing)
        offer_at(to, crossing)
    for stride in _distance_strides(int(math.ceil(reach / float(min(spacing))))):
        for offset in NEIGHBOURS:
            theirs, its = _shifted(n, tuple(o * stride for o in offset))
            offer(its, [q[theirs].copy() for q in foot])
    return np.minimum(np.sqrt(best).astype(np.float64), reach)


def _wall_reach(spacing, thickness):
    """How far a sheet measures the surface's distance: two grid cells past half the wall."""
    return thickness / 2.0 + 2.0 * float(max(spacing))


def _sheet_wall(field, x, y, z, spacing, thickness, f=None, check=None):
    """How far outside the sheet's wall each grid point is (negative inside): its distance to {f = 0}
    (_surface_distance, measured to _wall_reach) less half the wall."""
    return _surface_distance(field, x, y, z, spacing, _wall_reach(spacing, thickness), f, check) - thickness / 2.0


# Rays off every axis and diagonal and off each other, for _encloses: when one passes through an edge or a corner of a
# shell, or runs in a triangle's plane, the next decides.
RAYS = tuple(np.array(r) / np.linalg.norm(r) for r in ((0.5773, 0.5779, 0.5767), (-0.6178, 0.3091, 0.7231),
                                                       (0.2113, -0.8402, 0.4996), (-0.4387, -0.5146, -0.7366)))
# How near (in parts of a triangle, or of the shell's size along a ray) an edge, a corner or the ray's start a crossing
# may be and still count.
NEAR = 1e-9


def _crossings(triangles, point, ray, scale):
    """How many triangles of `triangles` (n, 3, 3) the ray from `point` crosses (Moller-Trumbore), or None if it passes
    through an edge or a corner of one, runs in a triangle's plane, or starts on the shell: a crossing there could be
    counted twice or not at all. scale: the shell's size. A triangle with no area is no crossing."""
    e1, e2 = triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    normal = np.cross(e1, e2)
    area = np.linalg.norm(normal, axis=1)
    real = area > NEAR * np.linalg.norm(e1, axis=1) * np.linalg.norm(e2, axis=1)
    p = np.cross(ray, e2)
    det = np.einsum('ij,ij->i', e1, p)
    s = point - triangles[:, 0]
    flat = real & (np.abs(det) <= NEAR * area)
    if (flat & (np.abs(np.einsum('ij,ij->i', s, normal)) <= NEAR * scale * area)).any():
        return None
    crossing = real & ~flat
    inv = np.where(crossing, 1.0 / np.where(crossing, det, 1.0), 0.0)
    u = np.einsum('ij,ij->i', s, p) * inv
    q = np.cross(s, e1)
    v = (q @ ray) * inv
    t = np.einsum('ij,ij->i', e2, q) * inv
    inside = np.minimum(np.minimum(u, v), 1.0 - u - v)
    meets = crossing & (inside >= -NEAR) & (t >= -NEAR * scale)
    if (meets & ((inside <= NEAR) | (t <= NEAR * scale))).any():
        return None
    return int(np.count_nonzero(meets))


def _encloses(triangles, points):
    """Whether the closed shell `triangles` (n, 3, 3) encloses `points` (a cavity's vertices: all inside it or all
    outside, since a sheet's shells never meet): the parity of a ray's crossings (_crossings), from the first of the
    points and of RAYS that crosses the shell clear of its edges and corners and starts off it. Undecided (every ray from
    every point grazing the shell), not."""
    low, high = triangles.min(axis=(0, 1)), triangles.max(axis=(0, 1))
    scale = float(np.linalg.norm(high - low))
    for point in points:
        if (point < low).any() or (point > high).any():
            return False
        for ray in RAYS:
            count = _crossings(triangles, point, ray, scale)
            if count is not None:
                return bool(count % 2)
    return False


def _closed_parts(vertices, faces, min_part):
    """The mesh without its crumbs: closed parts that face outward (a positive volume) with fewer than min_part of the
    largest such part's triangles. A part that faces inward is a cavity's wall, and it belongs to the outward part right
    round it (the smallest that encloses it, by ray parity): it goes only with that part, so no void is filled and none
    floats alone. Only a cavity a dropped part's box holds is tested, and only against parts that could own it (the
    dropped ones round it, and any smaller), so a lattice of many cavities costs little."""
    label = _parts(len(vertices), faces)[faces[:, 0]]
    parts, which = np.unique(label, return_inverse=True)
    which = which.ravel()
    triangles = np.bincount(which, minlength=len(parts))
    t = vertices[faces]
    volume = np.bincount(which, weights=np.einsum('ij,ij->i', t[:, 0], np.cross(t[:, 1], t[:, 2])) / 6.0, minlength=len(parts))
    outward = volume > 0
    if not outward.any():
        return faces
    drop = outward & (triangles < min_part * triangles[outward].max())
    cavities = np.nonzero(~outward)[0]
    if drop.any() and len(cavities):
        # Each part's triangles in a run of their own (sorted by part), and the box round each part.
        order = np.argsort(which, kind='stable')
        start = np.concatenate([[0], np.cumsum(triangles)[:-1]])
        low = np.minimum.reduceat(t.min(axis=1)[order], start)
        high = np.maximum.reduceat(t.max(axis=1)[order], start)
        dropped, kept = np.nonzero(drop)[0], np.nonzero(outward & ~drop)[0]

        def shell(index):
            return t[order[start[index]:start[index] + triangles[index]]]

        for cavity in cavities:
            wall = shell(cavity)
            points = wall[[0, len(wall) // 2, -1], 0]

            def boxed(ids):
                return ids[np.all((low[ids] <= points[0]) & (points[0] <= high[ids]), axis=1)]

            round_it = [index for index in boxed(dropped) if _encloses(shell(index), points)]
            if not round_it:
                continue
            smallest = min(volume[index] for index in round_it)
            if not any(_encloses(shell(index), points) for index in boxed(kept) if volume[index] < smallest):
                drop[cavity] = True
    return faces[~drop[which]]


def _taubin(vertices, faces, rounds, shrink=0.5, inflate=-0.53):
    """Taubin's smoothing (each round moves every vertex towards its neighbours' mean, then back out a little, so the
    solid keeps its volume): it irons out the grid's facets and saw teeth, which polished metal shows in every
    reflection. The faces are unchanged, so the mesh stays welded and watertight."""
    n, faces = len(vertices), np.asarray(faces, dtype=np.int64)
    pairs = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    keys = np.unique(pairs[:, 0] * n + pairs[:, 1])
    a, b = keys // n, keys % n
    degree = (np.bincount(a, minlength=n) + np.bincount(b, minlength=n)).astype(np.float64)
    v = vertices.copy()
    for _ in range(rounds):
        for factor in (shrink, inflate):
            mean = np.stack([np.bincount(a, weights=v[b, k], minlength=n) + np.bincount(b, weights=v[a, k], minlength=n)
                             for k in range(3)], axis=1) / degree[:, None]
            v += factor * (mean - v)
    return v


def _crossing_faces(vertices, faces, cell, near=None):
    """The faces of a mesh that meet another face sharing no vertex with it, as a boolean per face. Each face goes into
    every cell of a hash grid (cells `cell` wide) its box touches; each pair that shares a cell, whose boxes overlap and
    that shares no vertex is tested once, in the first cell the two share (the low corner of where their cells
    overlap), by _faces_meet, PAIR_CHUNK pairs at a time. With `near` (a boolean per face), only the pairs in the cells
    those faces touch: every face whose box overlaps theirs is among them."""
    faces = np.asarray(faces, dtype=np.int64)
    t = vertices[faces]
    lo, hi = t.min(axis=1), t.max(axis=1)
    origin = vertices.min(axis=0)
    first, last = np.floor((lo - origin) / cell).astype(np.int64), np.floor((hi - origin) / cell).astype(np.int64)
    extent = np.floor((vertices.max(axis=0) - origin) / cell).astype(np.int64) + 1
    face_ids, keys = [], []
    spans = (last - first).max(axis=0)
    for dx in range(spans[0] + 1):
        for dy in range(spans[1] + 1):
            for dz in range(spans[2] + 1):
                at = first + (dx, dy, dz)
                inside = np.all(at <= last, axis=1)
                face_ids.append(np.nonzero(inside)[0])
                keys.append((at[inside, 0] * extent[1] + at[inside, 1]) * extent[2] + at[inside, 2])
    face_ids, keys = np.concatenate(face_ids), np.concatenate(keys)
    if near is not None:
        chosen = np.isin(keys, np.unique(keys[near[face_ids]]))
        face_ids, keys = face_ids[chosen], keys[chosen]
    order = np.argsort(keys, kind='stable')
    face_ids, keys = face_ids[order], keys[order]
    crossing = np.zeros(len(faces), dtype=bool)
    # Two faces sharing no vertex must not meet at all: one that touches another, on its border too, counts. The pairs
    # are tested as the offsets find them, never all held at once (a mesh of 2.7 million faces held them in 5.3 GB).
    for offset in range(1, len(keys)):
        same = np.flatnonzero(keys[offset:] == keys[:-offset])
        if not len(same):
            break
        for start in range(0, len(same), PAIR_CHUNK):
            at = same[start:start + PAIR_CHUNK]
            i, j = face_ids[at], face_ids[at + offset]
            corner = np.maximum(first[i], first[j])
            keep = (((corner[:, 0] * extent[1] + corner[:, 1]) * extent[2] + corner[:, 2] == keys[at])
                    & np.all((lo[i] <= hi[j]) & (lo[j] <= hi[i]), axis=1))
            i, j = i[keep], j[keep]
            keep = ~(faces[i][:, :, None] == faces[j][:, None, :]).any(axis=(1, 2))
            i, j = i[keep], j[keep]
            found = _faces_meet(t[i], t[j])
            crossing[i[found]] = True
            crossing[j[found]] = True
    return crossing


# Shewchuk's error bounds for _orient3d's and _orient2d's determinants computed in doubles ("Adaptive Precision
# Floating-Point Arithmetic and Fast Robust Geometric Predicates", 1997): beyond them, the computed sign is the true one.
_HALF_ULP = np.finfo(np.float64).eps / 2
_ORIENT3D_BOUND = (7.0 + 56.0 * _HALF_ULP) * _HALF_ULP
_ORIENT2D_BOUND = (3.0 + 16.0 * _HALF_ULP) * _HALF_ULP
# The bound holds while no product leaves the normal range of doubles: a row with a difference of coordinates (other
# than 0) outside these spans (a product of three, or of two in 2D, stays normal inside them) goes to the integers
# whatever the filter says (review rounds 11 and 13: underflowed products, at 2^-357 metres and at 2^-538, gave sure
# signs that were wrong). Within them, what cancelled terms that come out below the normal range can add to an error.
_SPAN3D = (2.0 ** -340, 2.0 ** 340)
_SPAN2D = (2.0 ** -500, 2.0 ** 500)
_UNDERFLOW = 2.0 ** -1000


def _sure(det, permanent, bound, differences, span):
    """det's sign per row as -1, 0 or 1, and the rows whose sign rounding could have made wrong (or that are 0), among
    them every row with a difference outside span."""
    margin = bound * permanent + _UNDERFLOW
    size = np.abs(differences)
    risky = ((size > 0) & (size < span[0])).any(axis=1) | (size > span[1]).any(axis=1)
    sign = np.where(risky, 0, np.where(det > margin, 1, np.where(det < -margin, -1, 0))).astype(np.int8)
    return sign, np.flatnonzero(sign == 0)


def _integers(*points):
    """The coordinates of one row's points as integers over a common power of two, exactly (each double is an integer
    over a power of two, float.as_integer_ratio): differences and products of them are exact."""
    ratios = [float(x).as_integer_ratio() for point in points for x in point]
    shift = max(denominator.bit_length() for _, denominator in ratios)
    values = iter([numerator << (shift - denominator.bit_length()) for numerator, denominator in ratios])
    return [[next(values) for _ in point] for point in points]


def _orient3d(a, b, c, d):
    """The sign of each tetrahedron's (a, b, c, d) signed volume, (a - d) . ((b - d) x (c - d)), exactly: in doubles
    where Shewchuk's bound makes it sure, else in integers (review round 12: a sign the filter could not be sure of,
    taken as 0, made a sliver 1e-16 wide a segment whose inside an edge crossed unseen)."""
    ad, bd, cd = a - d, b - d, c - d
    bc0, bc1 = bd[:, 0] * cd[:, 1], cd[:, 0] * bd[:, 1]
    ca0, ca1 = cd[:, 0] * ad[:, 1], ad[:, 0] * cd[:, 1]
    ab0, ab1 = ad[:, 0] * bd[:, 1], bd[:, 0] * ad[:, 1]
    det = ad[:, 2] * (bc0 - bc1) + bd[:, 2] * (ca0 - ca1) + cd[:, 2] * (ab0 - ab1)
    permanent = ((np.abs(bc0) + np.abs(bc1)) * np.abs(ad[:, 2]) + (np.abs(ca0) + np.abs(ca1)) * np.abs(bd[:, 2])
                 + (np.abs(ab0) + np.abs(ab1)) * np.abs(cd[:, 2]))
    sign, unsure = _sure(det, permanent, _ORIENT3D_BOUND, np.concatenate([ad, bd, cd], axis=1), _SPAN3D)
    for row in unsure:
        A, B, C, D = _integers(a[row], b[row], c[row], d[row])
        x, y, z = ([p[k] - D[k] for k in range(3)] for p in (A, B, C))
        exact = x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0])
        sign[row] = (exact > 0) - (exact < 0)
    return sign


def _orient2d(a, b, c):
    """The sign of each triangle's (a, b, c) signed area in 2D, exactly (as _orient3d)."""
    differences = np.stack([a[:, 0] - c[:, 0], b[:, 1] - c[:, 1], a[:, 1] - c[:, 1], b[:, 0] - c[:, 0]], axis=1)
    left, right = differences[:, 0] * differences[:, 1], differences[:, 2] * differences[:, 3]
    sign, unsure = _sure(left - right, np.abs(left) + np.abs(right), _ORIENT2D_BOUND, differences, _SPAN2D)
    for row in unsure:
        A, B, C = _integers(a[row], b[row], c[row])
        exact = (A[0] - C[0]) * (B[1] - C[1]) - (A[1] - C[1]) * (B[0] - C[0])
        sign[row] = (exact > 0) - (exact < 0)
    return sign


def _faces_meet(s, t):
    """Whether each triangle of s (n, 3, 3) meets its triangle of t, their borders included, exactly: told by the exact
    signs of volumes and areas (_orient3d, _orient2d), never by a computed crossing point, which a sliver or a nearly
    parallel edge throws off (review rounds 9 and 10). Where two triangles meet, an edge of one meets the other: an
    edge meets a triangle where its ends are not both strictly on one side of the triangle's plane and the line through
    it turns no two ways round the triangle's edges; an edge in the plane, where on the plane it meets the triangle
    (_flat_meets). A triangle with no area is a segment, the union of its edges: an edge meets it where it meets one of
    them (_segments_meet). A pair with every vertex of one strictly on one side of the other's plane is apart, and goes
    no further."""
    hit = np.zeros(len(s), dtype=bool)
    side_s = np.stack([_orient3d(t[:, 0], t[:, 1], t[:, 2], s[:, k]) for k in range(3)])
    side_t = np.stack([_orient3d(s[:, 0], s[:, 1], s[:, 2], t[:, k]) for k in range(3)])
    apart = (side_s > 0).all(axis=0) | (side_s < 0).all(axis=0) | (side_t > 0).all(axis=0) | (side_t < 0).all(axis=0)
    live = np.flatnonzero(~apart)
    if not len(live):
        return hit
    s, t, side_s, side_t = s[live], t[live], side_s[:, live], side_t[:, live]
    # turn[i, j]: the sign of the tetrahedron of s's edge i and t's edge j, which is the same seen from either.
    turn = np.stack([np.stack([_orient3d(s[:, i], s[:, (i + 1) % 3], t[:, j], t[:, (j + 1) % 3]) for j in range(3)])
                     for i in range(3)])
    found = np.zeros(len(live), dtype=bool)
    for one, other, side, turns in ((s, t, side_s, turn), (t, s, side_t, turn.transpose(1, 0, 2))):
        real, keep, area = _plane(other)
        needle = ~real
        for k in range(3):
            p, q = one[:, k], one[:, (k + 1) % 3]
            p_side, q_side = side[k], side[(k + 1) % 3]
            flat = real & (p_side == 0) & (q_side == 0)
            through = ~((turns[k] > 0).any(axis=0) & (turns[k] < 0).any(axis=0))
            found |= real & ~flat & (p_side * q_side <= 0) & through
            if flat.any():
                found[flat] |= _flat_meets(p[flat], q[flat], other[flat], keep[flat], area[flat])
            # A triangle with no area has only edges to meet (review round 11: two such, crossing, went untested).
            if needle.any():
                for j in range(3):
                    found[needle] |= _segments_meet(p[needle], q[needle], other[needle, j], other[needle, (j + 1) % 3])
    hit[live] = found
    return hit


def _segments_meet(p, q, u, v):
    """Whether each segment p-q (n, 3) meets u-v, exactly: they lie in one plane, and their shadows on the three
    coordinate planes meet in each (at least one of those shadows is the plane seen without distortion, where the
    shadows meet just where the segments do)."""
    meets = _orient3d(p, q, u, v) == 0
    for keep in ([1, 2], [0, 2], [0, 1]):
        P, Q, U, V = p[:, keep], q[:, keep], u[:, keep], v[:, keep]
        d1, d2, d3, d4 = _orient2d(U, V, P), _orient2d(U, V, Q), _orient2d(P, Q, U), _orient2d(P, Q, V)
        collinear = (d1 == 0) & (d2 == 0) & (d3 == 0) & (d4 == 0)
        meets &= np.where(collinear, _overlap(P, Q, U, V), (d1 * d2 <= 0) & (d3 * d4 <= 0))
    return meets


def _plane(triangles):
    """Each triangle seen in 2D: whether it has any area (its exact area on some coordinate plane is not 0, else it is a
    segment), the two axes it is seen on (as columns to keep: those its normal is least along, unless its area there is
    exactly 0, then another coordinate plane where it is not) and its area's sign there."""
    views = np.array([[1, 2], [0, 2], [0, 1]])
    signs = np.stack([_orient2d(*(triangles[:, k][:, keep] for k in range(3))) for keep in views])
    drop = np.argmax(np.abs(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])), axis=1)
    rows = np.arange(len(triangles))
    lost = signs[drop, rows] == 0
    drop[lost] = np.argmax(signs[:, lost] != 0, axis=0)
    return (signs != 0).any(axis=0), views[drop], signs[drop, rows]


def _flat_meets(p, q, triangles, keep, area):
    """Whether each segment p-q (n, 3), in its triangle's plane, meets the triangle, in 2D on that plane (keep: its
    columns; area: the sign of its area there): an end in it, or the segment across one of its edges, or along one where
    their spans overlap."""
    def two(w):
        return np.take_along_axis(w, keep, axis=1)
    P, Q = two(p), two(q)
    A, B, C = two(triangles[:, 0]), two(triangles[:, 1]), two(triangles[:, 2])

    def within(w):
        return (np.stack([_orient2d(A, B, w), _orient2d(B, C, w), _orient2d(C, A, w)]) * area >= 0).all(axis=0)

    meets = within(P) | within(Q)
    for u, v in ((A, B), (B, C), (C, A)):
        d1, d2, d3, d4 = _orient2d(u, v, P), _orient2d(u, v, Q), _orient2d(P, Q, u), _orient2d(P, Q, v)
        collinear = (d1 == 0) & (d2 == 0) & (d3 == 0) & (d4 == 0)
        meets |= np.where(collinear, _overlap(P, Q, u, v), (d1 * d2 <= 0) & (d3 * d4 <= 0))
    return meets


def _overlap(s0, s1, t0, t1):
    """Whether collinear segments s0-s1 and t0-t1 (n, 2) share a point: their spans overlap along both axes (along one
    alone, a segment across it would hide a gap along the other, review round 10)."""
    lo = np.maximum(np.minimum(s0, s1), np.minimum(t0, t1))
    hi = np.minimum(np.maximum(s0, s1), np.maximum(t0, t1))
    return (lo <= hi).all(axis=1)


def _smoothed(vertices, faces, rounds, cell):
    """The mesh Taubin-smoothed (_taubin) where that leaves it uncrossed: smoothing can fold two sheets that come a hair
    apart (in a neck, where the grid barely parts them) through each other. Each crossing face's vertices and two rings
    of their neighbours keep their marched places, and the faces round those are checked again (only they can cross
    anew), up to 4 times; then, if anything still crosses, the mesh as marched, which never crosses itself (a level
    set's faces each lie in a tetrahedron of their own). Before that, a part whose volume smoothing moves by more than
    SHRINK keeps its marched shape: a small part is all grid-sized curves, which smoothing irons away (eight blobs of a
    coarse lattice lost 87 % of their volume)."""
    faces = np.asarray(faces, dtype=np.int64)
    smooth = _taubin(vertices, faces, rounds)
    part = np.unique(_parts(len(vertices), faces)[faces[:, 0]], return_inverse=True)[1].ravel()

    def volumes(v):
        t = v[faces]
        return np.bincount(part, weights=np.einsum('ij,ij->i', t[:, 0], np.cross(t[:, 1], t[:, 2])) / 6.0)

    before, after = volumes(vertices), volumes(smooth)
    shrunk = (np.abs(after - before) > SHRINK * np.abs(before))[part]
    smooth[faces[shrunk].ravel()] = vertices[faces[shrunk].ravel()]
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    crossing = _crossing_faces(smooth, faces, cell)
    for _ in range(4):
        if not crossing.any():
            return smooth
        keep = np.zeros(len(vertices), dtype=bool)
        keep[faces[crossing].ravel()] = True
        for _ring in range(2):
            keep[edges[keep[edges[:, 0]], 1]] = True
            keep[edges[keep[edges[:, 1]], 0]] = True
        smooth[keep] = vertices[keep]
        crossing = _crossing_faces(smooth, faces, cell, keep[faces].any(axis=1))
    return smooth if not crossing.any() else vertices


def _parts(vertex_count, faces):
    """Each vertex's part (connected through the faces) as the smallest vertex index in it: labels spread along the
    edges, and every round a vertex takes its label's own label, so far fewer rounds than the mesh is long are needed."""
    left, right = np.concatenate([faces[:, 0], faces[:, 1]]), np.concatenate([faces[:, 1], faces[:, 2]])
    label = np.arange(vertex_count)
    while True:
        low = np.minimum(label[left], label[right])
        nxt = label.copy()
        np.minimum.at(nxt, left, low)
        np.minimum.at(nxt, right, low)
        nxt = nxt[nxt[nxt]]
        if np.array_equal(nxt, label):
            return label
        label = nxt


def sheet(kind='gyroid', size=(2.0, 2.0, 2.0), cells=(2, 2, 2), thickness=0.1, resolution=64, shape='box', inner=0.0,
          wrap=False, min_part=0.02, smooth=12):
    """A sheet lattice as one closed solid, for jewellery and 3D printing: every point within thickness / 2 metres of the
    TPMS surface {f = 0} (that distance measured on the grid, _surface_distance, so the wall is `thickness` thick
    everywhere, to a small part of a grid cell), inside `shape`: 'box', 'sphere', 'cylinder' (shape_distance) or
    'ring', a ring's band: the upright tube of outer diameter min(sx, sy), inner diameter `inner` and height sz round
    the z axis. wrap=True (a ring only) lays
    the lattice round the band rather than in the box's axes: cells[0] periods round it (a whole number, so that it
    closes), cells[1] across its wall and cells[2] up it. resolution = grid cells along the longest side (8 to MAX_GRID);
    the grid must have GRID_PER_PERIOD cells across the smallest period (twice as many for the kinds in HARMONICS) and
    GRID_PER_WALL across the wall. Edges where the lattice meets the shape are rounded (by 3 grid cells, at most the
    wall's thickness), and `smooth` rounds of Taubin smoothing iron out the grid's facets, which polished metal shows in
    every reflection; where they would fold two sheets a hair apart through each other, those vertices keep their
    marched places (_smoothed), so the mesh never crosses itself. Closed parts with fewer than min_part of the largest part's
    triangles (crumbs a cut can leave) are left out; a cavity's wall stays. A shape the surface does not cross raises
    ValueError rather than give an empty mesh. kind as tpms(). One welded, watertight, manifold mesh, faces outward: no
    Solidify needed. A fine ring has about a million triangles: render it as it is, and decimate a copy (Blender's
    Decimate modifier, ratio about 0.05) for a GLB of at most 2 MiB.
    A size 7 ring, a fine woven lattice (17.3 mm inside, a 2.6 mm wall, 7.5 mm wide, 0.45 mm walls, 18 cells round, 2
    across the wall, 3 up): sheet('gyroid', size=(0.0225, 0.0225, 0.0075), cells=(18, 2, 3), thickness=0.00045,
    resolution=160, shape='ring', inner=0.0173, wrap=True). One cell across a band, cut by both its surfaces, reads as a
    crumpled sheet rather than a lattice. Under about 0.4 mm a cast wall may not fill."""
    if kind not in TPMS:
        raise ValueError(f'unknown TPMS kind {kind!r}; one of {sorted(TPMS)}')
    if shape not in SHEET_SHAPES:
        raise ValueError(f'unknown shape {shape!r}; one of {SHEET_SHAPES}')
    size, cells = _triple(size, 'size'), _triple(cells, 'cells')
    for c in cells:
        check_count('cells', c, MAX_PERIODS)
        if c < MIN_CELLS:
            raise ValueError(f'cells must be at least {MIN_CELLS} along every axis: fewer leave no lattice in the box')
    if not isinstance(resolution, int) or resolution < 8:
        raise ValueError('resolution must be an integer >= 8')
    check_count('resolution', resolution, MAX_GRID)
    thickness, inner, min_part = float(thickness), float(inner), float(min_part)
    if not (math.isfinite(thickness) and thickness > 0):
        raise ValueError('thickness must be a positive number of metres')
    if shape == 'ring':
        if not (math.isfinite(inner) and 0 < inner < min(size[0], size[1])):
            raise ValueError("a ring needs its inner diameter: 0 < inner < min(size[0], size[1])")
    elif inner != 0:
        raise ValueError("inner is a ring's inner diameter: only shape='ring' takes it")
    if wrap and shape != 'ring':
        raise ValueError("wrap lays the lattice round a ring's band: use shape='ring'")
    if wrap and cells[0] != round(cells[0]):
        raise ValueError('wrap needs a whole number of cells[0] round the ring')
    if not 0 <= min_part <= 1:
        raise ValueError('min_part must be between 0 and 1')
    if not isinstance(smooth, int) or not 0 <= smooth <= MAX_SMOOTH:
        raise ValueError(f'smooth must be an integer 0-{MAX_SMOOTH} (rounds of smoothing)')
    if min(size) < MIN_SHEET_SIZE:
        raise ValueError(f'size must be at least {MIN_SHEET_SIZE} m along every axis (it is in metres)')
    spacing, counts = _sheet_spacing(size, resolution)
    step = float(spacing.max())
    outer = min(size[0], size[1]) / 2.0
    period = min((math.pi * inner / cells[0], (outer - inner / 2.0) / cells[1], size[2] / cells[2]) if wrap
                 else (s / c for s, c in zip(size, cells)))
    harmonic = HARMONICS.get(kind, 1)
    if period < GRID_PER_PERIOD * harmonic * step:
        raise ValueError(f'the grid ({step:.3g} m) is too coarse for a period of {period:.3g} m: raise the resolution or '
                         f'lower the cells (it needs {GRID_PER_PERIOD * harmonic} grid cells a period'
                         + (f'; {kind} has waves at twice its period' if harmonic > 1 else '') + ')')
    if thickness < GRID_PER_WALL * step:
        raise ValueError(f'a wall of {thickness:.3g} m needs a grid of at most {thickness / GRID_PER_WALL:.3g} m '
                         f'(it is {step:.3g} m): raise the resolution or thicken the wall')
    # A wall of half a period or more fills the lattice: a solid, not a sheet.
    if thickness >= period / 2.0:
        raise ValueError(f'a wall of {thickness:.3g} m fills a lattice whose period is {period:.3g} m: keep it under half a period')
    # The shape at its thinnest (a ring's band across its wall or its height) must hold a wall and a few grid cells.
    extent = {'box': min(size), 'sphere': min(size), 'cylinder': min(2.0 * outer, size[2]),
              'ring': min(outer - inner / 2.0, size[2])}[shape]
    if extent < max(4.0 * step, thickness):
        raise ValueError(f'the {shape} is {extent:.3g} m at its thinnest: it needs at least 4 grid cells ({4.0 * step:.3g} m) '
                         f'and one wall ({thickness:.3g} m)')
    reach = _wall_reach(spacing, thickness)
    # A wrapped field turns round the ring's axis, where it has no value (every angle meets there) and its gradient no
    # bound, so a point there can pass for one of the surface: the band must lie farther from the axis than the distance
    # is measured, a grid cell more.
    if wrap and inner / 2.0 <= reach + step:
        raise ValueError(f'a wrapped ring needs a hole wider than its walls reach: an inner diameter over '
                         f'{2.0 * (reach + step):.3g} m (it is {inner:.3g} m), or thinner walls or a finer grid')
    # The work, counted before any of it: the grid with its pad (_sheet_grid) and the jump flood's rounds over it; then,
    # once the field is known on the grid (one evaluation), its seeds' (_surface_distance).
    nodes = int(np.prod([c + 2 * (1 + math.ceil(reach / s)) + 1 for c, s in zip(counts, spacing)]))
    work = nodes * len(NEIGHBOURS) * (len(_distance_strides(int(math.ceil(reach / float(spacing.min()))))) + 1)

    def check(work):
        if nodes > MAX_SHEET_NODES or work > MAX_SHEET_WORK:
            raise ValueError(f'a sheet this fine with walls this thick needs a grid of {nodes:,} points ({work:,} steps of work), '
                             f'beyond {MAX_SHEET_NODES:,} ({MAX_SHEET_WORK:,}): lower the resolution, the cells or the walls')
    check(work)
    origin, spacing, axes = _sheet_grid(size, resolution, reach)
    gx, gy, gz = np.meshgrid(*axes, indexing='ij')
    field = _sheet_field(kind, size, cells, inner, wrap)
    wall = _sheet_wall(field, gx, gy, gz, spacing, thickness, field(gx, gy, gz), lambda seeds: check(work + seeds))
    points = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    # Its edges are rounded by 3 grid cells (never more than the wall is thick, which ends a wall in a round nose, as a
    # cast and polished piece's, nor a quarter of the shape at its thinnest): sharper ones come out saw-toothed.
    k = min(3.0 * step, thickness, extent / 4.0)
    bound = _sheet_bound(shape, points, size, inner, k).reshape(gx.shape)
    vertices, faces = _march.marching_tetrahedra(_smooth_max(wall, bound, k), origin, spacing, 0.0, max_triangles=MAX_TRIANGLES)
    if not len(faces):
        raise ValueError(f'no lattice lies inside the {shape}: the surface does not cross it with these cells and size')
    if min_part > 0:
        faces = _closed_parts(vertices, faces, min_part)
        used = np.unique(faces)
        index = np.full(len(vertices), -1, dtype=np.int64)
        index[used] = np.arange(len(used))
        vertices, faces = vertices[used], index[faces]
    if len(faces) and smooth:
        vertices = _smoothed(vertices, faces, smooth, float(spacing.min()))
    return ensure_finite(Mesh([tuple(v) for v in vertices.tolist()], [tuple(f) for f in faces.tolist()]))


def _enneper(r, t):
    return (r * np.cos(t) - r ** 3 / 3.0 * np.cos(3 * t), -r * np.sin(t) - r ** 3 / 3.0 * np.sin(3 * t),
            r ** 2 * np.cos(2 * t))


def _catenoid(v, u):
    return np.cosh(v) * np.cos(u), np.cosh(v) * np.sin(u), v


def _helicoid(v, u):
    return v * np.cos(u), v * np.sin(u), 0.25 * u


SCHERK_EDGE = 1.5  # |x|, |y| <= 1.5 < pi/2 keeps |z| <= ln(1/cos 1.5) = 2.65


def _scherk(s, t):
    # Samples bunch towards the square's edges, where z climbs fastest.
    x, y = SCHERK_EDGE * np.sin(0.5 * np.pi * s), SCHERK_EDGE * np.sin(0.5 * np.pi * t)
    return x, y, np.log(np.cos(y)) - np.log(np.cos(x))


def _henneberg(u, v):
    return (2 * np.sinh(u) * np.cos(v) - 2.0 / 3.0 * np.sinh(3 * u) * np.cos(3 * v),
            2 * np.sinh(u) * np.sin(v) + 2.0 / 3.0 * np.sinh(3 * u) * np.sin(3 * v),
            2 * np.cosh(2 * u) * np.cos(2 * v))


def _catalan(u, v):
    return u - np.sin(u) * np.cosh(v), 1 - np.cos(u) * np.cosh(v), 4 * np.sin(u / 2) * np.sinh(v / 2)


def _richmond(r, t):
    # Weierstrass data f = 1/z^2, g = z^2.
    return (-np.cos(t) / (2 * r) - r ** 3 * np.cos(3 * t) / 6.0, -np.sin(t) / (2 * r) - r ** 3 * np.sin(3 * t) / 6.0,
            r * np.cos(t))


def _bour(r, t):
    return (r * np.cos(t) - 0.5 * r ** 2 * np.cos(2 * t), -r * np.sin(t) - 0.5 * r ** 2 * np.sin(2 * t),
            4.0 / 3.0 * r ** 1.5 * np.cos(1.5 * t))


Surface = namedtuple('Surface', 'fn u v wrap_v pole_u0 note')
TAU = 2.0 * math.pi
# The standard (u, v) domains; v wraps (shared seam vertices) where the surface closes around, and a pole row that
# collapses to one point becomes a single vertex with triangles around it.
PARAMETRIC = {
    'enneper': Surface(_enneper, (0.0, 1.3), (0.0, TAU), True, True, 'r in [0, 1.3], theta around: embedded below r = 1.73'),
    'catenoid': Surface(_catenoid, (-1.0, 1.0), (0.0, TAU), True, False, 'x = cosh v cos u: the soap film between two rings'),
    'helicoid': Surface(_helicoid, (-1.0, 1.0), (0.0, 2 * TAU), False, False, 'radius v in [-1, 1], two turns, pitch pi / 2'),
    'scherk': Surface(_scherk, (-1.0, 1.0), (-1.0, 1.0), False, False, "Scherk's first surface z = ln(cos y / cos x), |x|, |y| <= 1.5"),
    'henneberg': Surface(_henneberg, (0.1, 1.0), (0.0, TAU), True, False, 'u in [0.1, 1], v around (non-orientable, self-crossing)'),
    'catalan': Surface(_catalan, (0.0, 2 * TAU), (-1.2, 1.2), False, False, 'u along two arches of the cycloid it contains'),
    'richmond': Surface(_richmond, (0.35, 1.2), (0.0, TAU), True, False, 'r in [0.35, 1.2], theta around (planar end at r -> 0)'),
    'bour': Surface(_bour, (0.0, 1.0), (0.0, 2 * TAU), True, True, 'r in [0, 1], theta in [0, 4 pi) (self-crossing)'),
}


def parametric(kind, resolution=(64, 64)):
    """A classical parametric minimal surface as quads on its standard (u, v) domain (PARAMETRIC[kind].note):
    enneper, catenoid, helicoid, scherk, henneberg, catalan, richmond, bour. resolution = quads along (u, v)."""
    if kind not in PARAMETRIC:
        raise ValueError(f'unknown parametric surface {kind!r}; one of {sorted(PARAMETRIC)}')
    nu, nv = (resolution, resolution) if isinstance(resolution, int) else resolution
    if not (isinstance(nu, int) and isinstance(nv, int)) or nu < 2 or nv < 3:
        raise ValueError('resolution must be integers (nu >= 2, nv >= 3)')
    check_count('resolution', max(nu, nv), MAX_PARAMETRIC)
    check_count('quads', nu * nv, MAX_PARAMETRIC_QUADS)
    s = PARAMETRIC[kind]
    us = np.linspace(s.u[0], s.u[1], nu + 1)
    vs = np.linspace(s.v[0], s.v[1], nv + 1)[:nv if s.wrap_v else nv + 1]
    m = len(vs)
    uu, vv = np.meshgrid(us, vs, indexing='ij')
    points = np.stack(s.fn(uu, vv), axis=-1)
    index = np.arange((nu + 1) * m).reshape(nu + 1, m)
    j = np.arange(nv)
    jn = (j + 1) % m
    quads = np.stack([index[:-1][:, j], index[1:][:, j], index[1:][:, jn], index[:-1][:, jn]], axis=-1)
    if not s.pole_u0:
        return ensure_finite(Mesh([tuple(p) for p in points.reshape(-1, 3).tolist()],
                                  [tuple(q) for q in quads.reshape(-1, 4).tolist()]))
    # Row 0 is one point: keep its first vertex, shift the rest down, and fan the first band as triangles.
    flat = np.concatenate([points[0, :1], points[1:].reshape(-1, 3)])
    remap = np.concatenate([np.zeros(m, np.int64), np.arange(1, nu * m + 1)])
    tris = remap[quads[0][:, [0, 1, 2]]]
    rest = remap[quads[1:].reshape(-1, 4)]
    faces = [tuple(t) for t in tris.tolist()] + [tuple(q) for q in rest.tolist()]
    return ensure_finite(Mesh([tuple(p) for p in flat.tolist()], faces))
