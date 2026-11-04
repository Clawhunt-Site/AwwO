"""Reciprocal frames (互承结构) and timber trusses (交叉木桁架). In a reciprocal grid no beams meet at a point: each
tiling edge is turned about its midpoint, so round every vertex the beams form a small rotated polygon (a fan), each
beam resting on the next one clockwise and carrying the one before it.

For a vertex where d beams meet, beams of length L turned by alpha pass at (L / 2) sin(alpha) from the vertex and
their fan is a d-gon with sides L sin(alpha) tan(pi / d): that side is the engagement (how far along its neighbour a
beam lands from the neighbour's end), which fixes alpha."""
import math
from collections import defaultdict, namedtuple

from .geometry import beam, check_count, ensure_finite, merged

PATTERNS = {'quad': 4, 'hex': 3, 'tri': 6}
MAX_BEAMS = 20_000
MAX_SIZE = 60

Frame = namedtuple('Frame', 'vertices edges segments rests_on alpha_deg')


def _tiling(pattern, size, edge):
    """(vertices [(x, y)], edges [(i, j)]) of a tiling centred on the origin: 'quad' size x size squares (or
    (nx, ny)), 'hex' hexagons in `size` rings round a central one, 'tri' triangles filling a hexagon `size` edges out.
    Vertices are found by integer lattice keys, never by comparing floats."""
    keys, edges = {}, set()

    def vid(key, position):
        if key not in keys:
            keys[key] = (len(keys), position)
        return keys[key][0]

    if pattern == 'quad':
        nx, ny = (size, size) if isinstance(size, int) else size
        for i in range(nx + 1):
            for j in range(ny + 1):
                for di, dj in ((1, 0), (0, 1)):
                    if i + di <= nx and j + dj <= ny:
                        a = vid((i, j), ((i - nx / 2) * edge, (j - ny / 2) * edge))
                        b = vid((i + di, j + dj), ((i + di - nx / 2) * edge, (j + dj - ny / 2) * edge))
                        edges.add((min(a, b), max(a, b)))
    elif pattern == 'hex':
        # Flat-topped hexagons; centres q * b1 + r * b2 with b1 = (1.5, sqrt3 / 2) * edge, b2 = (0, sqrt3) * edge;
        # corners sit on the lattice of thirds of those.
        offsets = ((2, -1), (1, 1), (-1, 2), (-2, 1), (-1, -1), (1, -2))

        def where(kq, kr):
            return 1.5 * edge * kq / 3.0, math.sqrt(3.0) * edge * (kr + kq / 2.0) / 3.0
        for q in range(-size, size + 1):
            for r in range(-size, size + 1):
                if abs(q + r) > size:
                    continue
                ring = [(3 * q + dq, 3 * r + dr) for dq, dr in offsets]
                ids = [vid(k, where(*k)) for k in ring]
                for a, b in zip(ids, ids[1:] + ids[:1]):
                    edges.add((min(a, b), max(a, b)))
    elif pattern == 'tri':
        def where(i, j):
            return edge * (i + j / 2.0), edge * j * math.sqrt(3.0) / 2.0
        inside = {(i, j) for i in range(-size, size + 1) for j in range(-size, size + 1) if abs(i + j) <= size}
        for i, j in sorted(inside):
            for di, dj in ((1, 0), (0, 1), (-1, 1)):
                if (i + di, j + dj) in inside:
                    a, b = vid((i, j), where(i, j)), vid((i + di, j + dj), where(i + di, j + dj))
                    edges.add((min(a, b), max(a, b)))
    else:
        raise ValueError(f'unknown pattern {pattern!r}; one of {sorted(PATTERNS)}')
    vertices = [None] * len(keys)
    for index, position in keys.values():
        vertices[index] = position
    return vertices, sorted(edges)


def reciprocal_lines(pattern='hex', size=3, edge=1.0, engagement=0.25, overhang=0.04):
    """The reciprocal grid in plan: Frame(vertices, edges, segments, rests_on, alpha_deg). segments[e] = the centre
    line of beam e ((x0, y0) at the end by edges[e][0], (x1, y1) by edges[e][1]); rests_on[e] = (beam that end 0 rests
    on, beam that end 1 rests on), None at the grid's rim where there is no neighbour clockwise. Each beam runs
    `overhang` past the point where it lands on its neighbour."""
    if pattern not in PATTERNS:
        raise ValueError(f'unknown pattern {pattern!r}; one of {sorted(PATTERNS)}')
    count = size if isinstance(size, int) else max(size)
    if not (isinstance(count, int) and count >= 1):
        raise ValueError('size must be a positive integer (or (nx, ny) for quad)')
    check_count('size', count, MAX_SIZE)
    if not (edge > 0 and overhang >= 0):
        raise ValueError('edge must be positive and overhang not negative')
    d = PATTERNS[pattern]
    sin_alpha = engagement / (edge * math.tan(math.pi / d))
    if not 0 < sin_alpha <= 0.7:
        raise ValueError(f'engagement must be in (0, {0.7 * edge * math.tan(math.pi / d):.4g}] for {pattern} at this edge')
    alpha = math.asin(sin_alpha)
    vertices, edges = _tiling(pattern, size, edge)
    check_count('beams', len(edges), MAX_BEAMS)
    lines = []
    around = defaultdict(list)
    for e, (i, j) in enumerate(edges):
        (xi, yi), (xj, yj) = vertices[i], vertices[j]
        a = math.atan2(yj - yi, xj - xi)
        lines.append((((xi + xj) / 2, (yi + yj) / 2), (math.cos(a + alpha), math.sin(a + alpha))))
        around[i].append((a % (2 * math.pi), e))
        around[j].append(((a + math.pi) % (2 * math.pi), e))
    ends = [[None, None] for _ in edges]
    rests = [[None, None] for _ in edges]
    for v, spokes in around.items():
        spokes.sort()
        for k, (angle, e) in enumerate(spokes):
            (mx, my), (wx, wy) = lines[e]
            side = 0 if edges[e][0] == v else 1
            prev_angle, f = spokes[k - 1]
            gap = (angle - prev_angle) % (2 * math.pi) if len(spokes) > 1 else 2 * math.pi
            if 1e-9 < gap < math.pi - 1e-9:
                (nx_, ny_), (vx, vy) = lines[f]
                cross = wx * vy - wy * vx
                t = ((nx_ - mx) * vy - (ny_ - my) * vx) / cross
                t += overhang if t > 0 else -overhang
                rests[e][side] = f
            else:
                t = (vertices[v][0] - mx) * wx + (vertices[v][1] - my) * wy
            ends[e][side] = t
    segments = [((m[0] + t0 * w[0], m[1] + t0 * w[1]), (m[0] + t1 * w[0], m[1] + t1 * w[1]))
                for (m, w), (t0, t1) in zip(lines, ends)]
    return Frame(vertices, edges, segments, [tuple(r) for r in rests], math.degrees(alpha))


def beam_levels(frame):
    """A level per beam such that beams resting on each other never share one: the tiling's edge directions (two for
    quad, three for hex and tri) take turns, and round every fan neighbours differ."""
    def direction(i, j):
        (x0, y0), (x1, y1) = frame.vertices[i], frame.vertices[j]
        return round(math.degrees(math.atan2(y1 - y0, x1 - x0)) % 180.0) % 180
    found = [direction(i, j) for i, j in frame.edges]
    classes = sorted(set(found))
    return [classes.index(c) for c in found]


def reciprocal_grid(pattern='hex', size=3, edge=1.0, engagement=0.25, width=0.08, depth=0.12, overhang=None,
                    z_step=None):
    """A reciprocal-frame grid of timber beams (boxes `width` x `depth`), centred on the origin with z up: see
    reciprocal_lines for the plan. size = rings of hexagons ('hex'), of triangles ('tri'), or squares per side
    ('quad', or (nx, ny)). Beams sit at alternating levels z_step apart (default depth / 2, so beams resting on each
    other overlap by half their depth, as a halved joint) and run `overhang` (default width / 2) past their landing."""
    if not (width > 0 and depth > 0):
        raise ValueError('width and depth must be positive')
    frame = reciprocal_lines(pattern, size, edge, engagement, width / 2.0 if overhang is None else overhang)
    step = depth / 2.0 if z_step is None else float(z_step)
    boxes = []
    for ((x0, y0), (x1, y1)), level in zip(frame.segments, beam_levels(frame)):
        z = level * step + depth / 2.0
        boxes.append(beam((x0, y0, z), (x1, y1, z), width, depth))
    return ensure_finite(merged(*boxes))


def diagrid(width=6.0, height=3.0, nx=6, ny=3, member=0.06, layered=True):
    """A crossed timber truss (diagrid) lying flat like the facades (x across [0, width], y up [0, height], z out):
    two families of continuous diagonals, x/dx -+ y/dy = k with dx = width/nx, dy = height/ny, crossing in diamonds
    inside a frame of chords and end posts; members are `member` square. layered=True lays one family on the other
    (z in [0, member] and [member, 2 member]), else both cross at one level as halved joints; the frame is as deep as
    the diagonals plus 5% of a member on each face. Every member stays inside the rectangle in x and y."""
    if not (isinstance(nx, int) and isinstance(ny, int) and nx >= 1 and ny >= 1):
        raise ValueError('nx and ny must be positive integers')
    check_count('diamonds', nx * ny, 40_000)
    if not (width > 0 and height > 0 and 0 < member < min(width, height) / 4):
        raise ValueError('width and height must be positive and member under a quarter of the smaller')
    dx, dy = width / nx, height / ny
    deep = 2 * member if layered else member
    parts = []
    for family, ks in ((-1, range(-ny, nx + 1)), (1, range(0, nx + ny + 1))):
        # Line x / dx + family * y / dy = k, i.e. points (dx * (k - family * s), dy * s) for s along it.
        theta = math.atan2(dy, -family * dx)
        mx, my = 0.5 * member * abs(math.sin(theta)), 0.5 * member * abs(math.cos(theta))
        z = member / 2.0 if family < 0 or not layered else 1.5 * member
        for k in ks:
            lo, hi = -math.inf, math.inf
            # Parametrise by s = y / dy: x = dx * (k - family * s); keep mx <= x <= width - mx, my <= y <= height - my.
            for bound_lo, bound_hi, a, b in ((mx, width - mx, dx * k, -family * dx), (my, height - my, 0.0, dy)):
                if b == 0:
                    if not bound_lo <= a <= bound_hi:
                        lo, hi = 1.0, 0.0
                    continue
                s0, s1 = (bound_lo - a) / b, (bound_hi - a) / b
                lo, hi = max(lo, min(s0, s1)), min(hi, max(s0, s1))
            if hi - lo <= 1e-9:
                continue
            p0 = (dx * (k - family * lo), dy * lo, z)
            p1 = (dx * (k - family * hi), dy * hi, z)
            parts.append(beam(p0, p1, member, member))
    # The frame stands a little proud of the diagonals on both faces: flush faces would lie in one plane where the
    # diagonals run into it and flicker in a render.
    proud = 0.05 * member
    zc = deep / 2.0
    h = member / 2.0
    # Chords run the full width; the end posts run between them (an overlap would be another pair of flush faces).
    for p0, p1 in (((0.0, h, zc), (width, h, zc)), ((0.0, height - h, zc), (width, height - h, zc)),
                   ((h, member, zc), (h, height - member, zc)), ((width - h, member, zc), (width - h, height - member, zc))):
        parts.append(beam(p0, p1, member, deep + 2 * proud))
    return ensure_finite(merged(*parts))
