"""Mesh and polygon checks the tests share."""
import collections
import math

import numpy as np


def directed_edges(faces):
    count = collections.Counter()
    for f in faces:
        for a, b in zip(f, tuple(f[1:]) + tuple(f[:1])):
            count[(a, b)] += 1
    return count


def assert_manifold(test, faces):
    """No edge is used twice in the same direction (so at most two faces share an edge, oppositely oriented);
    returns the boundary edges (used once, never the other way round)."""
    count = directed_edges(faces)
    twice = [e for e, n in count.items() if n > 1]
    test.assertEqual(twice[:5], [], 'edges used twice in one direction')
    return [e for e in count if (e[1], e[0]) not in count]


def assert_vertex_manifold(test, faces, label=''):
    """Round every vertex its faces form one fan (joined through the edges at the vertex), and a vertex on the boundary
    has exactly two boundary edges: no vertex is a pinch two fans share, which an edge check alone misses."""
    around = collections.defaultdict(list)
    for index, face in enumerate(faces):
        for v in face:
            around[v].append(index)
    directed = directed_edges(faces)
    boundary = collections.Counter()
    for a, b in directed:
        if (b, a) not in directed:
            boundary[a] += 1
            boundary[b] += 1
    pinched = []
    for v, incident in around.items():
        parent = list(range(len(incident)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        first = {}
        for k, index in enumerate(incident):
            for u in faces[index]:
                if u != v:
                    if u in first:
                        parent[find(k)] = find(first[u])
                    else:
                        first[u] = k
        fans = len({find(k) for k in range(len(incident))})
        if fans != 1 or boundary[v] not in (0, 2):
            pinched.append((v, fans, boundary[v]))
    test.assertEqual(pinched[:5], [], f'{label}: vertices (vertex, fans, boundary edges) two fans share')


def boundary_loops(faces):
    nxt = {a: b for a, b in assert_free_boundary(faces)}
    loops, seen = [], set()
    for start in nxt:
        if start in seen:
            continue
        loop, v = [start], nxt[start]
        seen.add(start)
        while v != start:
            loop.append(v)
            seen.add(v)
            v = nxt[v]
        loops.append(loop)
    return loops


def assert_free_boundary(faces):
    count = directed_edges(faces)
    edges = [e for e in count if (e[1], e[0]) not in count]
    starts = collections.Counter(a for a, _b in edges)
    if any(n > 1 for n in starts.values()):
        raise AssertionError('a boundary vertex starts two boundary edges')
    return edges


def area2d(points):
    s = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        s += x0 * y1 - x1 * y0
    return 0.5 * s


def face_area2d(mesh, face):
    return area2d([mesh.vertices[i][:2] for i in face])


def contains(poly, x, y):
    """Point in polygon by the crossing number (any simple polygon)."""
    inside = False
    n = len(poly)
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i][:2], poly[(i + 1) % n][:2]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def coverage(mesh, samples):
    """How many faces of a flat mesh contain each sample point (x, y)."""
    polys = [[mesh.vertices[i][:2] for i in f] for f in mesh.faces]
    boxes = [(min(p[0] for p in q), max(p[0] for p in q), min(p[1] for p in q), max(p[1] for p in q)) for q in polys]
    out = []
    for x, y in samples:
        out.append(sum(1 for q, (a, b, c, d) in zip(polys, boxes) if a <= x <= b and c <= y <= d and contains(q, x, y)))
    return out


def face_normals(mesh):
    """Area-weighted normals (twice the area long) and centres of every face."""
    v = np.asarray(mesh.vertices, dtype=float)
    if mesh.faces and all(len(f) == 3 for f in mesh.faces):
        t = v[np.asarray(mesh.faces)]
        return np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), t.mean(axis=1)
    out, centres = [], []
    for f in mesh.faces:
        p = v[list(f)]
        n = np.zeros(3)
        for i in range(1, len(f) - 1):
            n += np.cross(p[i] - p[0], p[i + 1] - p[0])
        out.append(n)
        centres.append(p.mean(axis=0))
    return np.array(out), np.array(centres)


def angle_deg(a, b, c):
    """The angle at b between b->a and b->c."""
    ux, uy, vx, vy = a[0] - b[0], a[1] - b[1], c[0] - b[0], c[1] - b[1]
    return math.degrees(math.atan2(abs(ux * vy - uy * vx), ux * vx + uy * vy))
