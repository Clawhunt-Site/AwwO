import math
import random
import unittest

from awwo_param import icecrack

from ._checks import angle_deg, area2d, assert_manifold, contains


def corner_angles(poly):
    n = len(poly)
    return [angle_deg(poly[k - 1], poly[k], poly[(k + 1) % n]) for k in range(n)]


class IceCrackTest(unittest.TestCase):
    def test_cells_tile_the_rectangle(self):
        for cells, seed in ((40, 0), (150, 3)):
            polys = icecrack.ice_crack(2.0, 1.5, cells, seed)
            self.assertEqual(len(polys), cells)
            self.assertAlmostEqual(sum(area2d(p) for p in polys), 3.0, delta=1e-9)
            rng = random.Random(seed)
            for _ in range(400):
                x, y = rng.uniform(0, 2), rng.uniform(0, 1.5)
                self.assertEqual(sum(contains(p, x, y) for p in polys), 1)

    def test_convex_and_respecting_the_minimum_angle(self):
        for min_angle in (20.0, 35.0):
            polys = icecrack.ice_crack(2.0, 2.0, 80, seed=5, min_angle_deg=min_angle)
            for p in polys:
                self.assertGreater(area2d(p), 0)
                n = len(p)
                for k in range(n):  # counter-clockwise and convex
                    (ax, ay), (bx, by), (cx, cy) = p[k - 1], p[k], p[(k + 1) % n]
                    self.assertGreaterEqual((bx - ax) * (cy - by) - (by - ay) * (cx - bx), -1e-12)
                corners = [a for a in corner_angles(p) if a < 180.0 - 1e-6]
                self.assertGreaterEqual(min(corners), min_angle - 1e-9)

    def test_cells_meet_vertex_to_vertex(self):
        # Every edge inside the rectangle is an edge of exactly one other cell, the other way round (a crack that
        # ends on a neighbour's side is a vertex of that neighbour too).
        polys = icecrack.ice_crack(2.0, 2.0, 60, seed=2)
        edges = {}
        for p in polys:
            for a, b in zip(p, p[1:] + p[:1]):
                edges[(a, b)] = edges.get((a, b), 0) + 1
        for (a, b), n in edges.items():
            self.assertEqual(n, 1)
            on_rim = any(abs(a[i] - v) < 1e-12 and abs(b[i] - v) < 1e-12 for i, v in ((0, 0), (0, 2), (1, 0), (1, 2)))
            self.assertTrue(on_rim or (b, a) in edges, (a, b))

    def test_determinism_and_guards(self):
        self.assertEqual(icecrack.ice_crack(seed=4), icecrack.ice_crack(seed=4))
        self.assertNotEqual(icecrack.ice_crack(seed=4), icecrack.ice_crack(seed=5))
        for kwargs in ({'cells': icecrack.MAX_CELLS + 1}, {'cells': 0}, {'min_angle_deg': 70}, {'width': -1}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                icecrack.ice_crack(**kwargs)
        with self.assertRaises(ValueError):
            icecrack.ice_crack_lattice(bar=5.0)


class LatticeTest(unittest.TestCase):
    def test_lattice_is_a_closed_solid_of_the_right_bars(self):
        w, h, cells, bar, depth, seed = 2.0, 1.6, 30, 0.04, 0.05, 1
        m = icecrack.ice_crack_lattice(w, h, cells, bar=bar, depth=depth, seed=seed)
        self.assertEqual(assert_manifold(self, m.faces), [], 'closed: no open edge')
        self.assertEqual(m.bounds(), ((0.0, 0.0, 0.0), (w, h, depth)))
        frame_area = m.volume() / depth
        # Independent check: a point of a cell is in a pane's opening when it is at least bar / 2 from each of the
        # cell's sides (bar from the rim), so estimate the bars' share by sampling.
        polys = icecrack.ice_crack(w, h, cells, seed)
        rng = random.Random(9)
        hits, total = 0, 6000
        for _ in range(total):
            x, y = rng.uniform(0, w), rng.uniform(0, h)
            cell = next(p for p in polys if contains(p, x, y))
            bars = False
            for a, b in zip(cell, cell[1:] + cell[:1]):
                rim = any(abs(a[i] - v) < 1e-12 and abs(b[i] - v) < 1e-12 for i, v in ((0, 0), (0, w), (1, 0), (1, h)))
                ex, ey = b[0] - a[0], b[1] - a[1]
                dist = abs(ex * (y - a[1]) - ey * (x - a[0])) / math.hypot(ex, ey)
                bars |= dist < (bar if rim else bar / 2)
            hits += bars
        self.assertAlmostEqual(frame_area / (w * h), hits / total, delta=0.02)
        self.assertGreater(frame_area, 0.1 * w * h)


if __name__ == '__main__':
    unittest.main()
