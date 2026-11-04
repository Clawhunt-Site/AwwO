"""Voronoi skins and perforation (after 泰森多边形褶皱, 无缝拼接voronoi, 泰森镂空): 2D Voronoi cells clipped to a
rectangle, Lloyd-relaxed random sites, a perforated panel of cell frames, and wrap() to bend a flat panel onto a
cylinder, a sphere or any surface (vases, lamps, towers)."""
import math
import random

import numpy as np

from . import _poly
from .geometry import Curves, Mesh, check_count, check_extent, ensure_finite

MAX_SITES = 3000
MAX_RELAX = 50
MAX_WRAP_POINTS = 1_000_000


def _rect(bounds):
    if len(bounds) == 2:
        (x0, y0), (x1, y1) = bounds
    else:
        x0, y0, x1, y1 = bounds
    x0, y0, x1, y1 = (float(v) for v in (x0, y0, x1, y1))
    if not (x1 > x0 and y1 > y0) or not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
        raise ValueError('bounds must be (xmin, ymin, xmax, ymax) with xmax > xmin and ymax > ymin')
    return x0, y0, x1, y1


def voronoi_cells(points2d, bounds, periodic=False):
    """The Voronoi cell of every site, clipped to bounds = (xmin, ymin, xmax, ymax), as convex counter-clockwise
    polygons [(x, y), ...] in the sites' order. Each cell starts as the rectangle and is cut by the bisector with every
    other site, nearest first, until the next site is too far to cut it. periodic=True repeats the sites at +-width in
    x (a seamless strip for wrap()): cells then cross the left and right edges instead of being cut there."""
    x0, y0, x1, y1 = _rect(bounds)
    pts = [(float(p[0]), float(p[1])) for p in points2d]
    check_count('points', len(pts), MAX_SITES)
    if not pts:
        return []
    for x, y in pts:
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            raise ValueError(f'site ({x}, {y}) lies outside the bounds')
    w = x1 - x0
    sites = np.array(pts)
    candidates = np.concatenate([sites, sites + [w, 0.0], sites - [w, 0.0]]) if periodic else sites
    others = candidates.tolist()
    start = [(x0 - w, y0), (x1 + w, y0), (x1 + w, y1), (x0 - w, y1)] if periodic else [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    cells = []
    for i, (px, py) in enumerate(pts):
        d2 = ((candidates - sites[i]) ** 2).sum(axis=1)
        order = np.argsort(d2, kind='stable').tolist()
        d2 = d2.tolist()
        poly = start
        reach = max((vx - px) ** 2 + (vy - py) ** 2 for vx, vy in poly)
        for j in order:
            if j == i:
                continue
            if d2[j] == 0.0:
                raise ValueError(f'sites {i} and {j % len(pts)} coincide')
            if d2[j] > 4.0 * reach:
                break
            qx, qy = others[j]
            # Keep the side nearer p: (p - q) . v >= (|p|^2 - |q|^2) / 2.
            poly = _poly.clip(poly, px - qx, py - qy, 0.5 * (px * px + py * py - qx * qx - qy * qy))
            reach = max((vx - px) ** 2 + (vy - py) ** 2 for vx, vy in poly)
        cells.append(poly)
    return cells


def random_points(n, bounds, seed=0, relax=0, periodic=False):
    """n uniform random sites in bounds, then `relax` Lloyd iterations (each site moves to its cell's centroid),
    which evens out the cells. Deterministic for a seed."""
    x0, y0, x1, y1 = _rect(bounds)
    check_count('n', n, MAX_SITES)
    check_count('relax', relax, MAX_RELAX)
    rng = random.Random(seed)
    pts = [(x0 + rng.random() * (x1 - x0), y0 + rng.random() * (y1 - y0)) for _ in range(int(n))]
    for _ in range(int(relax)):
        cells = voronoi_cells(pts, (x0, y0, x1, y1), periodic)
        pts = [_poly.centroid(c) for c in cells]
        if periodic:
            pts = [(x0 + (x - x0) % (x1 - x0), y) for x, y in pts]
    return pts


def perforated_panel(width=4.0, height=3.0, cells=60, frame=0.06, seed=0, relax=2, periodic=False, sites=None):
    """A flat panel (z = 0, x in [0, width], y in [0, height]) made of the frames of Voronoi cells: each cell becomes
    the ring between it and its inset by frame / 2 (bars between holes are `frame` wide, and so is the outer rim). A
    cell too small to inset stays solid. sites = your own points instead of `cells` random relaxed ones. With
    periodic=True the left and right edges match (wrap it with size=(width, height)). Faces face +z."""
    if not (width > 0 and height > 0):
        raise ValueError('width and height must be positive')
    check_extent('width', width)
    check_extent('height', height)
    if not 0 < frame < min(width, height) / 2:
        raise ValueError('frame must be positive and under half the panel')
    bounds = (0.0, 0.0, float(width), float(height))
    if sites is None:
        sites = random_points(cells, bounds, seed, relax, periodic)
    polygons = voronoi_cells(sites, bounds, periodic)
    eps = 1e-9 * max(width, height)
    lines = [(1, 0.0), (1, float(height))] + ([] if periodic else [(0, 0.0), (0, float(width))])

    def on_border(p, q):
        return any(abs(p[a] - v) <= eps and abs(q[a] - v) <= eps for a, v in lines)

    vertices, faces, _holes = _poly.frame_panel(polygons, float(frame), on_border, max(width, height))
    return ensure_finite(Mesh(vertices, faces))


def _surface_point(surface, u, v, offset, radius, height, lat_range):
    if surface == 'cylinder':
        a = 2.0 * math.pi * u
        r = radius + offset
        return r * math.cos(a), r * math.sin(a), v * height
    if surface == 'sphere':
        lon = 2.0 * math.pi * u
        lat = math.radians(lat_range[0] + (lat_range[1] - lat_range[0]) * v)
        r = radius + offset
        return r * math.cos(lat) * math.cos(lon), r * math.cos(lat) * math.sin(lon), r * math.sin(lat)
    p = surface(u, v)
    if offset == 0.0:
        return tuple(float(c) for c in p)
    h = 1e-5
    pu = [(a - b) / (2 * h) for a, b in zip(surface(u + h, v), surface(u - h, v))]
    pv = [(a - b) / (2 * h) for a, b in zip(surface(u, v + h), surface(u, v - h))]
    n = (pu[1] * pv[2] - pu[2] * pv[1], pu[2] * pv[0] - pu[0] * pv[2], pu[0] * pv[1] - pu[1] * pv[0])
    length = math.sqrt(sum(c * c for c in n)) or 1.0
    return tuple(float(c) + offset * nc / length for c, nc in zip(p, n))


def wrap(geometry, surface='cylinder', radius=1.0, height=None, size=None, lat_range=(-80.0, 80.0), weld=False):
    """Bends a flat Mesh or Curves whose (x, y) span [0, w] x [0, h] onto a surface, with u = x / w and v = y / h;
    a point's z becomes an offset along the surface's normal. size = (w, h), by default the geometry's largest x and y.
    surface: 'cylinder' (radius; height, by default h; u goes round), 'sphere' (radius; v spans lat_range degrees;
    u goes round) or a callable (u, v) -> (x, y, z). Faces facing +z end up facing outward (along d/du x d/dv).
    weld=True merges vertices that meet after bending (the seam of a periodic panel). Faces stay flat between their
    mapped corners: use more cells for a smoother wrap."""
    if not (surface in ('cylinder', 'sphere') or callable(surface)):
        raise ValueError("surface must be 'cylinder', 'sphere' or a callable (u, v) -> (x, y, z)")
    points = geometry.vertices if isinstance(geometry, Mesh) else [p for line in geometry.polylines for p in line]
    check_count('points', len(points), MAX_WRAP_POINTS)
    if size is None:
        size = (max((p[0] for p in points), default=1.0), max((p[1] for p in points), default=1.0))
    w, h = float(size[0]), float(size[1])
    if not (w > 0 and h > 0 and radius > 0):
        raise ValueError('size and radius must be positive')
    tall = h if height is None else float(height)

    def bend(p):
        z = p[2] if len(p) > 2 else 0.0
        return _surface_point(surface, p[0] / w, p[1] / h, z, float(radius), tall, lat_range)

    if isinstance(geometry, Curves):
        return ensure_finite(Curves([[bend(p) for p in line] for line in geometry.polylines], list(geometry.closed)))
    vertices = [bend(p) for p in geometry.vertices]
    faces = list(geometry.faces)
    if weld:
        lo, hi = np.min(vertices, axis=0), np.max(vertices, axis=0)
        welder = _poly.Welder(1e-9 * max(float(np.max(hi - lo)), 1e-12))
        index = [welder.add(p) for p in vertices]
        faces = [tuple(c) for c in (_poly.dedupe_cycle([index[i] for i in f]) for f in faces) if len(c) >= 3]
        vertices = welder.points
    return ensure_finite(Mesh(vertices, faces))
