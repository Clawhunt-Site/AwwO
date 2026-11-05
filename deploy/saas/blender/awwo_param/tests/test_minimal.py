import unittest

import numpy as np

from awwo_param import _march, minimal
from awwo_param.geometry import box

from ._checks import assert_manifold, assert_vertex_manifold, face_normals

KINDS = ('gyroid', 'schwarz_p', 'schwarz_d', 'neovius', 'lidinoid', 'iwp', 'fischer_koch_s', 'split_p')
# The clip shapes the manifold sweep tries at each resolution (clipping is the slow part).
SHAPES_AT = {8: ('box', 'cylinder'), 13: ('box', 'sphere', 'cylinder'), 21: ('box', 'sphere')}


def gradient(kind, points, size=(2, 2, 2), cells=(2, 2, 2), h=1e-6):
    return np.stack([(minimal.evaluate(kind, points + e, size, cells) - minimal.evaluate(kind, points - e, size, cells))
                     / (2 * h) for e in np.eye(3) * h], axis=1)


def assert_no_slivers(test, mesh, label):
    """Every triangle has an area, none is a needle (area over its longest edge squared: the marching alone stays above
    1e-4, a clip above 1e-6), and two vertices at one spot (the copies of a split neck) never share a triangle."""
    v, f = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    area = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    longest = np.max(np.stack([np.linalg.norm(v[f[:, k]] - v[f[:, (k + 1) % 3]], axis=1) for k in range(3)], 1), axis=1)
    test.assertGreater(float(area.min()), 0.0, f'{label}: a triangle without area')
    test.assertGreater(float((area / longest ** 2).min()), 1e-7, f'{label}: a needle')
    spot = np.unique(v, axis=0, return_inverse=True)[1].ravel()[f]
    test.assertFalse(np.any((spot[:, 0] == spot[:, 1]) | (spot[:, 1] == spot[:, 2]) | (spot[:, 2] == spot[:, 0])),
                     f'{label}: one spot twice in a triangle')


def assert_two_per_edge(test, faces, label):
    """Every edge in at most two triangles, two meaning one each way round, and no triangle twice: the open edges
    (used once) are returned for the caller to place on the clip's boundary."""
    f = np.asarray(faces, dtype=np.int64)
    n = int(f.max()) + 1
    a, b = f.ravel(), np.roll(f, -1, axis=1).ravel()
    directed = a * n + b
    unique, count = np.unique(directed, return_counts=True)
    test.assertEqual(int(count.max()), 1, f'{label}: an edge used twice the same way round')
    test.assertEqual(len(np.unique(np.sort(f, axis=1), axis=0)), len(f), f'{label}: a triangle repeated')
    open_edges = ~np.isin(b * n + a, unique)
    return list(zip(a[open_edges].tolist(), b[open_edges].tolist()))


class TpmsTest(unittest.TestCase):
    def check(self, kind, shape, resolution=32, level=0.0, size=(2.0, 2.0, 2.0), cells=(2, 2, 2)):
        m = minimal.tpms(kind, size=size, cells=cells, resolution=resolution, level=level, shape=shape)
        self.assertGreater(len(m.faces), 100, kind)
        v = np.array(m.vertices)
        f = minimal.evaluate(kind, v, size, cells) - level
        d = minimal.shape_distance(shape, v, size)
        cell = max(size) / resolution
        self.assertLessEqual(d.max(), 1e-9, f'{kind} {shape}: a vertex outside the solid')
        # Welded and watertight: every edge is shared by two faces except where the surface meets the solid.
        boundary = assert_two_per_edge(self, m.faces, f'{kind} {shape}')
        rim = np.array(sorted({i for e in boundary for i in e}))
        # Rim points are refined onto the solid's surface; where that would turn a thin rim triangle over they keep
        # the cut's position, which for a convex solid is inside it by a fraction of a cell (most at a cylinder's edge).
        self.assertLess(np.abs(d[rim]).max(), 0.25 * cell, f'{kind} {shape}: an open edge inside the solid')
        self.assertLess(np.median(np.abs(d[rim])), 1e-6, f'{kind} {shape}')
        # Vertices are linearly interpolated along grid edges (some of them cube diagonals, sqrt(3) cells long):
        # within half a cell of the surface, most much nearer.
        distance = np.abs(f) / np.linalg.norm(gradient(kind, v, size, cells), axis=1)
        self.assertLess(distance.max(), 0.5 * cell, f'{kind} {shape}')
        self.assertLess(np.median(distance), 0.05 * cell, f'{kind} {shape}')
        # Faces face +grad f.
        normals, centres = face_normals(m)
        big = np.linalg.norm(normals, axis=1) > 1e-6 * cell * cell
        dots = (normals[big] * gradient(kind, centres[big], size, cells)).sum(axis=1)
        self.assertGreater((dots > 0).mean(), 0.99, f'{kind} {shape}')
        return m

    def test_every_kind_in_a_box(self):
        for kind in KINDS:
            self.check(kind, 'box')

    def test_clipped_to_a_sphere_and_a_cylinder(self):
        for kind in ('gyroid', 'schwarz_p', 'lidinoid', 'iwp'):
            for shape in ('sphere', 'cylinder'):
                self.check(kind, shape)

    def test_level_and_a_non_cubic_box(self):
        self.check('gyroid', 'box', level=0.6)
        self.check('schwarz_d', 'cylinder', size=(1.0, 1.0, 3.0), cells=(1, 1, 3), resolution=60)

    def test_manifold_for_every_kind_resolution_and_level(self):
        # The faults this guards against: marching cubes with fan-triangulated loops made edges with four triangles
        # (tpms('neovius', resolution=8, level=0.1) did), and clipping pinched vertices two fans shared: cutting a
        # cylinder along its caps too, and snapping cuts on two sides of a vertex onto it (schwarz_p in a cylinder
        # at resolution 13 and level 0.1 did, as did 28 of the meshes below before).
        for kind in KINDS:
            for resolution in (8, 13, 21):
                for level in (-0.4, 0.0, 0.1, 0.45):
                    for shape in SHAPES_AT.get(resolution, ('box',)):
                        label = f'{kind} {resolution} {level} {shape}'
                        m = minimal.tpms(kind, resolution=resolution, level=level, shape=shape)
                        boundary = assert_two_per_edge(self, m.faces, label)
                        assert_vertex_manifold(self, m.faces, label)
                        assert_no_slivers(self, m, label)
                        if not boundary:
                            continue
                        v = np.array(m.vertices)
                        ends = np.array(sorted({i for e in boundary for i in e}))
                        off = np.abs(minimal.shape_distance(shape, v[ends])).max()
                        self.assertLess(off, 0.25 * 2.0 / resolution, f'{label}: an open edge')

    def test_clipped_meshes_have_no_pinched_vertices_in_other_boxes(self):
        for kind in ('schwarz_d', 'lidinoid', 'fischer_koch_s', 'split_p', 'gyroid'):
            for size, cells in (((1.0, 1.0, 3.0), (1, 1, 3)), ((3.0, 2.0, 1.0), (3, 2, 1))):
                for shape in ('sphere', 'cylinder'):
                    for resolution, level in ((8, 0.0), (13, -0.4), (13, 0.45), (21, 0.45)):
                        m = minimal.tpms(kind, size=size, cells=cells, resolution=resolution, level=level, shape=shape)
                        assert_vertex_manifold(self, m.faces, f'{kind} {size} {shape} {resolution} {level}')
                        assert_no_slivers(self, m, f'{kind} {size} {shape} {resolution} {level}')

    def test_clipped_faces_never_turn_against_the_face_they_came_from(self):
        # Moving a vertex onto the cut once turned a face it kept over (neovius in a 4 x 4 x 2 box with cells (3, 2,
        # 0.5) at 10, level 0.45, in a sphere), which the rim projection's unfold, checked against the cut mesh, missed.
        cases = [('neovius', (4.0, 4.0, 2.0), (3, 2, 0.5), 10, 0.45, 'sphere')]
        for kind in KINDS:
            for shape in ('sphere', 'cylinder'):
                cases += [(kind, (2.0, 2.0, 2.0), (2, 2, 2), resolution, level, shape)
                          for resolution, level in ((8, 0.0), (13, 0.1), (13, -0.4), (21, 0.45))]
                cases.append((kind, (4.0, 4.0, 2.0), (3, 2, 0.5), 13, 0.45, shape))
        for kind, size, cells, resolution, level, shape in cases:
            v, f, turned = minimal._surface(kind, size, cells, resolution, level, shape)
            n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
            cos = (n * turned).sum(axis=1) / (np.linalg.norm(n, axis=1) * np.linalg.norm(turned, axis=1))
            self.assertGreater(float(cos.min()), 0.1, f'{kind} {size} {cells} {resolution} {level} {shape}')

    def test_a_flat_fan_cut_by_half_planes_keeps_each_face_turned_and_with_area(self):
        # Through the centre, a hair from it, and anywhere: every kept face has an area and faces up, and no two
        # vertices share a spot (a half-plane leaves a fan no neck).
        ring = 12
        angles = np.linspace(0.0, 2.0 * np.pi, ring, endpoint=False)
        v = np.concatenate([[[0.0, 0.0, 0.0]], np.stack([np.cos(angles), np.sin(angles), np.zeros(ring)], 1)])
        faces = np.array([[0, 1 + k, 1 + (k + 1) % ring] for k in range(ring)])
        rng = np.random.default_rng(7)
        for trial in range(300):
            direction = rng.normal(size=2)
            direction /= np.linalg.norm(direction)
            offset = (0.0, rng.uniform(-0.03, 0.03), rng.uniform(-1.0, 1.0))[trial % 3]
            cv, cf, is_cut, source = _march.clip_by_distance(v, faces, v[:, :2] @ direction - offset)
            if len(cf):
                n = np.cross(cv[cf[:, 1]] - cv[cf[:, 0]], cv[cf[:, 2]] - cv[cf[:, 0]])
                self.assertGreater(float(n[:, 2].min()), 0.0, (trial, direction, offset))
                self.assertEqual(len(np.unique(cv, axis=0)), len(cv), (trial, direction, offset))
                self.assertTrue(np.all(source < len(faces)))

    def check_cut(self, v, f, d, label):
        """A clip's faces against their sources: within 25 degrees, with an area, every vertex manifold."""
        cv, cf, is_cut, source = _march.clip_by_distance(v, f, d)
        if not len(cf):
            return
        n, ref = _march._normals(cv, cf), _march._normals(v, f)[source]
        cos = (n * ref).sum(axis=1) / (np.linalg.norm(n, axis=1) * np.linalg.norm(ref, axis=1))
        self.assertGreater(float(cos.min()), 0.9, label)
        assert_vertex_manifold(self, [tuple(x) for x in cf.tolist()], label)

    def test_undoing_a_merge_checks_the_faces_beside_it_again(self):
        # Face 0 passed with both of its merged cuts, then turned over (cosine -0.68) once another face undid only
        # one of the two merges, and was never checked again.
        for z in (0.30150201, 0.30351):
            v = np.array([[-1, 0, 0], [.01, 0, 0], [.01, .001, 0], [-1, -.303, .1515], [-2, -.603, z], [-1, -.404, .2222]])
            self.check_cut(v, np.array([[0, 1, 2], [1, 0, 3], [1, 3, 4], [0, 2, 5]]), v[:, 0], f'z = {z}')

    def test_random_surfaces_cut_by_random_planes_and_spheres(self):
        rng = np.random.default_rng(11)
        side = 7
        index = np.arange(side * side).reshape(side, side)
        quads = np.stack([index[:-1, :-1], index[:-1, 1:], index[1:, 1:], index[1:, :-1]], -1).reshape(-1, 4)
        faces = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
        for trial in range(3000):
            grid = np.stack(np.meshgrid(np.arange(side), np.arange(side), indexing='xy'), -1).reshape(-1, 2).astype(float)
            grid += rng.uniform(-0.3, 0.3, grid.shape)
            # Crumpled as often as gentle: steep folds are where a merged point tilts a face most.
            v = np.concatenate([grid, rng.uniform(-1.0, 1.0, (len(grid), 1)) * (3.0 if trial % 4 < 2 else 0.4)], axis=1)
            if trial % 2:
                normal = rng.normal(size=3)
                d = v @ (normal / np.linalg.norm(normal)) - rng.uniform(-1.0, 1.0) - v.mean(axis=0) @ (normal / np.linalg.norm(normal))
            else:
                d = np.linalg.norm(v - (v.mean(axis=0) + rng.normal(size=3)), axis=1) - rng.uniform(1.0, 3.5)
            # Distances a hair off zero, where the snapping and merging start.
            d = np.where(rng.random(len(d)) < 0.35, d * 1e-3, d)
            self.check_cut(v, faces, d, f'trial {trial}')

    def test_a_cut_on_a_vertex_makes_no_second_one(self):
        # The default cylinder touches the grid's sides along four lines, where vertices sit exactly on its wall: a cut
        # there once added a second vertex on the same spot and 28 triangles without area (12 in a sphere at 13).
        for shape, resolution in (('cylinder', 8), ('cylinder', 32), ('sphere', 13)):
            assert_no_slivers(self, minimal.tpms('gyroid', shape=shape, resolution=resolution), f'{shape} {resolution}')
        # Straight through two vertices of one triangle, and along an edge: the cut takes the vertices themselves.
        v = np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0]])
        faces = np.array([[0, 1, 2], [1, 3, 2], [1, 4, 3], [4, 5, 3]])
        for d in (np.array([-1.0, 0, -1, 0, 1, 1]), np.array([-1.0, 0, 0, 1, 2, 2])):
            cv, cf, is_cut, source = _march.clip_by_distance(v, faces, d)
            self.assertEqual(len(np.unique(cv, axis=0)), len(cv), d)
            area = np.linalg.norm(np.cross(cv[cf[:, 1]] - cv[cf[:, 0]], cv[cf[:, 2]] - cv[cf[:, 0]]), axis=1)
            self.assertGreater(area.min(), 0.0, d)

    def test_triangles_are_counted_before_any_is_built(self):
        # cells=32 at the finest grid would make 34,603,008 triangles, about 9 GiB on the way: refused at once.
        with self.assertRaises(ValueError) as caught:
            minimal.tpms('split_p', cells=(32, 32, 32), resolution=minimal.MAX_GRID)
        self.assertIn('triangles', str(caught.exception))
        with self.assertRaises(ValueError):
            _march.marching_tetrahedra(np.indices((9, 9, 9)).sum(axis=0) % 2 - 0.5, (0, 0, 0), (1, 1, 1), 0.0, max_triangles=10)
        v, faces = _march.marching_tetrahedra(np.indices((9, 9, 9)).sum(axis=0) % 2 - 0.5, (0, 0, 0), (1, 1, 1), 0.0)
        self.assertGreater(len(faces), 10)
        self.assertEqual(len(_march.marching_tetrahedra(np.indices((9, 9, 9)).sum(axis=0) % 2 - 0.5, (0, 0, 0), (1, 1, 1),
                                                        0.0, max_triangles=len(faces))[1]), len(faces))

    def test_default_size_is_web_friendly_and_deterministic(self):
        a = minimal.tpms()
        self.assertTrue(10_000 < a.triangle_count() < 100_000, a.triangle_count())
        b = minimal.tpms()
        self.assertEqual(a.vertices, b.vertices)
        self.assertEqual(a.faces, b.faces)
        self.assertEqual(minimal.tpms('diamond', resolution=16).faces, minimal.tpms('schwarz_d', resolution=16).faces)

    def test_guards(self):
        for kwargs in ({'resolution': minimal.MAX_GRID + 1}, {'resolution': 3}, {'resolution': 20.5}, {'kind': 'nope'},
                       {'shape': 'cone'}, {'cells': 33}, {'size': (1, 0, 1)}, {'size': (1, float('inf'), 1)},
                       {'level': float('nan')}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                minimal.tpms(**kwargs)

    def test_marching_tetrahedra_on_a_random_field_is_watertight(self):
        # Smooth random field with saddles and exact level values on grid points (the nudge keeps vertices apart).
        rng = np.random.default_rng(4)
        g = np.linspace(0, 1, 25)
        x, y, z = np.meshgrid(g, g, g, indexing='ij')
        field = sum(np.sin(rng.uniform(2, 9) * (a * x + b * y + c * z) + rng.uniform(0, 6))
                    for a, b, c in rng.normal(size=(6, 3)))
        field[::3, ::3, ::3] = 0.1
        v, faces = _march.marching_tetrahedra(field, (0, 0, 0), (1 / 24,) * 3, 0.1)
        boundary = assert_two_per_edge(self, [tuple(f) for f in faces.tolist()], 'random field')
        on_border = np.any((v < 1e-12) | (v > 1 - 1e-12), axis=1)
        self.assertTrue(all(on_border[a] and on_border[b] for a, b in boundary))
        t = v[faces]
        area = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
        self.assertGreater(area.min(), 1e-12, 'no triangle collapsed onto a grid point')
        self.assertEqual(len(_march.marching_tetrahedra(np.ones((3, 3, 3)), (0, 0, 0), (1, 1, 1), 0.5)[1]), 0)


def mean_curvature(fn, u, v, h=1e-4):
    def x(a, b):
        return np.array(fn(a, b), dtype=float)
    xu, xv = (x(u + h, v) - x(u - h, v)) / (2 * h), (x(u, v + h) - x(u, v - h)) / (2 * h)
    xuu = (x(u + h, v) - 2 * x(u, v) + x(u - h, v)) / h ** 2
    xvv = (x(u, v + h) - 2 * x(u, v) + x(u, v - h)) / h ** 2
    xuv = (x(u + h, v + h) - x(u + h, v - h) - x(u - h, v + h) + x(u - h, v - h)) / (4 * h * h)
    n = np.cross(xu, xv)
    n /= np.linalg.norm(n)
    e, f, g = xu @ xu, xu @ xv, xv @ xv
    l, m, nn = xuu @ n, xuv @ n, xvv @ n
    return (e * nn - 2 * f * m + g * l) / (2 * (e * g - f * f)), (l * nn - m * m) / (e * g - f * f)


class ParametricTest(unittest.TestCase):
    def test_formulas_are_minimal(self):
        rng = np.random.default_rng(1)
        for kind, s in minimal.PARAMETRIC.items():
            for _ in range(25):
                u = s.u[0] + (s.u[1] - s.u[0]) * rng.uniform(0.1, 0.9)
                v = s.v[0] + (s.v[1] - s.v[0]) * rng.uniform(0.1, 0.9)
                h, k = mean_curvature(s.fn, u, v)
                self.assertLess(abs(h), 1e-5, kind)  # zero mean curvature: minimal
                self.assertLess(k, 1e-9, kind)       # hence saddle-shaped everywhere (K <= 0)

    def test_meshes(self):
        for kind, s in minimal.PARAMETRIC.items():
            m = minimal.parametric(kind, (20, 30))
            boundary = assert_manifold(self, m.faces)
            quads = sum(1 for f in m.faces if len(f) == 4)
            tris = sum(1 for f in m.faces if len(f) == 3)
            self.assertEqual((quads, tris), (19 * 30, 30) if s.pole_u0 else (20 * 30, 0), kind)
            rims = (1 if s.pole_u0 else 2) * 30 if s.wrap_v else 2 * (20 + 30)
            self.assertEqual(len(boundary), rims, f'{kind}: the seam is welded, the pole is one vertex')
            pts = np.array(m.vertices)
            self.assertTrue(np.all(np.isfinite(pts)), kind)

    def test_guards(self):
        for kwargs in ({'kind': 'nope'}, {'kind': 'enneper', 'resolution': (2000, 4)}, {'kind': 'enneper', 'resolution': 1},
                       {'kind': 'catenoid', 'resolution': (600, 600)}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                minimal.parametric(**kwargs)




def crossing_faces(v, f):
    """Pairs of faces that share no vertex and meet, touching included: a mesh that crosses itself. A separating-axis
    test (another method than minimal._crossing_faces', so neither checks itself): two triangles are apart only if their
    shadows on one of 17 axes (the two normals, the nine edge-edge crosses, and the six in-plane edge normals that part
    coplanar triangles) do not overlap. Faces are binned by their centres into cells twice the largest face, so faces
    whose boxes overlap fall in neighbouring cells."""
    f = np.asarray(f, dtype=np.int64)
    t = v[f]
    lo, hi = t.min(axis=1), t.max(axis=1)
    size = 2.0 * float((hi - lo).max())
    key = np.floor((t.mean(axis=1) - lo.min(axis=0)) / size).astype(np.int64)
    span = key.max(axis=0) + 3
    flat = (key[:, 0] * span[1] + key[:, 1]) * span[2] + key[:, 2]
    order = np.argsort(flat, kind='stable')
    keys = flat[order]
    found = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                other = flat + (dx * span[1] + dy) * span[2] + dz
                start, end = np.searchsorted(keys, other, 'left'), np.searchsorted(keys, other, 'right')
                i = np.repeat(np.arange(len(f)), end - start)
                j = order[np.concatenate([np.arange(s, e) for s, e in zip(start, end)])] if (end - start).sum() else np.zeros(0, np.int64)
                found.append(np.stack([i[i < j], j[i < j]], axis=1))
    pairs = np.unique(np.concatenate(found), axis=0)
    i, j = pairs[:, 0], pairs[:, 1]
    keep = np.all((lo[i] <= hi[j]) & (lo[j] <= hi[i]), axis=1) & ~(f[i][:, :, None] == f[j][:, None, :]).any(axis=(1, 2))
    i, j = i[keep], j[keep]
    A, B = t[i], t[j]
    ea, eb = np.roll(A, -1, axis=1) - A, np.roll(B, -1, axis=1) - B
    na, nb = np.cross(ea[:, 0], ea[:, 1]), np.cross(eb[:, 0], eb[:, 1])
    axes = [na, nb] + [np.cross(ea[:, x], eb[:, y]) for x in range(3) for y in range(3)] \
        + [np.cross(na, ea[:, x]) for x in range(3)] + [np.cross(nb, eb[:, y]) for y in range(3)]
    apart = np.zeros(len(i), dtype=bool)
    scale = float(np.abs(v).max()) or 1.0
    for axis in axes:
        length = np.linalg.norm(axis, axis=1)
        pa, pb = np.einsum('ikj,ij->ik', A, axis), np.einsum('ikj,ij->ik', B, axis)
        gap = 1e-12 * length * scale
        apart |= (length > 0) & ((pa.max(axis=1) < pb.min(axis=1) - gap) | (pb.max(axis=1) < pa.min(axis=1) - gap))
    return np.stack([i[~apart], j[~apart]], axis=1)


class SheetTest(unittest.TestCase):
    """sheet(): a TPMS sheet lattice as one closed solid (the ring a 2026-11-04 trial wrapped by hand from a thin
    gyroid slab came out a lumpy nugget)."""
    RING = dict(kind='gyroid', size=(2.25, 2.25, 0.75), cells=(12, 1, 2), thickness=0.055, resolution=96, shape='ring',
                inner=1.73, wrap=True)

    def closed(self, mesh, label):
        f = np.asarray(mesh.faces, dtype=np.int64)
        self.assertEqual(assert_two_per_edge(self, f, label), [], f'{label}: an open edge')
        self.assertGreater(mesh.volume(), 0.0, f'{label}: faces turned in')
        return f

    def test_a_wrapped_ring_is_one_closed_solid_inside_its_band_with_walls_of_the_thickness_asked(self):
        m = minimal.sheet(**self.RING)
        v, f = np.array(m.vertices), self.closed(m, 'ring')
        step = 2.25 / 96
        bound = minimal._sheet_bound('ring', v, self.RING['size'], self.RING['inner'], 0.0)
        self.assertLess(float(bound.max()), step, 'a vertex outside the band')
        # Away from the band's surface, every vertex lies half the wall from the TPMS surface: measured against the
        # surface itself (meshed twice as finely; its vertices half a cell apart make that reference a little far), not
        # |f| / |grad f|, which is off by half where f is large for its gradient.
        field = minimal._sheet_field('gyroid', self.RING['size'], self.RING['cells'], self.RING['inner'], True)
        origin, spacing, axes = minimal._sheet_grid(self.RING['size'], 192, 0.1)
        fine, _faces = _march.marching_tetrahedra(field(*np.meshgrid(*axes, indexing='ij')), origin, spacing, 0.0)
        r = np.hypot(fine[:, 0], fine[:, 1])
        fine = fine[(r > 0.765) & (r < 1.225)]
        deep = np.nonzero(bound < -4 * step)[0]
        self.assertGreater(len(deep), 1000)
        pick = np.random.default_rng(5).choice(deep, 120, replace=False)
        error = np.abs(np.array([np.sqrt(((fine - p) ** 2).sum(axis=1)).min() for p in v[pick]]) - 0.055 / 2)
        self.assertLess(float(error.max()), 0.6 * step, 'a wall off its thickness')
        self.assertLess(float(np.median(error)), 0.15 * step)
        # One part: the lattice holds together, across the wrap's seam too.
        self.assertEqual(len(np.unique(minimal._parts(len(v), f))), 1)
        # Between solid and empty: a lattice, not a tube with holes or a few struts.
        band = np.pi * (1.125 ** 2 - 0.865 ** 2) * 0.75
        self.assertTrue(0.15 < m.volume() / band < 0.6, m.volume() / band)

    def test_the_wrapped_field_closes_round_the_ring(self):
        for cells in ((12, 1, 2), (7, 2, 1)):
            field = minimal._sheet_field('schwarz_d', (2.25, 2.25, 0.75), cells, 1.73, True)
            r, z = np.linspace(0.87, 1.12, 9), np.linspace(-0.37, 0.37, 9)
            rr, zz = np.meshgrid(r, z)
            above = field(-rr.ravel(), np.full(rr.size, 1e-9), zz.ravel())
            below = field(-rr.ravel(), np.full(rr.size, -1e-9), zz.ravel())
            self.assertLess(float(np.abs(above - below).max()), 1e-6, cells)

    def test_every_shape_and_kind_closes(self):
        for kind in ('gyroid', 'schwarz_p', 'schwarz_d', 'iwp'):
            for shape in ('box', 'sphere', 'cylinder'):
                label = f'{kind} {shape}'
                m = minimal.sheet(kind, cells=(1, 1, 1), thickness=0.2, resolution=24, shape=shape)
                f = self.closed(m, label)
                assert_vertex_manifold(self, [tuple(x) for x in f.tolist()], label)
                bound = minimal._sheet_bound(shape, np.array(m.vertices), (2.0, 2.0, 2.0), 0.0, 0.0)
                self.assertLess(float(bound.max()), 2.0 / 24, f'{label}: a vertex outside')

    def test_crumbs_are_left_out_and_parts_are_counted_through_the_faces(self):
        two = np.array([[0, 1, 2], [0, 2, 3], [4, 5, 6]])
        self.assertEqual(minimal._parts(7, two).tolist(), [0, 0, 0, 0, 4, 4, 4])
        kept = minimal.sheet('gyroid', cells=(2, 2, 2), thickness=0.2, resolution=40, shape='sphere')
        every = minimal.sheet('gyroid', cells=(2, 2, 2), thickness=0.2, resolution=40, shape='sphere', min_part=0)
        f = np.asarray(kept.faces)
        self.assertEqual(len(np.unique(minimal._parts(len(kept.vertices), f))), 1)
        self.assertGreaterEqual(len(every.faces), len(kept.faces))

    def test_smoothing_keeps_the_volume_and_the_shape_and_never_crosses_the_mesh(self):
        raw = minimal.sheet(**dict(self.RING, smooth=0))
        smooth = minimal.sheet(**self.RING)
        self.assertEqual(raw.faces, smooth.faces)
        self.assertLess(abs(smooth.volume() / raw.volume() - 1.0), 0.02)
        # The saw teeth it irons out are about a grid cell high; nothing moves much further, most vertices along the
        # surface (the walls keep their thickness: the ring test above measures it on the smoothed mesh).
        moved = np.linalg.norm(np.array(smooth.vertices) - np.array(raw.vertices), axis=1)
        self.assertLess(float(moved.max()), 1.5 * 2.25 / 96, 'smoothing moved a vertex over 1.5 grid cells')
        self.assertLess(float(np.median(moved)), 0.3 * 2.25 / 96)
        self.assertEqual(minimal.sheet(**self.RING).vertices, smooth.vertices, 'the same arguments, the same mesh')
        # Review round 7: smoothing folded two sheets a hair apart (0.005 cell, in a neck) through each other. Those
        # vertices now keep their marched places, and the mesh crosses itself nowhere (checked independently here).
        raw = minimal.sheet('split_p', cells=0.75, thickness=1 / 3, resolution=12, smooth=0)
        v, f = np.array(raw.vertices), np.array(raw.faces, dtype=np.int64)
        self.assertGreater(len(crossing_faces(minimal._taubin(v, f, 12), f)), 0, 'smoothing alone crosses this mesh')
        coarse = minimal.sheet('split_p', cells=0.75, thickness=1 / 3, resolution=12)
        self.assertEqual(coarse.faces, raw.faces)
        self.assertEqual(len(crossing_faces(np.array(coarse.vertices), f)), 0)
        self.assertGreater(int(np.count_nonzero(np.any(np.array(coarse.vertices) != v, axis=1))), len(v) // 2, 'most of it is smoothed')
        # Both checkers find a crossing: two triangles through each other, and two squares crossing exactly along their
        # triangulations' diagonals, where every edge meets the other square on a border or a corner (review round 8);
        # and none when they are apart.
        two = np.array([(0, 1, 2), (3, 4, 5)])
        v = np.array([(0, 0, 0), (1, 0, 0), (0, 1, 0), (0.2, 0.2, -0.5), (0.3, 0.2, 0.5), (0.2, 0.3, 0.5)], dtype=np.float64)
        self.assertEqual(crossing_faces(v, two).tolist(), [[0, 1]])
        self.assertEqual(minimal._crossing_faces(v, two, 0.25).tolist(), [True, True])
        squares = np.array([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0), (-1, -1, -1), (1, 1, -1), (1, 1, 1), (-1, -1, 1)], dtype=np.float64)
        four = np.array([(0, 1, 2), (0, 2, 3), (4, 5, 6), (4, 6, 7)])
        self.assertEqual(minimal._crossing_faces(squares, four, 0.25).tolist(), [True, True, True, True])
        self.assertGreater(len(crossing_faces(squares, four)), 0)
        for points, faces in ((v, two), (squares, four)):
            apart = points.copy()
            apart[len(points) // 2:, 0] += 3.0
            self.assertFalse(minimal._crossing_faces(apart, faces, 0.25).any())
            self.assertEqual(len(crossing_faces(apart, faces)), 0)
        # Smoothing does not iron a small part away (review round 8: eight blobs of a coarse lattice lost 87 % of their
        # volume): each keeps its marched shape instead.
        blobs = dict(kind='schwarz_p', cells=0.6, thickness=1 / 3, resolution=12, shape='box')
        self.assertLess(abs(minimal.sheet(**blobs).volume() / minimal.sheet(**dict(blobs, smooth=0)).volume() - 1.0), minimal.SHRINK)

    def test_the_crossing_check_is_exact_and_finds_every_pair_at_any_cell_size(self):
        two = np.array([(0, 1, 2), (3, 4, 5)])
        # Review round 9: a sliver's edge just inside the other triangle, where a computed crossing point came out just
        # past the sliver's border.
        sliver = np.array([(-.21161032479550662, .16657000842229835, .018807372085582474),
                           (.083454766368102, -.26698615243802243, .12275894955778015),
                           (.014377412804312146, -.1654868278174748, .0984229707412626),
                           (-.03863635484958269, -.011630561529345412, .15946523122830142),
                           (-.08951920357782192, -.08878558248637866, -.01789890958493877),
                           (-.08846409160077119, -.08739890980662018, -.014445066109486468)])
        self.assertEqual(crossing_faces(sliver, two).tolist(), [[0, 1]])
        self.assertEqual(minimal._crossing_faces(sliver, two, 0.1).tolist(), [True, True])
        # Round 10: an edge crossing a sliver a millionth wide at a hundred-thousandth of a radian, strictly inside it
        # (every barycentric weight over 0.24): a crossing point computed from the plane's normal lands 1e-5 off.
        b, r = np.array([.7, .9, 1.1]), np.array([.3, -.5, .8])
        c = .8 * b + 1e-6 * r
        x, d = (b + c) / 4, r + 1e-5 * np.cross(b, r)
        shallow = np.array([np.zeros(3), b, c, x + d, x - d, x + [0, 1e-6, 0]])
        self.assertEqual(minimal._crossing_faces(shallow, two, 0.25).tolist(), [True, True])
        # Two triangles in one plane with edges on one line: apart where the edges do not overlap (round 9 counted them
        # as touching), touching where they overlap or meet end to end; and apart when a short edge across the line
        # stands beyond the end of the other (round 10 compared their spans only along the short edge).
        flat = np.array([(0, 0, 0), (1, 0, 0), (0, 1, 0), (2, 0, 0), (3, 0, 0), (0.5, -1, 0)], dtype=np.float64)
        for start, meets in ((2.0, False), (0.5, True), (1.0, True)):
            flat[3, 0] = start
            self.assertEqual(len(crossing_faces(flat, two)) > 0, meets, start)
            self.assertEqual(minimal._crossing_faces(flat, two, 0.25).tolist(), [meets, meets], start)
        stub = np.array([(0, 0, 0), (1, 0, 0), (0, 1, 0), (2, 0, 0), (2, 1e-7, 0), (0.5, -1, 0)], dtype=np.float64)
        self.assertEqual(len(crossing_faces(stub, two)), 0)
        self.assertEqual(minimal._crossing_faces(stub, two, 0.25).tolist(), [False, False])
        # A triangle with no area is a segment: one through the other's middle meets it; one beside it does not.
        line = np.array([(0, 0, 0), (1, 0, 0), (0, 1, 0), (0.2, 0.2, -1), (0.2, 0.2, 1), (0.2, 0.2, 0.5)], dtype=np.float64)
        self.assertEqual(minimal._crossing_faces(line, two, 0.25).tolist(), [True, True])
        line[3:, 0] += 2.0
        self.assertEqual(minimal._crossing_faces(line, two, 0.25).tolist(), [False, False])
        # Round 11: two needles (areas rounding cannot tell from 0) whose long edges cross at the origin; moved apart,
        # they do not meet.
        needles = np.array([(-1, -1, 0), (1, 1, 0), (0, 2e-16, 0), (-1, 1, 0), (1, -1, 0), (0, -2e-16, 0)], dtype=np.float64)
        self.assertEqual(minimal._crossing_faces(needles, two, 0.25).tolist(), [True, True])
        needles[3:, 2] += 0.5
        self.assertEqual(minimal._crossing_faces(needles, two, 0.25).tolist(), [False, False])
        # Round 11: a triangle inside another, both at 2^-357 metres, where products underflow: still a meeting.
        h = 2.0 ** -357
        s = h * np.array([[0., 0., 0.], [1., 1., 1.], [3., -1., -3.]])
        t = h * np.array([[1., 0., -.5], [1.25, .25, -.25], [1.75, -.25, -1.25]])
        self.assertEqual(minimal._faces_meet(s[None], t[None]).tolist(), [True])
        # Round 13: a vertex strictly inside the other triangle, where a product of differences 2^-538 apart underflows
        # and the rest of the determinant came out with the wrong sign, sure-looking: these rows are worked in integers.
        b = 2.0 ** -538
        s = np.array([[0., 0., 0.], [1., 2 * b, 0.], [-1., 2 * b, 0.]])
        t = np.array([[1., 0., 2.0 ** 80], [b, b, 0.], [0., b, -2.0 ** -459]])
        self.assertEqual(minimal._crossing_faces(np.vstack([s, t]), two, 2.0 ** 80).tolist(), [True, True])
        self.assertEqual(minimal._faces_meet(t[None], s[None]).tolist(), [True])
        # Round 12: a triangle 1.4 long and 1e-16 wide, whose area the fast filter cannot be sure of, with an edge
        # through its inside that meets none of its edges: a meeting, whichever face comes first.
        h, k, d = 2.0 ** -26, 2.0 ** 26, 2.0 ** -30
        sliver = h * np.array([[0, 0, 0], [1, 1, 0], [k, k + 1, 0]], dtype=np.float64)
        through = h * np.array([[.25, .25 + d, -1], [.25, .25 + d, 1], [.375, .375 + d, 0]], dtype=np.float64)
        self.assertEqual(minimal._crossing_faces(np.vstack([sliver, through]), two, 1.0).tolist(), [True, True])
        self.assertEqual(minimal._crossing_faces(np.vstack([through, sliver]), two, 1.0).tolist(), [True, True])
        self.assertEqual(minimal._plane(sliver[None])[0].tolist(), [True], 'it has area, if very little')
        through[:, 0] += 4 * h
        self.assertEqual(minimal._crossing_faces(np.vstack([sliver, through]), two, 1.0).tolist(), [False, False])
        # Each pair is tested in the first cell the two share: with cells far smaller than the faces (a pair in many
        # cells) or larger, the check finds exactly the faces the separating-axis checker finds on a smoothed mesh that
        # crosses itself.
        raw = minimal.sheet('split_p', cells=0.75, thickness=1 / 3, resolution=12, smooth=0)
        f = np.array(raw.faces, dtype=np.int64)
        v = minimal._taubin(np.array(raw.vertices), f, 12)
        expected = np.zeros(len(f), dtype=bool)
        expected[crossing_faces(v, f).ravel()] = True
        self.assertGreater(int(expected.sum()), 0)
        for cell in (0.02, 1 / 6, 0.5):
            self.assertEqual(minimal._crossing_faces(v, f, cell).tolist(), expected.tolist(), cell)

    def test_bad_arguments_are_refused_before_any_work(self):
        cases = [
            (dict(kind='nope'), 'unknown TPMS kind'), (dict(shape='torus'), 'unknown shape'),
            (dict(thickness=0.0), 'thickness'), (dict(thickness=float('nan')), 'thickness'),
            (dict(resolution=4), 'resolution'), (dict(resolution=161), 'beyond the maximum'),
            (dict(shape='ring'), 'inner diameter'), (dict(shape='ring', inner=2.0), 'inner diameter'),
            (dict(inner=0.5), "only shape='ring'"), (dict(wrap=True), "use shape='ring'"),
            (dict(shape='ring', inner=1.0, wrap=True, cells=(2.5, 1, 1)), 'whole number'),
            (dict(cells=(20, 2, 2)), 'too coarse'), (dict(thickness=0.01), 'needs a grid'),
            (dict(min_part=2.0), 'min_part'), (dict(smooth=-1), 'smooth'), (dict(smooth=1.5), 'smooth'), (dict(smooth=101), 'smooth'),
            # A wrapped ring whose band reaches the axis's singular field within its walls' reach (review round 7).
            (dict(size=2.0, cells=(1, 0.3, 2), thickness=0.38, resolution=96, shape='ring', inner=0.25, wrap=True), 'hole wider'),
            (dict(cells=(33, 1, 1)), 'beyond the maximum'),
            # A band too thin for the grid or a wall vanished whole once (inner 1.99 of 2: 5 mm of band, 94 mm rounding).
            (dict(shape='ring', inner=1.99), 'at its thinnest'), (dict(shape='cylinder', size=(2.0, 2.0, 0.1), cells=(2, 2, 0.05)), 'at its thinnest'),
            (dict(size=(1e-7, 1e-7, 1e-7), thickness=1e-8), 'at least'),
            # Subnormal cells underflowed the field to nothing and gave an empty mesh in silence; a box the surface
            # never crosses says so.
            (dict(cells=1e-322), 'cells must be at least'),
            (dict(kind='schwarz_p', size=1000.0, cells=0.02, thickness=100.0, resolution=20), 'no lattice lies inside'),
            # A wall of half a period fills the lattice; a thick wall at a fine grid would outgrow the work budget (a
            # 327-point grid and 83 rounds once: about 1,000 s).
            (dict(cells=2, thickness=0.5), 'fills a lattice'),
            (dict(size=2.0, cells=0.01, thickness=2.0, resolution=160), 'beyond'),
        ]
        for arguments, message in cases:
            with self.assertRaisesRegex(ValueError, message, msg=str(arguments)):
                minimal.sheet(**arguments)

    def test_a_sheet_is_the_same_at_any_scale(self):
        # The gradient once overflowed at small sizes (squared): a box of 1e-160 m came out nearly solid.
        ratios = []
        for s in (1.0, 1e-5):
            m = minimal.sheet('gyroid', size=(s, s, s), cells=1, thickness=0.1 * s, resolution=24, smooth=0)
            ratios.append(m.volume() / s ** 3)
        # Rounding apart (a few parts in a million): the overflow made it 3.7 times as much.
        self.assertAlmostEqual(ratios[1] / ratios[0], 1.0, places=4)

    def wall_at(self, point, kind, size, cells, thickness, resolution, inner=0.0, wrap=False):
        """The wall field at a node of the grid sheet() builds (the point must be one)."""
        size = minimal._triple(size, 'size')
        spacing, _counts = minimal._sheet_spacing(size, resolution)
        origin, spacing, axes = minimal._sheet_grid(size, resolution, minimal._wall_reach(spacing, thickness))
        index = []
        for a, c in enumerate(point):
            i = int(round((c - origin[a]) / spacing[a]))
            self.assertAlmostEqual(float(axes[a][i]), c, places=9, msg=f'{point} is not a grid node')
            index.append(i)
        gx, gy, gz = np.meshgrid(*axes, indexing='ij')
        field = minimal._sheet_field(kind, size, minimal._triple(cells, 'cells'), inner, wrap)
        return float(minimal._sheet_wall(field, gx, gy, gz, spacing, thickness)[tuple(index)])

    def test_the_wall_is_measured_so_no_critical_point_leaves_a_hole_or_fills_a_channel(self):
        # Each point's distance to the nearest zero, found by bisection along the line to that zero (review rounds 2-3).
        # Lidinoid: f = 0.15 and no gradient at (-0.25, 0, 0.5) in a 2 m box of one cell, 0.139 from a zero: inside a
        # 0.3 wall, which |f| / |grad f| alone left out.
        self.assertLess(self.wall_at((-0.25, 0.0, 0.5), 'lidinoid', 2.0, 1, 0.3, 40), 0.0)
        # Schwarz P's channel: (0, 0.5, 0) has f = 1 and no gradient, 0.2357 from the nearest zero: outside a 0.4 wall,
        # which a floor under the gradient filled.
        self.assertGreater(self.wall_at((0.0, 0.5, 0.0), 'schwarz_p', 2.0, 2, 0.4, 64), 0.02)
        # Stretched cells and the wrap: zeros 0.0373 and 0.0437 away, inside walls of 0.1 and 0.12.
        self.assertLess(self.wall_at((-0.25, 0.0, 0.125), 'lidinoid', 2.0, (1, 1, 4), 0.1, 64), 0.0)
        self.assertLess(self.wall_at((0.5, -0.5, 0.5), 'lidinoid', 2.0, 1, 0.12, 64, inner=2 * 2 ** 0.5 - 2, wrap=True), 0.0)
        # A patch no grid point sees within a cell to first order (split P at the coarsest grid it takes): its crossings
        # along the cube's diagonals seed it. The origin is 0.1225 from it, inside a 1/3 wall.
        self.assertLess(self.wall_at((0.0, 0.0, 0.0), 'split_p', 2.0, 2, 1 / 3, 12), 0.0)
        # Stretched split P (review round 5): a Newton step from a grid point near (-4/9, -4/9, 0) landed where f is
        # -0.95 and gave it a distance of 0.023, filling its channel; the nearest zero is 0.2134 away, outside a wall of 2/9.
        self.assertGreater(self.wall_at((-4 / 9, -4 / 9, 0.0), 'split_p', 2.0, (3, 0.2, 1), 2 / 9, 18), 0.08)
        # A patch a grid segment crosses in and out (review round 6): along y = -1/3, z = 0, f is -0.1 at x = 7/9 and 8/9
        # and +0.22 between, so no crossing is found there; Newton's method from either end finds its zero 0.0104 away.
        self.assertLess(self.wall_at((7 / 9, -1 / 3, 0.0), 'lidinoid', 2.0, (3, 0.5, 0.5), 2 / 9, 18), -0.09)
        # sheet() itself refuses that grid: lidinoid's waves at twice its period have 3 grid cells each there.
        with self.assertRaisesRegex(ValueError, 'waves at twice its period'):
            minimal.sheet('lidinoid', size=2, cells=(3, 0.5, 0.5), thickness=2 / 9, resolution=18)
        # A Newton step that is not on the surface after three takes more (review round 7: stretched split P, an accepted
        # grid; the node is 0.253 from a zero, inside a wall of 0.6, and three steps left it outside).
        self.assertLess(self.wall_at((1 / 3, -1 / 3, -1 / 3), 'split_p', 2.0, (0.01, 0.215, 1), 0.6, 12), 0.0)

    def test_no_measured_distance_is_shorter_than_the_true_one(self):
        # Every foot is a point of the surface, so a distance can only be a little long, never short: on fields stretched
        # as far as sheet() takes them, against a brute force over the surface meshed far more finely.
        for kind, cells, resolution in (('split_p', (3, 0.2, 1), 18), ('gyroid', (1, 3, 0.5), 36), ('lidinoid', (1, 1, 4), 64)):
            size, reach = (2.0, 2.0, 2.0), 0.3
            origin, spacing, axes = minimal._sheet_grid(size, resolution, reach)
            gx, gy, gz = np.meshgrid(*axes, indexing='ij')
            field = minimal._sheet_field(kind, size, cells, 0.0, False)
            measured = minimal._surface_distance(field, gx, gy, gz, spacing, reach).ravel()
            fine_origin, fine_spacing, fine_axes = minimal._sheet_grid(size, 200, 0.4)
            fine, _faces = _march.marching_tetrahedra(field(*np.meshgrid(*fine_axes, indexing='ij')), fine_origin, fine_spacing, 0.0)
            points = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
            inside = np.all(np.abs(points) <= 1.0, axis=1)
            near = np.nonzero((measured < 0.25) & inside)[0]
            pick = np.random.default_rng(7).choice(near, min(300, len(near)), replace=False)
            truth = np.array([np.sqrt(((fine - p) ** 2).sum(axis=1)).min() for p in points[pick]])
            step = float(spacing.max())
            # The fine surface's vertices make the brute force a little long itself (at most about half its cell).
            short = truth - measured[pick] - 0.5 * float(fine_spacing.max())
            self.assertLess(float(short.max()), 0.01 * step, f'{kind} {cells}: a distance shorter than the truth')
            self.assertLess(float(np.median(np.abs(measured[pick] - truth))), 0.1 * step, f'{kind} {cells}')

    def test_the_measured_distance_matches_a_brute_force_one(self):
        size, cells, resolution, reach = (2.0, 2.0, 2.0), (1, 1, 1), 32, 0.3
        origin, spacing, axes = minimal._sheet_grid(size, resolution, reach)
        gx, gy, gz = np.meshgrid(*axes, indexing='ij')
        field = minimal._sheet_field('gyroid', size, cells, 0.0, False)
        measured = minimal._surface_distance(field, gx, gy, gz, spacing, reach).ravel()
        fine = np.array(minimal.tpms('gyroid', size=4.0, cells=2, resolution=160).vertices)
        points = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
        # Points in the box: the grid reaches past it as far as the distance is measured, as sheet()'s does.
        inside = np.all(np.abs(points) <= 1.0, axis=1)
        pick = np.random.default_rng(3).choice(np.nonzero((measured < 0.25) & inside)[0], 400, replace=False)
        truth = np.array([np.sqrt(((fine - p) ** 2).sum(axis=1)).min() for p in points[pick]])
        step = float(spacing.max())
        # The fine surface's vertices stand a hundredth of a metre apart: the brute force is that much too far at most.
        self.assertLess(float(np.abs(measured[pick] - truth).max()), 0.3 * step)
        self.assertLess(float(np.median(np.abs(measured[pick] - truth))), 0.05 * step)
        # Beyond the reach, the reach itself.
        self.assertLessEqual(float(measured.max()), reach)

    def test_a_cavity_keeps_its_wall_while_crumbs_go(self):
        def cube(centre, half, inward=False):
            m = box(centre, ((1, 0, 0), (0, 1, 0), (0, 0, 1)), (half, half, half))
            faces = [tuple(reversed(f)) if inward else tuple(f) for f in m.faces]
            return np.array(m.vertices, dtype=np.float64), [(f[0], f[i], f[i + 1]) for f in faces for i in range(1, len(f) - 1)]
        def tetra(centre, size, inward=False):
            corners = np.array([(1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1)], dtype=np.float64) * size + np.array(centre)
            faces = [(0, 1, 2), (0, 2, 3), (0, 3, 1), (1, 3, 2)]
            return corners, [tuple(reversed(f)) for f in faces] if inward else faces
        # A part of 12 triangles with a cavity, a crumb of 4, and a crumb of 4 with a cavity of its own.
        parts = [cube((0, 0, 0), 1.0), cube((0, 0, 0), 0.3, inward=True), tetra((5, 0, 0), 0.2),
                 tetra((9, 0, 0), 0.4), tetra((9, 0, 0), 0.1, inward=True)]
        vertices, faces = [], []
        for v, f in parts:
            faces += [tuple(i + len(vertices) for i in face) for face in f]
            vertices += v.tolist()
        vertices, faces = np.array(vertices), np.array(faces)
        volumes = [minimal.Mesh([tuple(x) for x in v.tolist()], f).volume() for v, f in parts]
        self.assertEqual([value > 0 for value in volumes], [True, False, True, True, False])
        kept = minimal._closed_parts(vertices, faces, min_part=0.5)
        # The big part and its cavity stay; the crumbs go, and so does the cavity inside one of them.
        self.assertEqual(len(kept), 24)
        self.assertEqual(sorted({round(float(np.abs(vertices[i]).max()), 6) for i in kept.ravel()}), [0.3, 1.0])
        # Nested shells: a crumb (a tetrahedron) round a void, in the void a kept part (a cube) with its own cavity. The
        # cavity belongs to the cube right round it, not to the crumb, and stays with it; the crumb's own wall goes.
        nested = [tetra((0, 0, 0), 2.0), tetra((0, 0, 0), 1.0, inward=True), cube((0, 0, 0), 0.2), cube((0, 0, 0), 0.1, inward=True)]
        vertices, faces = [], []
        for v, f in nested:
            faces += [tuple(i + len(vertices) for i in face) for face in f]
            vertices += v.tolist()
        vertices, faces = np.array(vertices), np.array(faces)
        kept = minimal._closed_parts(vertices, faces, min_part=0.5)
        self.assertEqual(len(kept), 24)
        self.assertEqual(sorted({round(float(np.abs(vertices[i]).max()), 6) for i in kept.ravel()}), [0.1, 0.2])
        # A real sheet: every inward shell the unfiltered mesh has, the filtered one keeps.
        every = minimal.sheet('neovius', cells=1, thickness=0.8, resolution=24, smooth=0, min_part=0)
        kept = minimal.sheet('neovius', cells=1, thickness=0.8, resolution=24, smooth=0)
        def inward(mesh):
            v, f = np.array(mesh.vertices), np.array(mesh.faces)
            label = minimal._parts(len(v), f)[f[:, 0]]
            t = v[f]
            volume = np.einsum('ij,ij->i', t[:, 0], np.cross(t[:, 1], t[:, 2])) / 6.0
            return sorted(round(float(volume[label == part].sum()), 9) for part in np.unique(label) if volume[label == part].sum() < 0)
        self.assertEqual(len(inward(every)), 1, 'neovius leaves a cavity at this wall')
        self.assertEqual(inward(kept), inward(every))

    def test_a_ray_through_an_edge_or_a_corner_still_tells_inside_from_outside(self):
        def cube(centre, half, subdivide=False):
            m = box(centre, ((1, 0, 0), (0, 1, 0), (0, 0, 1)), (half, half, half))
            v = [tuple(x) for x in m.vertices]
            faces = [(f[0], f[i], f[i + 1]) for f in m.faces for i in range(1, len(f) - 1)]
            if subdivide:
                split = []
                for a, b, c in faces:
                    v.append(tuple(np.mean(np.array([v[a], v[b], v[c]]), axis=0)))
                    split += [(a, b, len(v) - 1), (b, c, len(v) - 1), (c, a, len(v) - 1)]
                faces = split
            return np.array(v, dtype=np.float64), np.array(faces)
        v, f = cube((-0.5, -0.5, -0.5), 0.5)
        triangles = v[f]
        ray = minimal.RAYS[0]
        # The first ray from each point passes through a corner or along an edge the cube's triangles share (review
        # round 5: a corner's six triangles were all counted).
        cases = [(-ray, True), (np.array([0.0, 0.0, -0.5]) - 0.3 * ray, True), (-2.0 * ray, False),
                 (np.array([-0.5, -0.5, 0.0]) - 0.4 * ray, True), (np.array([-1.0, -1.0, -1.0]) - 0.5 * ray, False)]
        for point, inside in cases:
            self.assertIsNone(minimal._crossings(triangles, point, ray, 2.0), point)
            self.assertEqual(minimal._encloses(triangles, np.array([point])), inside, point)
        # A part of 36 triangles, a crumb of 12 and, inside the crumb, a cavity whose first vertex sends the first ray
        # through the crumb's corner: the crumb goes with its cavity.
        main, crumb = cube((4.0, 0.0, 0.0), 1.0, subdivide=True), cube((-0.5, -0.5, -0.5), 0.5)
        corners = np.array([(1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1)], dtype=np.float64) * 0.05 + (-ray - 0.05)
        cavity = (corners, np.array([(0, 2, 1), (0, 3, 2), (0, 1, 3), (1, 2, 3)]))
        vertices, faces, offset = [], [], 0
        for part_v, part_f in (main, crumb, cavity):
            vertices.append(part_v)
            faces.append(part_f + offset)
            offset += len(part_v)
        kept = minimal._closed_parts(np.concatenate(vertices), np.concatenate(faces), min_part=0.5)
        self.assertEqual(len(kept), 36)
        self.assertTrue((kept < len(main[0])).all(), 'the crumb or its cavity stayed')

if __name__ == '__main__':
    unittest.main()
