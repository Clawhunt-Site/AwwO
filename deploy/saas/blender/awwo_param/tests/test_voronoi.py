import math
import random
import unittest

import numpy as np

from awwo_param import voronoi
from awwo_param.geometry import Curves, Mesh

from ._checks import area2d, assert_manifold, boundary_loops, contains, coverage, face_area2d, face_normals

BOUNDS = (0.0, 0.0, 4.0, 3.0)


class CellsTest(unittest.TestCase):
    def test_cells_are_the_voronoi_cells(self):
        sites = voronoi.random_points(300, BOUNDS, seed=7)
        cells = voronoi.voronoi_cells(sites, BOUNDS)
        self.assertEqual(len(cells), 300)
        self.assertAlmostEqual(sum(area2d(c) for c in cells), 12.0, delta=12.0 * 1e-9)
        s = np.array(sites)
        for i, cell in enumerate(cells):
            n = len(cell)
            for k in range(n):  # convex and counter-clockwise: every turn is to the left
                (ax, ay), (bx, by), (cx, cy) = cell[k - 1], cell[k], cell[(k + 1) % n]
                self.assertGreaterEqual((bx - ax) * (cy - by) - (by - ay) * (cx - bx), -1e-12)
            self.assertTrue(contains(cell, *sites[i]), i)
            for x, y in cell:  # each corner is at least as near its own site as any other
                d = np.hypot(s[:, 0] - x, s[:, 1] - y)
                self.assertLessEqual(d[i], d.min() + 1e-9)
                self.assertTrue(-1e-12 <= x <= 4 + 1e-12 and -1e-12 <= y <= 3 + 1e-12)

    def test_periodic_cells_tile_a_strip(self):
        sites = voronoi.random_points(80, BOUNDS, seed=2, periodic=True)
        cells = voronoi.voronoi_cells(sites, BOUNDS, periodic=True)
        self.assertAlmostEqual(sum(area2d(c) for c in cells), 12.0, delta=1e-9)
        self.assertTrue(any(min(x for x, _y in c) < 0 or max(x for x, _y in c) > 4 for c in cells))
        rng = random.Random(3)
        for _ in range(300):
            x, y = rng.uniform(0, 4), rng.uniform(0, 3)
            hits = sum(contains(c, x + dx, y) for c in cells for dx in (-4.0, 0.0, 4.0))
            self.assertEqual(hits, 1)

    def test_lloyd_relaxation_evens_the_cells(self):
        def spread(relax):
            cells = voronoi.voronoi_cells(voronoi.random_points(120, BOUNDS, seed=5, relax=relax), BOUNDS)
            areas = np.array([area2d(c) for c in cells])
            return areas.std() / areas.mean()
        self.assertLess(spread(5), 0.5 * spread(0))

    def test_determinism_and_guards(self):
        self.assertEqual(voronoi.random_points(50, BOUNDS, seed=1, relax=2), voronoi.random_points(50, BOUNDS, seed=1, relax=2))
        self.assertNotEqual(voronoi.random_points(50, BOUNDS, seed=1), voronoi.random_points(50, BOUNDS, seed=2))
        for call in (lambda: voronoi.random_points(voronoi.MAX_SITES + 1, BOUNDS),
                     lambda: voronoi.voronoi_cells([(1, 1), (1, 1)], BOUNDS),
                     lambda: voronoi.voronoi_cells([(5, 1)], BOUNDS),
                     lambda: voronoi.voronoi_cells([(1, 1)], (0, 0, -1, 1)),
                     lambda: voronoi.perforated_panel(frame=2.0)):
            with self.assertRaises(ValueError):
                call()


class PanelTest(unittest.TestCase):
    def check_panel(self, m, width, height, periodic=False):
        boundary = assert_manifold(self, m.faces)
        self.assertTrue(boundary)
        self.assertTrue(all(face_area2d(m, f) > 0 for f in m.faces), 'every face counter-clockwise')
        loops = [area2d([m.vertices[i][:2] for i in loop]) for loop in boundary_loops(m.faces)]
        holes = [a for a in loops if a < 0]
        outer = [a for a in loops if a > 0]
        self.assertEqual(len(outer), 1)
        self.assertAlmostEqual(outer[0], width * height, delta=1e-9)
        # The faces cover the panel minus its holes exactly once.
        self.assertAlmostEqual(sum(face_area2d(m, f) for f in m.faces), width * height + sum(holes), delta=1e-9)
        rng = random.Random(1)
        samples = [(rng.uniform(0, width), rng.uniform(0, height)) for _ in range(400)]
        self.assertLessEqual(max(coverage(m, samples)), 1, 'no two faces overlap')
        return holes

    def test_random_panel(self):
        m = voronoi.perforated_panel(4.0, 3.0, cells=60, frame=0.06, seed=0)
        holes = self.check_panel(m, 4.0, 3.0)
        self.assertGreater(len(holes), 50)
        self.assertEqual(m.bounds(), ((0.0, 0.0, 0.0), (4.0, 3.0, 0.0)))

    def test_grid_sites_give_exact_frames(self):
        # Sites on a 4 x 3 grid: cells are 1 x 1 squares (four cells meet at each corner), holes inset by
        # frame / 2 between cells and by frame along the rim.
        sites = [(i + 0.5, j + 0.5) for i in range(4) for j in range(3)]
        f = 0.1
        m = voronoi.perforated_panel(4.0, 3.0, frame=f, sites=sites)
        holes = self.check_panel(m, 4.0, 3.0)

        def bars(i, n):  # the bar width taken from both sides of a 1 m cell, i of n along an axis
            return (f if i == 0 else f / 2) + (f if i == n - 1 else f / 2)
        expected = sum((1 - bars(i, 4)) * (1 - bars(j, 3)) for i in range(4) for j in range(3))
        self.assertEqual(len(holes), 12)
        self.assertAlmostEqual(-sum(holes), expected, delta=1e-9)

    def test_tiny_cells_stay_solid(self):
        m = voronoi.perforated_panel(1.0, 1.0, cells=400, frame=0.06, seed=3)
        self.check_panel(m, 1.0, 1.0)
        self.assertTrue(any(len(f) > 4 for f in m.faces), 'some cells too small to inset')

    def test_periodic_panel_wraps_seamlessly(self):
        m = voronoi.perforated_panel(2 * math.pi, 3.0, cells=50, frame=0.08, seed=4, periodic=True)
        tube = voronoi.wrap(m, 'cylinder', radius=1.0, size=(2 * math.pi, 3.0), weld=True)
        assert_manifold(self, tube.faces)
        v = np.array(tube.vertices)
        heights = [v[loop, 2] for loop in boundary_loops(tube.faces)]
        # The open edges are the bottom rim, the top rim and the holes: an unwelded seam would join the rims
        # into one loop running up and down it.
        self.assertEqual(sum(1 for z in heights if np.all(np.abs(z) < 1e-9)), 1)
        self.assertEqual(sum(1 for z in heights if np.all(np.abs(z - 3.0) < 1e-9)), 1)
        self.assertTrue(all(np.all((z > 1e-9) & (z < 3 - 1e-9)) for z in heights
                            if not (np.all(np.abs(z) < 1e-9) or np.all(np.abs(z - 3.0) < 1e-9))))
        self.assertEqual(len(heights), 2 + 50 - sum(1 for f in tube.faces if len(f) > 4))
        self.assertLess(len(tube.vertices), len(m.vertices))
        self.assertTrue(np.allclose(np.hypot(v[:, 0], v[:, 1]), 1.0))


class WrapTest(unittest.TestCase):
    def test_cylinder_sphere_and_callable(self):
        flat = voronoi.perforated_panel(4.0, 2.0, cells=30, frame=0.05, seed=1)
        flat = Mesh([(x, y, 0.1 if i % 2 else 0.0) for i, (x, y, _z) in enumerate(flat.vertices)], flat.faces)
        cyl = voronoi.wrap(flat, 'cylinder', radius=2.0, height=5.0)
        for (x, y, z), (fx, fy, fz) in zip(cyl.vertices, flat.vertices):
            self.assertAlmostEqual(math.hypot(x, y), 2.0 + fz)
            self.assertAlmostEqual(z, fy / 2.0 * 5.0)
            turn = math.atan2(y, x) - 2 * math.pi * fx / 4.0
            self.assertAlmostEqual((turn + math.pi) % (2 * math.pi) - math.pi, 0.0, delta=1e-9)
        sph = voronoi.wrap(flat, 'sphere', radius=1.5)
        for (x, y, z), (_fx, _fy, fz) in zip(sph.vertices, flat.vertices):
            self.assertAlmostEqual(math.sqrt(x * x + y * y + z * z), 1.5 + fz)
        plane = voronoi.wrap(flat, lambda u, v: (4.0 * u, 2.0 * v, 0.0))
        for p, q in zip(plane.vertices, flat.vertices):
            self.assertTrue(np.allclose(p, q))
        # Faces that faced +z face outward.
        n, c = face_normals(voronoi.wrap(voronoi.perforated_panel(4.0, 2.0, cells=30, frame=0.05, seed=1), 'cylinder'))
        self.assertTrue(np.all((n[:, :2] * c[:, :2]).sum(axis=1) > 0))

    def test_curves_and_guards(self):
        line = Curves([[(0.0, 0.0, 0.0), (1.0, 1.0, 0.0)]], [False])
        out = voronoi.wrap(line, 'cylinder', radius=1.0, size=(1.0, 1.0))
        self.assertTrue(np.allclose(out.polylines[0][1], (1.0, 0.0, 1.0)))
        with self.assertRaises(ValueError):
            voronoi.wrap(line, 'cone')


if __name__ == '__main__':
    unittest.main()
