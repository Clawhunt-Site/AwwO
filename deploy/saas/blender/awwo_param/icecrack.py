"""Ice-crack tessellation (冰裂纹, after 冰裂纹理 and 冰裂立方体): the Chinese window lattice whose panes look like
cracked ice. The rectangle is split again and again, always the largest cell, by a chord between random points on two
of its sides; chords that would make an angle under min_angle_deg, a short edge or a small piece are refused.

A chord's ends are also added to the neighbouring cells' edges, so the cells meet vertex to vertex (a neighbour shows
a straight 180-degree vertex where a crack ends on its side) and the lattice welds into one closed solid."""
import heapq
import math
import random

from . import _poly
from .geometry import Mesh, check_count, check_extent, ensure_finite, extrude_flat

MAX_CELLS = 2000
RETRIES = 60
MIN_PIECE = 0.2     # each piece keeps at least this share of the cell it came from
MIN_EDGE = 0.15     # shortest new edge, as a share of the mean cell's side sqrt(width * height / cells)
MIN_ROUND = 0.4     # 4 pi area / perimeter^2 of each piece (a square 0.79, a 1:4 strip 0.50): no long slivers


def _roundness(poly):
    perimeter = sum(math.dist(a, b) for a, b in zip(poly, poly[1:] + poly[:1]))
    return 4.0 * math.pi * abs(_poly.area(poly)) / (perimeter * perimeter)


def _angle(ux, uy, vx, vy):
    return math.degrees(math.atan2(abs(ux * vy - uy * vx), ux * vx + uy * vy))


def _pick_on_side(coords, ids, side, rng, min_edge):
    """A random point on a side (a run of edges between two corners), as (edge position k, point), keeping min_edge
    from the vertices around it; None when the draw lands too close."""
    run = side
    lengths = [math.dist(coords[ids[k]], coords[ids[(k + 1) % len(ids)]]) for k in run]
    total = sum(lengths)
    s = rng.uniform(0.0, total)
    for k, length in zip(run, lengths):
        if s <= length or k == run[-1]:
            a, b = coords[ids[k]], coords[ids[(k + 1) % len(ids)]]
            t = min(max(s / length, 0.0), 1.0) if length else 0.0
            if s < min_edge or length - s < min_edge:
                return None
            return k, (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        s -= length
    return None


def _try_split(coords, ids, rng, min_angle, min_edge):
    """Two pieces (as id lists, with -1 and -2 standing for the new points) and the two new points with the edges they
    land on, or None when RETRIES draws were all refused."""
    corners = _poly.corners([coords[i] for i in ids])
    n = len(ids)
    sides = [[k % n for k in range(c, (corners[(i + 1) % len(corners)] - c) % n + c)] for i, c in enumerate(corners)]
    whole = abs(_poly.area([coords[i] for i in ids]))
    for _ in range(RETRIES):
        s1, s2 = sorted(rng.sample(range(len(sides)), 2))
        first = _pick_on_side(coords, ids, sides[s1], rng, min_edge)
        second = _pick_on_side(coords, ids, sides[s2], rng, min_edge)
        if first is None or second is None:
            continue
        (k1, p), (k2, q) = first, second
        if math.dist(p, q) < min_edge:
            continue
        ok = True
        for k, a_pt, b_pt in ((k1, p, q), (k2, q, p)):
            ex, ey = (coords[ids[(k + 1) % n]][0] - coords[ids[k]][0], coords[ids[(k + 1) % n]][1] - coords[ids[k]][1])
            angle = _angle(ex, ey, b_pt[0] - a_pt[0], b_pt[1] - a_pt[1])
            ok &= min_angle <= angle <= 180.0 - min_angle
        if not ok:
            continue
        # Walk the cell from after p round to q, and from after q round to p.
        one = [-1] + [ids[(k1 + 1 + s) % n] for s in range((k2 - k1) % n)] + [-2]
        two = [-2] + [ids[(k2 + 1 + s) % n] for s in range((k1 - k2) % n)] + [-1]
        points = {-1: p, -2: q}
        shapes = [[points[i] if i < 0 else coords[i] for i in piece] for piece in (one, two)]
        if min(abs(_poly.area(s)) for s in shapes) < MIN_PIECE * whole or min(map(_roundness, shapes)) < MIN_ROUND:
            continue
        return one, two, ((ids[k1], ids[(k1 + 1) % n], p), (ids[k2], ids[(k2 + 1) % n], q))
    return None


def _subdivide(width, height, cells, seed, min_angle):
    if not (width > 0 and height > 0):
        raise ValueError('width and height must be positive')
    check_extent('width', width)
    check_extent('height', height)
    if not (isinstance(cells, int) and cells >= 1):
        raise ValueError('cells must be a positive integer')
    check_count('cells', cells, MAX_CELLS)
    if not 0.0 < min_angle < 60.0:
        raise ValueError('min_angle_deg must be in (0, 60)')
    rng = random.Random(seed)
    coords = [(0.0, 0.0), (float(width), 0.0), (float(width), float(height)), (0.0, float(height))]
    polys = {0: [0, 1, 2, 3]}
    owner = {(0, 1): 0, (1, 2): 0, (2, 3): 0, (3, 0): 0}
    heap = [(-width * height, 0)]
    next_id = 1
    min_edge = MIN_EDGE * math.sqrt(width * height / cells)
    while len(polys) < cells and heap:
        _neg, cid = heapq.heappop(heap)
        ids = polys[cid]
        found = _try_split(coords, ids, rng, min_angle, min_edge)
        if found is None:
            continue  # this cell stays whole; split the next largest
        one, two, landings = found
        for a, b in zip(ids, ids[1:] + ids[:1]):
            owner.pop((a, b), None)
        new = {}
        for marker, (a, b, point) in zip((-1, -2), landings):
            new[marker] = len(coords)
            coords.append(point)
            # The cell across edge a -> b gets the point too, between b and a.
            other = owner.pop((b, a), None)
            if other is not None:
                ring = polys[other]
                at = ring.index(b)
                ring.insert(at + 1, new[marker])
                owner[(b, new[marker])] = other
                owner[(new[marker], a)] = other
        del polys[cid]
        for piece in (one, two):
            piece = [new[i] if i < 0 else i for i in piece]
            polys[next_id] = piece
            for a, b in zip(piece, piece[1:] + piece[:1]):
                owner[(a, b)] = next_id
            heapq.heappush(heap, (-abs(_poly.area([coords[i] for i in piece])), next_id))
            next_id += 1
    return coords, [polys[k] for k in sorted(polys)]


def ice_crack(width=2.0, height=2.0, cells=40, seed=0, min_angle_deg=20.0):
    """Up to `cells` convex counter-clockwise cells [(x, y), ...] tiling [0, width] x [0, height] (fewer only when no
    cell can be split within the limits). No corner angle is under min_angle_deg; straight 180-degree vertices mark
    where a crack ends on the cell's side. Deterministic for a seed."""
    coords, cells_ = _subdivide(width, height, cells, seed, float(min_angle_deg))
    return [[coords[i] for i in ids] for ids in cells_]


def ice_crack_lattice(width=2.0, height=2.0, cells=40, bar=0.03, depth=0.04, seed=0, min_angle_deg=20.0):
    """The ice-crack cells' frames as a window lattice: bars `bar` wide between panes (and round the rim), extruded
    from z = 0 to z = depth as one closed, welded solid. A pane too small to open stays solid."""
    if not 0 < bar < min(width, height) / 2 or not depth > 0:
        raise ValueError('bar must be positive and under half the panel; depth positive')
    polygons = ice_crack(width, height, cells, seed, min_angle_deg)
    eps = 1e-9 * max(width, height)
    lines = [(0, 0.0), (0, float(width)), (1, 0.0), (1, float(height))]

    def on_border(p, q):
        return any(abs(p[a] - v) <= eps and abs(q[a] - v) <= eps for a, v in lines)

    vertices, faces, _holes = _poly.frame_panel(polygons, float(bar), on_border, max(width, height))
    return ensure_finite(extrude_flat(Mesh(vertices, faces), float(depth)))
