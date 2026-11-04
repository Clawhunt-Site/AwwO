"""Minimal surfaces (after the owner's 各种极小曲面的公式 and 极小曲面首饰): triply periodic minimal surfaces as implicit
functions meshed by marching tetrahedra and clipped to a box, sphere or cylinder, and the classical parametric
minimal surfaces. Thicken the result with awwo_param.blender.solidify (Blender's Solidify modifier)."""
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
