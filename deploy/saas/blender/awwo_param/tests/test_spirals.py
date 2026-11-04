import math
import unittest

import numpy as np

from awwo_param import spirals


def unwrapped_angles(points):
    p = np.array(points)
    return np.unwrap(np.arctan2(p[:, 1], p[:, 0]))


class PhyllotaxisTest(unittest.TestCase):
    def test_vogel_disc(self):
        points, scales = spirals.phyllotaxis(500, c=0.05)
        p = np.array(points)
        a = np.degrees(np.arctan2(p[1:, 1], p[1:, 0]))
        divergence = np.diff(a) % 360.0
        self.assertTrue(np.allclose(divergence, spirals.GOLDEN_ANGLE, atol=1e-7))
        self.assertAlmostEqual(spirals.GOLDEN_ANGLE, 137.50776405003785)
        self.assertTrue(np.allclose(np.hypot(p[:, 0], p[:, 1]), 0.05 * np.sqrt(np.arange(500))))
        self.assertTrue(np.allclose(p[:, 2], 0.0))
        # Even packing: one scale for all, half the spacing of a hexagonal packing of pi c^2 per point.
        self.assertTrue(np.allclose(scales, 0.5 * math.sqrt(2 * math.pi * 0.05 ** 2 / math.sqrt(3))))

    def test_growing_disc_spreads_and_grows(self):
        points, scales = spirals.phyllotaxis(300, c=0.02, power=0.8)
        r = np.hypot(*np.array(points)[:, :2].T)
        self.assertTrue(np.allclose(r, 0.02 * np.arange(300) ** 0.8))
        self.assertTrue(np.all(np.diff(scales) > 0))

    def test_sphere_cylinder_cone(self):
        points, scales = spirals.phyllotaxis(400, surface='sphere', radius=2.0)
        p = np.array(points)
        self.assertTrue(np.allclose(np.linalg.norm(p, axis=1), 2.0))
        self.assertTrue(np.allclose(np.diff(p[:, 2]), -4.0 / 400))  # evenly spread in z, hence in area
        self.assertTrue(np.allclose(scales, scales[0]))
        p = np.array(spirals.phyllotaxis(200, surface='cylinder', radius=0.5, height=3.0)[0])
        self.assertTrue(np.allclose(np.hypot(p[:, 0], p[:, 1]), 0.5))
        self.assertTrue(np.all((p[:, 2] > 0) & (p[:, 2] < 3.0)))
        p = np.array(spirals.phyllotaxis(200, surface='cone', radius=1.0, height=2.0)[0])
        self.assertTrue(np.allclose(np.hypot(p[:, 0], p[:, 1]), 1.0 * (1 - p[:, 2] / 2.0)))
        for surface in ('sphere', 'cylinder', 'cone'):
            q = np.array(spirals.phyllotaxis(50, surface=surface)[0])
            turn = np.diff(np.degrees(np.arctan2(q[:, 1], q[:, 0]))) % 360.0
            self.assertTrue(np.allclose(turn, spirals.GOLDEN_ANGLE, atol=1e-7), surface)

    def test_guards(self):
        for kwargs in ({'n': spirals.MAX_POINTS + 1}, {'n': 0}, {'surface': 'torus'}, {'c': 0}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                spirals.phyllotaxis(**kwargs)


class SpiralTest(unittest.TestCase):
    def test_laws(self):
        c = spirals.spiral('archimedean', turns=4, a=0.1, b=0.02, points=300)
        p = c.polylines[0]
        t = unwrapped_angles(p[1:]) - unwrapped_angles(p[1:])[0] + math.atan2(p[1][1], p[1][0])
        self.assertTrue(np.allclose(np.hypot(*np.array(p[1:])[:, :2].T), 0.1 + 0.02 * t))
        self.assertAlmostEqual(t[-1], 8 * math.pi)
        log = np.array(spirals.spiral('logarithmic', turns=3, a=0.05, b=0.2).polylines[0])
        r = np.hypot(log[:, 0], log[:, 1])
        self.assertTrue(np.allclose(np.log(r), np.log(0.05) + 0.2 * unwrapped_angles(log)))
        inv = np.array(spirals.spiral('involute', turns=2, a=0.1, points=4000).polylines[0])
        tt = np.linspace(0, 4 * math.pi, len(inv))
        self.assertTrue(np.allclose(np.hypot(inv[:, 0], inv[:, 1]), 0.1 * np.sqrt(1 + tt * tt)))
        # An involute is traced by a taut string unwound from the circle: its tangent is perpendicular to the
        # string, from the point's foot on the circle to the point.
        d = np.gradient(inv[:, :2], tt, axis=0)
        string = inv[:, :2] - 0.1 * np.stack([np.cos(tt), np.sin(tt)], axis=1)
        cosine = (d * string).sum(axis=1) / np.maximum(np.linalg.norm(d, axis=1) * np.linalg.norm(string, axis=1), 1e-12)
        self.assertLess(np.abs(cosine[5:-5]).max(), 1e-3)

    def test_fermat_has_both_branches(self):
        c = spirals.spiral('fermat', turns=2, a=0.3, points=101)
        p = np.array(c.polylines[0])
        self.assertEqual(len(p), 201)
        self.assertTrue(np.allclose(p[100], 0.0))
        self.assertTrue(np.allclose(p[:100][::-1], -p[101:]))  # the branches mirror through the origin
        r = np.hypot(p[101:, 0], p[101:, 1])
        self.assertTrue(np.allclose(r * r, 0.09 * np.linspace(0, 4 * math.pi, 101)[1:]))
        self.assertEqual(c.closed, [False])

    def test_helix_and_wound(self):
        h = np.array(spirals.helix(radius=0.5, pitch=0.2, turns=3, points=301).polylines[0])
        self.assertTrue(np.allclose(np.hypot(h[:, 0], h[:, 1]), 0.5))
        self.assertAlmostEqual(h[-1, 2], 0.6)
        s = spirals.wound('sphere', turns=8, radius=1.2, strands=3)
        self.assertEqual(len(s.polylines), 3)
        for line in s.polylines:
            self.assertTrue(np.allclose(np.linalg.norm(np.array(line), axis=1), 1.2))
        t = spirals.wound('torus', turns=12, radius=1.0, minor_radius=0.25)
        p = np.array(t.polylines[0])
        self.assertTrue(np.allclose((np.hypot(p[:, 0], p[:, 1]) - 1.0) ** 2 + p[:, 2] ** 2, 0.0625))
        self.assertEqual(t.closed, [True])
        self.assertEqual(spirals.wound('torus', turns=2.5).closed, [False])
        cyl = np.array(spirals.wound('cylinder', turns=5, radius=0.4, height=2.0).polylines[0])
        self.assertTrue(np.allclose(np.hypot(cyl[:, 0], cyl[:, 1]), 0.4))
        self.assertAlmostEqual(cyl[-1, 2], 2.0)

    def test_ranges_that_overflow_are_refused(self):
        # exp(0.1 * 2 pi * 10000) overflowed to infinity and came back as non-finite coordinates.
        for call in (lambda: spirals.spiral('logarithmic', turns=10_000), lambda: spirals.spiral('logarithmic', b=200.0),
                     lambda: spirals.spiral('archimedean', turns=10_000, b=1e3), lambda: spirals.spiral(a=float('nan')),
                     lambda: spirals.helix(radius=float('inf')), lambda: spirals.helix(pitch=1e300),
                     lambda: spirals.wound(radius=float('nan')), lambda: spirals.phyllotaxis(10, c=1e300),
                     lambda: spirals.phyllotaxis(10, angle_deg=float('inf'))):
            with self.assertRaises(ValueError):
                call()
        far = spirals.spiral('logarithmic', turns=20, a=0.05, b=0.1)  # 0.05 e^(4 pi) ~ 14 m: fine
        self.assertTrue(np.all(np.isfinite(np.array(far.polylines[0]))))

    def test_guards(self):
        for call in (lambda: spirals.spiral('golden'), lambda: spirals.spiral(points=1),
                     lambda: spirals.spiral(points=spirals.MAX_POINTS + 1), lambda: spirals.helix(points=10 ** 6),
                     lambda: spirals.wound('cone'), lambda: spirals.wound(strands=0)):
            with self.assertRaises(ValueError):
                call()


if __name__ == '__main__':
    unittest.main()
