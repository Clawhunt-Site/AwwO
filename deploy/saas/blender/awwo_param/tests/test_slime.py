import unittest

import numpy as np

from awwo_param import slime

from ._checks import area2d, assert_manifold, face_normals

SMALL = dict(width=128, height=128, agents=5000, steps=300)
NODES = ((32, 64), (96, 64))


def linked(trail, a, b, level=0.1, reach=4):
    """Whether a and b lie on one connected ridge of trail >= level (8-connected flood fill)."""
    ridge = trail >= level
    y, x = np.ogrid[:trail.shape[0], :trail.shape[1]]
    near_a = (x - a[0]) ** 2 + (y - a[1]) ** 2 <= reach * reach
    near_b = (x - b[0]) ** 2 + (y - b[1]) ** 2 <= reach * reach
    reached = ridge & near_a
    while True:
        padded = np.pad(reached, 1)
        grown = np.zeros_like(reached)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                grown |= padded[dy:dy + reached.shape[0], dx:dx + reached.shape[1]]
        grown &= ridge
        if (grown == reached).all():
            return bool((reached & near_b).any())
        reached = grown


class PhysarumTest(unittest.TestCase):
    def test_map(self):
        m = slime.physarum(width=96, height=64, agents=2000, steps=120, seed=3)
        self.assertEqual(m.shape, (64, 96))
        self.assertEqual(m.dtype, np.float32)
        self.assertGreaterEqual(float(m.min()), 0.0)
        self.assertEqual(float(m.max()), 1.0)
        self.assertGreater(float((m > 0.2).mean()), 0.01)  # strands formed...
        self.assertLess(float((m > 0.2).mean()), 0.5)      # ...not a uniform haze
        self.assertTrue(np.array_equal(m, slime.physarum(width=96, height=64, agents=2000, steps=120, seed=3)))
        self.assertFalse(np.array_equal(m, slime.physarum(width=96, height=64, agents=2000, steps=120, seed=4)))
        wrapped = slime.physarum(width=64, height=64, agents=1000, steps=60, seed=1, wrap=True)
        self.assertEqual(wrapped.shape, (64, 64))

    def test_food_points_get_linked(self):
        # Like the real mould, which roads form depends on the seed; food makes a road between the two points in
        # most runs, and without food they are almost never joined.
        with_food = [linked(slime.physarum(food=NODES, seed=s, **SMALL), *NODES) for s in range(4)]
        without = [linked(slime.physarum(seed=s, **SMALL), *NODES) for s in range(4)]
        self.assertGreaterEqual(sum(with_food), 3, with_food)
        self.assertLessEqual(sum(without), 1, without)

    def test_several_food_points_grow_one_network(self):
        food = [(20, 25), (100, 20), (64, 64), (30, 100), (108, 102)]
        groups = []
        for seed in range(4):
            trail = slime.physarum(food=food, seed=seed, **SMALL)
            groups.append(max(sum(linked(trail, a, b) for b in food if b != a) for a in food))
        # Each run links most of the five points into one network of roads (never just stubs round each).
        self.assertGreaterEqual(min(groups), 1, groups)
        self.assertGreaterEqual(sum(groups), 9, groups)

    def test_lengths_are_bounded_before_allocating(self):
        # Once allocated a 2 million x 2 million pixel grid for the disc before clipping it to the map.
        big = dict(width=8, height=8, agents=1, steps=1, food=[(1, 1)])
        for kwargs in (dict(big, food_radius=1_000_000), dict(big, sensor_distance=3, food_radius=1e6),
                       dict(big, sensor_distance=3, food_radius=slime.MAX_FOOD_RADIUS + 1),
                       dict(big, sensor_distance=1e12), dict(big, sensor_distance=3, step=1e9),
                       dict(big, sensor_distance=3, food_reach=1e9), dict(big, sensor_distance=3, deposit=float('inf')),
                       dict(width=1024, height=1024, agents=1, steps=1, food=[(1, 1)] * 100)):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                slime.physarum(**kwargs)
        # A disc reaching past the map's edge is drawn only where it overlaps the map.
        trail = slime.physarum(width=16, height=16, agents=50, steps=3, sensor_distance=3, food=[(0, 0)],
                               food_radius=slime.MAX_FOOD_RADIUS)
        self.assertEqual(trail.shape, (16, 16))
        for field in ([[0.0, float('nan')], [0.0, 1.0]], np.broadcast_to(0.0, (2049, 2049))):  # a view: no memory
            with self.assertRaises(ValueError):
                slime.contours(field)
            with self.assertRaises(ValueError):
                slime.heightfield(field)

    def test_guards(self):
        for kwargs in ({'width': slime.MAX_SIDE + 1}, {'agents': slime.MAX_AGENTS + 1}, {'steps': 0},
                       {'agents': 400_000, 'steps': 4000}, {'food': [(300, 10)]}, {'decay': 1.5}, {'spawn': 'edges'},
                       {'food': [(1, 1)] * (slime.MAX_FOOD + 1)}, {'width': 64.5}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                slime.physarum(**kwargs)

    def test_amplitudes_stay_finite(self):
        # deposit=1e308 once overflowed in the blur and came back as a map of NaNs.
        small = dict(width=16, height=16, agents=1, steps=3, sensor_distance=3)
        for kwargs in (dict(small, deposit=1e308), dict(small, deposit=-1e7), dict(small, food=[(4, 4)], food_strength=1e300)):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                slime.physarum(**kwargs)
        # The largest amplitudes, gathered by every agent on one pixel with no decay, stay finite; the map is
        # normalised, so the same ratio of food_strength to deposit gives the same map at any scale.
        crowd = dict(width=4, height=4, agents=2000, steps=50, sensor_distance=1, step=0.1, decay=1.0, diffuse=False)
        top = slime.physarum(**crowd, deposit=slime.MAX_DEPOSIT, food=[(1, 1)], food_strength=10 * slime.MAX_DEPOSIT)
        self.assertTrue(np.all(np.isfinite(top)) and top.max() > 0)
        a = slime.physarum(**small, deposit=2.0, food=[(4, 4)], food_strength=20.0)
        b = slime.physarum(**small, deposit=2.0e5, food=[(4, 4)], food_strength=2.0e6)
        np.testing.assert_allclose(a, b, rtol=1e-5, atol=1e-6)


class ContoursTest(unittest.TestCase):
    def test_circle(self):
        n = 101
        y, x = np.mgrid[0:n, 0:n] / (n - 1)
        field = 1.0 - np.hypot(x - 0.5, y - 0.5) / 0.4  # 1 at the centre, 0.5 at radius 0.2
        c = slime.contours(field, 0.5, size=(2.0, 2.0))
        self.assertEqual(len(c.polylines), 1)
        self.assertEqual(c.closed, [True])
        p = np.array(c.polylines[0])
        self.assertTrue(np.allclose(np.hypot(p[:, 0] - 1.0, p[:, 1] - 1.0), 0.4, atol=2e-3))
        self.assertGreater(area2d([q[:2] for q in c.polylines[0]]), 0)  # the higher region on the left

    def test_open_line_and_saddle(self):
        ramp = np.tile(np.linspace(0.0, 1.0, 11), (5, 1))  # rises along x
        c = slime.contours(ramp, 0.25, size=(1.0, 0.4))
        self.assertEqual(c.closed, [False])
        p = np.array(c.polylines[0])
        self.assertTrue(np.allclose(p[:, 0], 0.25))
        self.assertLess(p[-1, 1], p[0, 1])  # the higher side (x > 0.25) on the left means running down y
        checker = np.array([[1.0, 0.0], [0.0, 1.0]])
        self.assertEqual(len(slime.contours(checker, 0.5).polylines), 2)

    def test_heightfield(self):
        field = np.outer(np.linspace(0, 1, 9), np.ones(13))  # rises along y
        m = slime.heightfield(field, size=(1.2, 0.8), height=0.3, step=2)
        self.assertEqual(len(m.vertices), 5 * 7)
        self.assertEqual(len(m.faces), 4 * 6)
        v = np.array(m.vertices)
        self.assertTrue(np.allclose(v[:, 2], 0.3 * v[:, 1] / 0.8))
        self.assertEqual(m.bounds(), ((0.0, 0.0, 0.0), (1.2, 0.8, 0.3)))
        assert_manifold(self, m.faces)
        normals, _ = face_normals(slime.heightfield(np.zeros((5, 5)), step=1))
        self.assertTrue(np.all(normals[:, 2] > 0))
        with self.assertRaises(ValueError):
            slime.heightfield(np.zeros((3000, 3000)), step=1)


if __name__ == '__main__':
    unittest.main()
