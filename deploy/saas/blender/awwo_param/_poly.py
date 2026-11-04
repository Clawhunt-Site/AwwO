"""2D polygon helpers shared by the flat generators (Voronoi, ice-crack, panels): area, centroid, half-plane clipping,
convex inset with a ring of faces between a cell and its hole, and welding by distance."""
import math


def area(poly):
    """Signed area, positive when counter-clockwise."""
    s = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i][0], poly[i][1]
        x1, y1 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        s += x0 * y1 - x1 * y0
    return 0.5 * s


def centroid(poly):
    a = area(poly)
    if abs(a) < 1e-300:
        n = len(poly)
        return sum(p[0] for p in poly) / n, sum(p[1] for p in poly) / n
    cx = cy = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i][0], poly[i][1]
        x1, y1 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        cross = x0 * y1 - x1 * y0
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    return cx / (6.0 * a), cy / (6.0 * a)


def clip(poly, nx, ny, c, labels=None, label=None):
    """Keeps the part of a convex polygon where nx*x + ny*y >= c (Sutherland-Hodgman). With labels (one per edge, the
    edge from vertex k to k+1), returns (polygon, labels) and gives the new edge along the line `label`."""
    out, out_labels = [], []
    n = len(poly)
    for k in range(n):
        p, q = poly[k], poly[(k + 1) % n]
        sp = nx * p[0] + ny * p[1] - c
        sq = nx * q[0] + ny * q[1] - c
        lab = labels[k] if labels is not None else None
        if sp >= 0.0:
            out.append(p)
            out_labels.append(lab)
            if sq < 0.0:
                t = sp / (sp - sq)
                out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
                out_labels.append(label)
        elif sq >= 0.0:
            t = sp / (sp - sq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
            out_labels.append(lab)
    if labels is None:
        return out
    return out, out_labels


def drop_short_edges(poly, labels, eps):
    """Removes vertices closer than eps to the next one (the earlier edge then runs on to the later vertex)."""
    poly, labels = list(poly), list(labels)
    k = 0
    while len(poly) > 2 and k < len(poly):
        nxt = (k + 1) % len(poly)
        if math.dist(poly[k], poly[nxt]) <= eps:
            del poly[nxt]
            del labels[nxt]
            if nxt < k:
                k -= 1
        else:
            k += 1
    return poly, labels


def inset(poly, distances):
    """The convex polygon `poly` (counter-clockwise) shrunk by moving edge i inward by distances[i]: the intersection
    of the inward half-planes, so edges that vanish do vanish. Returns (hole, labels) where labels[j] is the poly edge
    whose offset line hole edge j lies on, or None when nothing (or a sliver) is left."""
    n = len(poly)
    shape, labels = list(poly), [None] * n
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i][:2], poly[(i + 1) % n][:2]
        length = math.hypot(x1 - x0, y1 - y0)
        if length == 0.0:
            continue
        nx, ny = -(y1 - y0) / length, (x1 - x0) / length
        shape, labels = clip(shape, nx, ny, nx * x0 + ny * y0 + distances[i], labels, i)
        if len(shape) < 3:
            return None
    size = max(max(p[0] for p in poly) - min(p[0] for p in poly), max(p[1] for p in poly) - min(p[1] for p in poly))
    shape, labels = drop_short_edges(shape, labels, 1e-9 * size)
    if len(shape) < 3 or area(shape) <= 1e-12 * size * size or any(lab is None for lab in labels):
        return None
    return shape, labels


def corners(poly):
    """Indices of the polygon's true corners, skipping straight (180-degree) vertices."""
    n = len(poly)
    out = []
    for k in range(n):
        (ax, ay), (bx, by), (cx, cy) = poly[k - 1][:2], poly[k][:2], poly[(k + 1) % n][:2]
        ux, uy, vx, vy = bx - ax, by - ay, cx - bx, cy - by
        if abs(ux * vy - uy * vx) > 1e-9 * math.hypot(ux, uy) * math.hypot(vx, vy):
            out.append(k)
    return out


def ring(outer_ids, coords, distances, new_vertex, min_hole_area):
    """Faces covering a convex cell minus its inset hole, tiling it exactly. The cell is inset side by side (a side
    is a straight run of edges, so a neighbour's crack ending on it changes nothing); a side that survives becomes
    trapezoids, split where the run's inner vertices project onto the hole's edge, and one that vanishes becomes
    triangles to the hole corner it shrank to. outer_ids index coords; new_vertex(x, y) adds a hole vertex and
    returns its index. A hole smaller than min_hole_area leaves the cell solid (one n-gon). Returns (faces, area)."""
    n = len(outer_ids)
    poly = [coords[i] for i in outer_ids]
    cs = corners(poly)
    if len(cs) < 3:
        return [tuple(outer_ids)], 0.0
    runs = [[(c + s) % n for s in range((cs[(i + 1) % len(cs)] - c) % n + 1)] for i, c in enumerate(cs)]
    found = inset([poly[c] for c in cs], [distances[c] for c in cs])
    if found is None or area(found[0]) < min_hole_area:
        return [tuple(outer_ids)], 0.0
    hole, labels = found
    hole_ids = [new_vertex(x, y) for x, y in hole]
    m = len(hole)
    start_of = {lab: j for j, lab in enumerate(labels)}
    faces = []
    for side, run in enumerate(runs):
        ring_ids = [outer_ids[k] for k in run]
        if side not in start_of:
            nxt = next((side + s) % len(runs) for s in range(1, len(runs) + 1) if (side + s) % len(runs) in start_of)
            apex = hole_ids[start_of[nxt]]
            faces.extend((a, b, apex) for a, b in zip(ring_ids, ring_ids[1:]))
            continue
        j = start_of[side]
        (ax, ay), (bx, by) = hole[j], hole[(j + 1) % m]
        length = math.hypot(bx - ax, by - ay)
        ux, uy = (bx - ax) / length, (by - ay) / length
        inner = [hole_ids[j]]
        for k in run[1:-1]:
            s = min(max((poly[k][0] - ax) * ux + (poly[k][1] - ay) * uy, 0.0), length)
            if s <= 1e-12 * length:
                inner.append(hole_ids[j])
            elif s >= length * (1 - 1e-12):
                inner.append(hole_ids[(j + 1) % m])
            else:
                inner.append(new_vertex(ax + s * ux, ay + s * uy))
        inner.append(hole_ids[(j + 1) % m])
        for t in range(len(ring_ids) - 1):
            top = (inner[t + 1], inner[t]) if inner[t + 1] != inner[t] else (inner[t],)
            faces.append((ring_ids[t], ring_ids[t + 1]) + top)
    return faces, area(hole)


class Welder:
    """Merges points closer than eps (in every coordinate) into one index, through a hash of eps-sized cells, so
    points that are the same up to rounding but fall on either side of a cell border still meet."""

    def __init__(self, eps):
        self.eps = eps
        self.inv = 1.0 / eps
        self.cells = {}
        self.points = []

    def add(self, p):
        key = tuple(math.floor(c * self.inv) for c in p)
        eps = self.eps
        for offset in _neighbour_offsets(len(key)):
            for k in self.cells.get(tuple(a + b for a, b in zip(key, offset)), ()):
                q = self.points[k]
                if all(abs(a - b) <= eps for a, b in zip(p, q)):
                    return k
        k = len(self.points)
        self.points.append(tuple(p))
        self.cells.setdefault(key, []).append(k)
        return k


_OFFSETS = {}


def _neighbour_offsets(dim):
    if dim not in _OFFSETS:
        offsets = [()]
        for _ in range(dim):
            offsets = [o + (d,) for o in offsets for d in (0, -1, 1)]
        _OFFSETS[dim] = offsets
    return _OFFSETS[dim]


def frame_panel(polygons, frame, on_border, size):
    """A flat welded mesh (z = 0) of the frames of convex cells that tile a region: corners closer than 1e-9 * size
    become one vertex, each cell is inset by frame / 2 (by frame along edges where on_border(p, q), so the outer rim
    is as wide as the bars between cells) and the ring between cell and hole becomes faces. A cell whose hole would be
    under frame^2 stays solid. Returns (vertices, faces, holes) with holes the total hole area."""
    welder = Welder(1e-9 * size)
    cells = [dedupe_cycle([welder.add((float(p[0]), float(p[1]))) for p in poly]) for poly in polygons]
    corners = list(welder.points)
    extra = []

    def new_vertex(x, y):
        extra.append((x, y))
        return len(corners) + len(extra) - 1

    faces, holes = [], 0.0
    for ids in cells:
        if len(ids) < 3:
            continue
        n = len(ids)
        distances = [frame if on_border(corners[ids[i]], corners[ids[(i + 1) % n]]) else frame / 2.0 for i in range(n)]
        cell_faces, hole = ring(ids, corners, distances, new_vertex, frame * frame)
        faces.extend(cell_faces)
        holes += hole
    return [(x, y, 0.0) for x, y in corners + extra], faces, holes


def dedupe_cycle(ids):
    """A polygon's vertex indices without consecutive repeats (including last == first)."""
    out = []
    for i in ids:
        if not out or out[-1] != i:
            out.append(i)
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out
