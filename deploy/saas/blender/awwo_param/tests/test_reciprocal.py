import math
import unittest
from collections import defaultdict

import numpy as np

from awwo_param import reciprocal

CASES = (('hex', 3, 3), ('quad', 5, 4), ('tri', 3, 6))


def spokes(frame):
    at = defaultdict(list)
    for e, (i, j) in enumerate(frame.edges):
        at[i].append((e, 0))
        at[j].append((e, 1))
    return at


def line_distance(p, segment):
    (x0, y0), (x1, y1) = segment
    ex, ey = x1 - x0, y1 - y0
    return abs(ex * (p[1] - y0) - ey * (p[0] - x0)) / math.hypot(ex, ey)


class ReciprocalTest(unittest.TestCase):
    def test_fans_are_cycles_of_the_tilings_degree(self):
        for pattern, size, degree in CASES:
            frame = reciprocal.reciprocal_lines(pattern, size, edge=1.0, engagement=0.25, overhang=0.0)
            interior = 0
            for v, ends in spokes(frame).items():
                if len(ends) != degree or any(frame.rests_on[e][s] is None for e, s in ends):
                    continue
                interior += 1
                side = dict(ends)
                cycle, e = [], ends[0][0]
                for _ in range(degree):
                    cycle.append(e)
                    e = frame.rests_on[e][side[e]]
                    self.assertIn(e, side, f'{pattern}: a beam at {v} rests on one from elsewhere')
                self.assertEqual(e, ends[0][0], f'{pattern}: the fan at {v} does not close')
                self.assertEqual(len(set(cycle)), degree, pattern)
            self.assertGreater(interior, 10, pattern)

    def test_beams_land_on_their_neighbour_at_the_engagement(self):
        for pattern, size, degree in CASES:
            for engagement in (0.15, 0.25):
                frame = reciprocal.reciprocal_lines(pattern, size, edge=1.2, engagement=engagement, overhang=0.0)
                sides = []
                for ends in spokes(frame).values():
                    side = dict(ends)
                    for e, s in ends:
                        under = frame.rests_on[e][s]
                        if under is None:
                            continue
                        end = frame.segments[e][s]
                        self.assertLess(line_distance(end, frame.segments[under]), 1e-9)  # it lands on the neighbour
                        # ...between the neighbour's own end and the next landing: the fan's side.
                        if len(ends) == degree and all(frame.rests_on[f][t] is not None for f, t in ends):
                            sides.append(math.dist(end, frame.segments[under][side[under]]))
                self.assertTrue(np.allclose(sides, engagement), f'{pattern} {engagement}')
                alpha = math.degrees(math.asin(engagement / (1.2 * math.tan(math.pi / degree))))
                self.assertAlmostEqual(frame.alpha_deg, alpha)

    def test_beams_resting_on_each_other_sit_at_different_levels(self):
        for pattern, size, _degree in CASES:
            frame = reciprocal.reciprocal_lines(pattern, size)
            levels = reciprocal.beam_levels(frame)
            self.assertEqual(max(levels) + 1, 2 if pattern == 'quad' else 3)
            for e, rests in enumerate(frame.rests_on):
                for under in rests:
                    if under is not None:
                        self.assertNotEqual(levels[e], levels[under], pattern)

    def test_grid_mesh(self):
        for pattern, size, _degree in CASES:
            depth = 0.12
            m = reciprocal.reciprocal_grid(pattern, size, width=0.08, depth=depth)
            frame = reciprocal.reciprocal_lines(pattern, size, overhang=0.04)
            self.assertEqual(len(m.vertices), 8 * len(frame.edges))
            levels = 2 if pattern == 'quad' else 3
            lo, hi = m.bounds()
            self.assertAlmostEqual(lo[2], 0.0)
            self.assertAlmostEqual(hi[2], depth + (levels - 1) * depth / 2)
            lengths = [math.dist(*s) for s in frame.segments]
            self.assertAlmostEqual(m.volume(), sum(lengths) * 0.08 * depth, delta=1e-9)
        self.assertEqual(reciprocal.reciprocal_grid('hex', 2).vertices, reciprocal.reciprocal_grid('hex', 2).vertices)

    def test_guards(self):
        for kwargs in ({'pattern': 'oct'}, {'engagement': 0.9, 'pattern': 'tri'}, {'engagement': 0}, {'size': 0},
                       {'size': reciprocal.MAX_SIZE + 1}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                reciprocal.reciprocal_grid(**kwargs)


class DiagridTest(unittest.TestCase):
    def test_members_stay_inside_and_layer(self):
        w, h, member = 6.0, 3.0, 0.06
        m = reciprocal.diagrid(w, h, nx=6, ny=3, member=member)
        v = np.array(m.vertices)
        self.assertTrue(np.all(v[:, 0] > -1e-9) and np.all(v[:, 0] < w + 1e-9))
        self.assertTrue(np.all(v[:, 1] > -1e-9) and np.all(v[:, 1] < h + 1e-9))
        self.assertAlmostEqual(v[:, 2].max(), 2.05 * member)  # the frame stands proud of the diagonals
        self.assertAlmostEqual(v[:, 2].min(), -0.05 * member)
        boxes = v.reshape(-1, 8, 3)
        diagonals = [b for b in boxes if min(np.ptp(b[:, 0]), np.ptp(b[:, 1])) > 2 * member]  # not the chords
        lower = sum(1 for b in diagonals if b[:, 2].max() <= member + 1e-9)
        upper = sum(1 for b in diagonals if b[:, 2].min() >= member - 1e-9)
        self.assertEqual(lower + upper, len(diagonals))
        self.assertEqual(lower, upper)
        self.assertEqual(lower, 8)  # x/dx - y/dy = k for k = -2..5 (k = -3 and 6 only touch a corner)
        self.assertEqual(len(boxes), 2 * 8 + 4)
        flat = reciprocal.diagrid(w, h, 6, 3, member, layered=False)
        self.assertAlmostEqual(np.array(flat.vertices)[:, 2].max(), 1.05 * member)

    def test_guards(self):
        with self.assertRaises(ValueError):
            reciprocal.diagrid(member=2.0)
        with self.assertRaises(ValueError):
            reciprocal.diagrid(nx=0)


if __name__ == '__main__':
    unittest.main()
