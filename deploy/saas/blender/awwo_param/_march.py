"""Vectorised iso-surfaces and iso-lines with numpy: marching tetrahedra, clipping a triangle mesh by a signed
distance, and marching squares.

Marching tetrahedra: every grid cube is split into the same six tetrahedra round its diagonal from corner (0, 0, 0)
to (1, 1, 1) (the Kuhn split), so two cubes split their shared face along the same diagonal and no face is ambiguous:
inside a tetrahedron the surface is one triangle or one planar quad, and the mesh is watertight and manifold.
Vertices sit on grid edges (axis, face-diagonal or cube-diagonal) and are shared through the edge's global index.
They are linearly interpolated, so each triangle lies where its tetrahedron's linear interpolant is level and faces
the way it rises: none is ever turned over. Grid values within a hair of the level are first nudged off it, so no
two vertices meet at a grid point (needle triangles there would spoil normals and Solidify)."""
import numpy as np

# Corner c of a cube is at (c & 1, (c >> 1) & 1, (c >> 2) & 1).
CORNERS = tuple(((c & 1), (c >> 1) & 1, (c >> 2) & 1) for c in range(8))
# The six tetrahedra, one per order of the axes: corner 0, one axis on, two axes on, corner 7.
TETRAHEDRA = ((0, 1, 3, 7), (0, 1, 5, 7), (0, 2, 3, 7), (0, 2, 6, 7), (0, 4, 5, 7), (0, 4, 6, 7))
TET_EDGES = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))
# The seven directions a tetrahedron's edge can run, as 0/1 offsets, numbered by their corner bits minus one.
DIRECTIONS = np.array([CORNERS[bits] for bits in range(1, 8)], dtype=np.int64)


def _tet_cases(corners):
    """The oriented triangles of each of the 16 inside patterns of one tetrahedron, as numbers of its edges: one
    triangle round a lone vertex, two halves of a quad when two vertices are in and two out. Orientation is decided
    on the edges' midpoints; it holds wherever the vertices sit on those edges."""
    pos = np.array([CORNERS[c] for c in corners], dtype=float)
    edge_of = {e: k for k, e in enumerate(TET_EDGES)}
    table = []
    for case in range(16):
        inside = [k for k in range(4) if case >> k & 1]
        outside = [k for k in range(4) if not case >> k & 1]
        if len(inside) in (0, 4):
            table.append([])
            continue
        if len(inside) == 1 or len(outside) == 1:
            lone, others = (inside[0], outside) if len(inside) == 1 else (outside[0], inside)
            polygon = [tuple(sorted((lone, o))) for o in others]
        else:
            (a, b), (c, d) = inside, outside
            polygon = [tuple(sorted(p)) for p in ((a, c), (a, d), (b, d), (b, c))]  # consecutive ones share a face
        mid = [(pos[i] + pos[j]) / 2 for i, j in polygon]
        if np.cross(mid[1] - mid[0], mid[2] - mid[0]) @ (pos[outside].mean(axis=0) - pos[inside].mean(axis=0)) < 0:
            polygon = polygon[::-1]
        ids = [edge_of[e] for e in polygon]
        table.append([ids] if len(ids) == 3 else [ids[:3], [ids[0], ids[2], ids[3]]])
    return table


def _build_tables():
    tris = np.full((6, 16, 2, 3), -1, dtype=np.int64)
    count = np.zeros((6, 16), dtype=np.int64)
    edge_dir = np.zeros((6, 6), dtype=np.int64)
    edge_low = np.zeros((6, 6, 3), dtype=np.int64)
    for t, corners in enumerate(TETRAHEDRA):
        for case, found in enumerate(_tet_cases(corners)):
            count[t, case] = len(found)
            for s, ids in enumerate(found):
                tris[t, case, s] = ids
        for k, (i, j) in enumerate(TET_EDGES):
            # Along a Kuhn path each corner's bits contain the earlier one's: the edge runs from the earlier corner
            # in the direction of the bits it adds.
            edge_dir[t, k] = (corners[i] ^ corners[j]) - 1
            edge_low[t, k] = CORNERS[corners[i]]
    return tris, count, edge_dir, edge_low


TRIS, COUNT, EDGE_DIR, EDGE_LOW = _build_tables()


def _off_level(values, level):
    """Values within a hair (a thousandth of a typical step between neighbours) of the level move a hair off it,
    keeping their side: a vertex then never lands on a grid point, where the edges round that point would all put
    their vertices on top of one another."""
    steps = np.abs(np.diff(values, axis=0))
    scale = float(np.median(steps)) if steps.size else 0.0
    hair = 1e-3 * scale if scale > 0 else 1e-12
    near = np.abs(values - level) < hair
    if near.any():
        values = np.where(near, np.where(values >= level, level + hair, level - hair), values)
    return values


def _cases(inside, corners):
    """Every cube's inside pattern for one of its six tetrahedra: bit k set when its corner k is inside."""
    nx, ny, nz = (s - 1 for s in inside.shape)
    case = np.zeros((nx, ny, nz), dtype=np.int64)
    for k, c in enumerate(corners):
        ox, oy, oz = CORNERS[c]
        case |= inside[ox:ox + nx, oy:oy + ny, oz:oz + nz].astype(np.int64) << k
    return case


def marching_tetrahedra(values, origin, spacing, level=0.0, max_triangles=None):
    """Triangles of {values = level} on a grid values[i, j, k] at origin + (i, j, k) * spacing, facing the side where
    the values are higher. Returns (vertices (n, 3), faces (m, 3)): welded (one vertex per grid edge the surface
    crosses), watertight inside the grid and manifold (every edge off the grid's border in exactly two triangles).
    With max_triangles, the triangles are counted first, and more of them raise ValueError before any is built (the
    arrays that build them take a few hundred bytes each)."""
    values = _off_level(np.asarray(values, dtype=np.float64), level)
    nx, ny, nz = (s - 1 for s in values.shape)
    sy, sz = ny + 1, nz + 1
    points = (nx + 1) * sy * sz
    inside = values < level
    if max_triangles is not None:
        total = sum(int(COUNT[t][_cases(inside, corners)].sum()) for t, corners in enumerate(TETRAHEDRA))
        if total > max_triangles:
            raise ValueError(f'the surface would have {total} triangles, beyond the maximum {max_triangles}: '
                             'lower the resolution or the cells')
    keys = []
    for t, corners in enumerate(TETRAHEDRA):
        case = _cases(inside, corners)
        ci, cj, ck = np.nonzero((case > 0) & (case < 15))
        cases = case[ci, cj, ck]
        counts = COUNT[t, cases]
        local = TRIS[t, cases][np.arange(2)[None, :] < counts[:, None]]
        cell = np.repeat(np.arange(len(cases)), counts)
        low = EDGE_LOW[t][local]
        gi, gj, gk = ci[cell][:, None] + low[..., 0], cj[cell][:, None] + low[..., 1], ck[cell][:, None] + low[..., 2]
        keys.append(EDGE_DIR[t][local] * points + (gi * sy + gj) * sz + gk)
    keys = np.concatenate(keys)
    if not len(keys):
        return np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)
    unique, faces = np.unique(keys.ravel(), return_inverse=True)
    direction, rest = unique // points, unique % points
    lo = np.stack([rest // (sy * sz), (rest // sz) % sy, rest % sz], axis=1)
    hi = lo + DIRECTIONS[direction]
    f0, f1 = values[lo[:, 0], lo[:, 1], lo[:, 2]], values[hi[:, 0], hi[:, 1], hi[:, 2]]
    origin, spacing = np.asarray(origin, float), np.asarray(spacing, float)
    p0, p1 = origin + lo * spacing, origin + hi * spacing
    return p0 + (p1 - p0) * ((level - f0) / (f1 - f0))[:, None], faces.reshape(-1, 3)


def _onto_line(faces, d, snap):
    """The inside vertices that take their cuts: those within `snap` of the zero line (a fraction of the edge) along
    every edge of theirs that crosses it, a vertex exactly on it included. Their distance becomes 0, so that each of
    their cuts is at the vertex itself, which stays where it is: every face kept round it is then a piece of one it
    had, turned the same way, with no cut point on top of it or a hair from it. Returns (d, taken)."""
    n = len(d)
    taken = np.zeros(n, bool)
    inside = d <= 0.0
    edges = np.unique(np.sort(np.stack([faces.ravel(), np.roll(faces, -1, axis=1).ravel()], 1), axis=1), axis=0)
    crossing = edges[inside[edges[:, 0]] != inside[edges[:, 1]]]
    if not len(crossing):
        return d, taken
    flip = ~inside[crossing[:, 0]]
    i, j = np.where(flip, crossing[:, 1], crossing[:, 0]), np.where(flip, crossing[:, 0], crossing[:, 1])
    far = np.zeros(n, bool)
    far[i[d[i] / (d[i] - d[j]) > snap]] = True
    taken[i] = True
    taken &= ~far
    return np.where(taken, 0.0, d), taken


def _components(size, left, right):
    """Each item's smallest fellow in the groups the pairs (left[k], right[k]) join."""
    label = np.arange(size)
    while len(left):
        low = np.minimum(label[left], label[right])
        nxt = label.copy()
        np.minimum.at(nxt, left, low)
        np.minimum.at(nxt, right, low)
        if np.array_equal(nxt, label):
            break
        label = nxt
    return label


def _split_pinches(vertices, faces, flags):
    """Gives each fan of faces round a vertex its own copy of the vertex: where the kept part only touches itself (a
    vertex that took its cuts between two runs of outside neighbours), the copies meet but the mesh stays manifold.
    Round a vertex, a face's corner is joined to the next face's across the edge they share, which the next face runs
    the other way. Returns (vertices, faces, flags), each copy with its vertex's flag."""
    n, corners = len(vertices), faces.size
    centre = faces.ravel()
    out_key = centre * n + np.roll(faces, -1, axis=1).ravel()
    in_key = centre * n + np.roll(faces, -2, axis=1).ravel()
    order = np.argsort(in_key, kind='stable')
    match = order[np.minimum(np.searchsorted(in_key[order], out_key), corners - 1)]
    joined = in_key[match] == out_key
    label = _components(corners, np.nonzero(joined)[0], match[joined])
    keys, inverse = np.unique(centre * corners + label, return_inverse=True)
    owner = keys // corners
    first = np.ones(len(keys), bool)
    first[1:] = owner[1:] != owner[:-1]
    if first.all():
        return vertices, faces, flags
    index = np.where(first, owner, n + np.cumsum(~first) - 1)
    copies = owner[~first]
    return (np.concatenate([vertices, vertices[copies]]), index[inverse].reshape(-1, 3),
            np.concatenate([flags, flags[copies]]))


def _normals(vertices, faces):
    t = vertices[faces]
    return np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])


def clip_by_distance(vertices, faces, distance, snap=0.02):
    """Keeps the part of a triangle mesh where distance <= 0 (a solid's signed distance at each vertex), cutting the
    triangles that cross along the linearly interpolated zero line. Cut points are shared per mesh edge, and none lies
    on or a hair from a vertex, nor two a hair apart in one face: an inside vertex within `snap` of the line (a
    fraction of the edge) along every edge of it that crosses the line takes those cuts itself (_onto_line); round an
    outside vertex the two cuts of a face that both fall within `snap` of it become one point, at their mean, unless
    that would tilt a face more than 25 degrees off the face it came from, or halve it (a run of such faces shares one
    point, another run another). A vertex the kept part then only touches itself at gets a copy per fan
    (_split_pinches): a manifold mesh stays manifold, vertices included. Every other kept face is a piece of the face
    it came from, turned the same way.
    For a convex solid every cut point, and every mean of them, is inside it (a convex function lies below its chords).
    Returns (vertices, faces, is_cut, source) with unused vertices removed: is_cut marks the cut points and the
    vertices that took cuts, source the face each kept face came from."""
    vertices, faces, d = np.asarray(vertices, float), np.asarray(faces, np.int64), np.asarray(distance, float)
    n = len(vertices)
    if len(faces) == 0:
        return vertices[:0], faces[:0], np.zeros(0, bool), np.zeros(0, np.int64)
    d, taken = _onto_line(faces, d, snap)
    inside = d <= 0.0
    count = inside[faces].sum(axis=1)
    numbers = np.arange(len(faces))
    whole = faces[count == 3]
    source = [numbers[count == 3]]
    requests = []  # (inside vertex, outside vertex) per needed cut, in order of use
    one, two = faces[count == 1], faces[count == 2]
    roll = np.arange(3)
    if len(one):
        first = np.argmax(inside[one], axis=1)
        one = one[np.arange(len(one))[:, None], (first[:, None] + roll) % 3]
        requests.append(np.stack([one[:, 0], one[:, 1]], 1))
        requests.append(np.stack([one[:, 0], one[:, 2]], 1))
        source.append(numbers[count == 1])
    if len(two):
        first = np.argmax(~inside[two], axis=1)
        two = two[np.arange(len(two))[:, None], (first[:, None] + roll) % 3]
        requests.append(np.stack([two[:, 1], two[:, 0]], 1))
        requests.append(np.stack([two[:, 2], two[:, 0]], 1))
        source += [numbers[count == 2], numbers[count == 2]]
    source = np.concatenate(source)
    points = np.zeros((0, 3))
    built = whole
    if requests:
        pairs = np.concatenate(requests)
        unique, where = np.unique(pairs[:, 0] * n + pairs[:, 1], return_inverse=True)
        i, j = unique // n, unique % n
        t = d[i] / (d[i] - d[j])
        # Only a vertex on the line (one that took its cuts, or one there already) has a cut at itself.
        reuse = t <= 0.0
        at = vertices[i] + (vertices[j] - vertices[i]) * t[:, None]

        def build(group):
            roots, slot = np.unique(group[~reuse], return_inverse=True)
            total = np.zeros((len(roots), 3))
            np.add.at(total, slot, at[~reuse])
            made = total / np.bincount(slot, minlength=len(roots))[:, None]
            index = np.empty(len(unique), np.int64)
            index[reuse] = i[reuse]
            index[~reuse] = n + slot
            cut = index[where]
            out = [whole]
            if len(one):
                out.append(np.stack([one[:, 0], cut[:len(one)], cut[len(one):2 * len(one)]], 1))
            if len(two):
                oa, ob = cut[2 * len(one):2 * len(one) + len(two)], cut[2 * len(one) + len(two):]
                out.append(np.stack([oa, two[:, 1], two[:, 2]], 1))
                out.append(np.stack([oa, two[:, 2], ob], 1))
            return made, np.concatenate(out), roots

        alone = np.arange(len(unique))
        group = alone
        if len(two):
            near = 1.0 - t <= snap
            oa, ob = where[2 * len(one):2 * len(one) + len(two)], where[2 * len(one) + len(two):]
            both = near[oa] & near[ob] & ~reuse[oa] & ~reuse[ob]
            group = _components(len(unique), oa[both], ob[both])
        points, built, roots = build(group)
        if not np.array_equal(group, alone):
            # A merged point is off the edges of the faces beside it: a merge that would tilt one more than 25 degrees
            # off the face it came from, or halve it against the same face with the cuts apart, is undone, and the
            # faces are checked again, since undoing one merge can spoil a face another one shares: until none fails.
            # A face without a merged point is a piece of its source, so every failing face undoes a merge, and this
            # ends once every merge left holds.
            plain, apart, _ = build(alone)
            source_n = _normals(vertices, faces)[source]
            size_s = np.linalg.norm(source_n, axis=1)
            size_a = np.linalg.norm(_normals(np.concatenate([vertices, plain]), apart), axis=1)
            while True:
                live = (built[:, 0] != built[:, 1]) & (built[:, 1] != built[:, 2]) & (built[:, 2] != built[:, 0])
                merged_n = _normals(np.concatenate([vertices, points]), built)
                size_m = np.linalg.norm(merged_n, axis=1)
                bad = live & (((merged_n * source_n).sum(axis=1) <= 0.9 * size_m * size_s) | (size_m < 0.5 * size_a))
                touched = built[bad].ravel()
                touched = touched[touched >= n] - n
                undone = np.isin(group, roots[touched]) & (group != alone)
                if not undone.any():
                    break
                group = np.where(undone, alone, group)
                points, built, roots = build(group)
        vertices = np.concatenate([vertices, points])
    live = (built[:, 0] != built[:, 1]) & (built[:, 1] != built[:, 2]) & (built[:, 2] != built[:, 0])
    faces, source = built[live], source[live]
    used = np.zeros(len(vertices), bool)
    used[faces.ravel()] = True
    remap = np.cumsum(used) - 1
    is_cut = np.concatenate([taken, np.ones(len(points), bool)])
    vertices, faces, is_cut = _split_pinches(vertices[used], remap[faces], is_cut[used])
    return vertices, faces, is_cut, source


def _square_segments(case, joined):
    """Marching-squares segments for one cell: corners q0 (r, c), q1 (r, c+1), q2 (r+1, c+1), q3 (r+1, c) are
    counter-clockwise with x = column, y = row; edge k joins q_k to q_k+1. Bit k of case = corner k at or above the
    level. Segments keep that region on their left; a saddle joins the high corners when `joined`."""
    high = [(case >> k) & 1 for k in range(4)]
    crossings = [(k, bool(high[k])) for k in range(4) if high[k] != high[(k + 1) % 4]]
    entering = {k for k, leaves_high in crossings if not leaves_high}
    segments = []
    for k, leaves_high in crossings:
        if leaves_high:
            steps = range(1, 4) if joined else range(-1, -4, -1)
            segments.append((k, next((k + s) % 4 for s in steps if (k + s) % 4 in entering)))
    return segments


SQUARE = {(case, joined): _square_segments(case, joined) for case in range(16) for joined in (False, True)}


def marching_squares(values, level):
    """Iso-lines of a 2D array values[row, col] as polylines in (col, row) coordinates: a list of (points (n, 2),
    closed) with the region at or above the level on the left of each line. Saddles follow the cell's mean."""
    values = np.asarray(values, dtype=np.float64)
    rows, cols = values.shape
    high = values >= level
    case = (high[:-1, :-1].astype(np.int64) | high[:-1, 1:] << 1 | high[1:, 1:] << 2 | high[1:, :-1] << 3)
    centre = (values[:-1, :-1] + values[:-1, 1:] + values[1:, 1:] + values[1:, :-1]) / 4.0 >= level
    following = {}
    # Local edge k of cell (r, c) as (row, col, vertical) of the grid edge it is.
    local = ((0, 0, 0), (0, 1, 1), (1, 0, 0), (0, 0, 1))
    for r, c in zip(*np.nonzero((case > 0) & (case < 15))):
        for k0, k1 in SQUARE[(int(case[r, c]), bool(centre[r, c]))]:
            a, b = local[k0], local[k1]
            following[((r + a[0]) * cols + c + a[1]) * 2 + a[2]] = ((r + b[0]) * cols + c + b[1]) * 2 + b[2]

    def point(key):
        vertical, cell = key % 2, key // 2
        r, c = divmod(cell, cols)
        r1, c1 = (r + 1, c) if vertical else (r, c + 1)
        v0, v1 = values[r, c], values[r1, c1]
        t = (level - v0) / (v1 - v0)
        return c + (c1 - c) * t, r + (r1 - r) * t

    lines, seen = [], set()
    ends = set(following.values())
    starts = [k for k in following if k not in ends] + list(following)
    for start in starts:
        if start in seen:
            continue
        chain, key = [start], following.get(start)
        seen.add(start)
        while key is not None and key != start and key not in seen:
            chain.append(key)
            seen.add(key)
            key = following.get(key)
        lines.append((np.array([point(k) for k in chain]), key == start))
    return lines
