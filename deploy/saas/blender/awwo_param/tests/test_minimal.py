import unittest

import numpy as np

from awwo_param import _march, minimal

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


if __name__ == '__main__':
    unittest.main()
