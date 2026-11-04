import math
import unittest

import numpy as np

from awwo_param import attractors

from ._checks import assert_manifold, face_area2d


class FieldTest(unittest.TestCase):
    def test_falloffs(self):
        d = np.linspace(0, 4, 81)
        for falloff in attractors.FALLOFFS:
            s = np.array(attractors.field([(x, 0.0) for x in d], [(0.0, 0.0)], radius=3.0, falloff=falloff))
            self.assertAlmostEqual(s[0], 1.0, msg=falloff)
            self.assertTrue(np.all(s[d >= 3.0] == 0.0), falloff)
            self.assertTrue(np.all(np.diff(s) <= 1e-12), f'{falloff} falls with distance')
            self.assertTrue(np.all((s >= 0) & (s <= 1)))
        self.assertAlmostEqual(attractors.field([(1.5, 0)], [(0, 0)], 3.0, 'linear')[0], 0.5)
        self.assertAlmostEqual(attractors.field([(1.5, 0)], [(0, 0)], 3.0, 'smooth')[0], 0.5)

    def test_nearest_attractor_and_3d(self):
        s = attractors.field([(0, 0), (5, 0), (2.5, 0)], [(0, 0), (5, 0)], radius=5.0, falloff='linear')
        self.assertEqual(s[:2], [1.0, 1.0])
        self.assertAlmostEqual(s[2], 0.5)
        s3 = attractors.field([(0, 0, 3)], [(0, 0, 0)], radius=6.0, falloff='linear')
        self.assertAlmostEqual(s3[0], 0.5)
        self.assertEqual(attractors.field([], [(0, 0)]), [])

    def test_sizes_are_bounded(self):
        many = np.random.default_rng(0).uniform(0, 8, (attractors.MAX_ATTRACTORS, 2))
        s = attractors.field(np.random.default_rng(1).uniform(0, 8, (50_000, 2)), many, radius=1.0)
        self.assertEqual(len(s), 50_000)  # in chunks of a million pairs, not one 50,000 x 1,000 table
        huge = np.broadcast_to(0.5, (5000, 5000))  # a view: no memory
        with self.assertRaises(ValueError):
            attractors.openings(values=huge)
        with self.assertRaises(ValueError):
            attractors.openings(values=[[0.5, float('nan')]])
        with self.assertRaises(ValueError):
            attractors.field([(0, float('inf'))], [(0, 0)])

    def test_guards(self):
        for call in (lambda: attractors.field([(0, 0)], []), lambda: attractors.field([(0, 0)], [(0, 0)], falloff='cubic'),
                     lambda: attractors.field([(0, 0)], [(0, 0)], radius=0), lambda: attractors.field([(0, 0)], [(0, 0, 0)]),
                     lambda: attractors.panels(nx=1000, ny=1000), lambda: attractors.panels(min_open=0.9, max_open=0.5),
                     lambda: attractors.louvres(count=20000), lambda: attractors.louvres(max_angle_deg=120)):
            with self.assertRaises(ValueError):
                call()


class PanelsTest(unittest.TestCase):
    def test_openings_follow_distance(self):
        rows = attractors.openings(8.0, 4.0, 16, 8, attractors=[(1.25, 1.25)], radius=3.0, min_open=0.1, max_open=0.8)
        k = np.array(rows)
        self.assertEqual(k.shape, (8, 16))
        self.assertAlmostEqual(k[2, 2], 0.1 + 0.7 * (1 - 1.0), delta=1e-9)  # the cell centred on the attractor
        self.assertTrue(np.allclose(k[:, 10:], 0.8), 'beyond the radius: fully open')
        self.assertTrue(np.all(np.diff(k[2, 2:]) >= -1e-12), 'opening grows with distance')
        inv = np.array(attractors.openings(8.0, 4.0, 16, 8, attractors=[(1.25, 1.25)], radius=3.0, min_open=0.1,
                                           max_open=0.8, invert=True))
        self.assertTrue(np.allclose(inv, 0.9 - k))

    def test_image_values_drive_openings(self):
        ramp = [[c / 9 for c in range(10)] for _r in range(5)]  # dark on the left, bright on the right
        k = np.array(attractors.openings(4.0, 2.0, 8, 4, values=ramp, min_open=0.2, max_open=0.6))
        self.assertTrue(np.all(np.diff(k, axis=1) > 0))
        self.assertTrue(np.allclose(k, k[0]))
        flat = attractors.openings(4.0, 2.0, 8, 4, values=[[1.0]], min_open=0.2, max_open=0.6)
        self.assertTrue(np.allclose(flat, 0.6))
        # Row 0 of the values is the bottom of the facade, as Blender stores image pixels.
        k = np.array(attractors.openings(4.0, 2.0, 4, 4, values=[[0.0], [1.0]], min_open=0.0, max_open=0.5))
        self.assertTrue(np.all(np.diff(k[:, 0]) > 0))

    def test_panel_mesh(self):
        nx, ny, w, h = 12, 6, 6.0, 3.0
        m = attractors.panels(w, h, nx, ny, attractors=[(2.0, 1.5)], radius=2.5, min_open=0.0, max_open=0.7)
        k = np.array(attractors.openings(w, h, nx, ny, attractors=[(2.0, 1.5)], radius=2.5, min_open=0.0, max_open=0.7))
        cell = (w / nx) * (h / ny)
        self.assertAlmostEqual(sum(face_area2d(m, f) for f in m.faces), (cell * (1 - k * k)).sum(), delta=1e-9)
        self.assertTrue(all(face_area2d(m, f) > 0 for f in m.faces))
        assert_manifold(self, m.faces)
        solid = int((k <= 1e-9).sum())
        self.assertEqual(len(m.faces), solid + 4 * (nx * ny - solid))
        self.assertEqual(len(m.vertices), (nx + 1) * (ny + 1) + 4 * (nx * ny - solid))
        self.assertEqual(m.bounds(), ((0.0, 0.0, 0.0), (w, h, 0.0)))


class LouvresTest(unittest.TestCase):
    def test_blades_turn_near_the_attractor(self):
        count, rows, depth, thick, w, h = 10, 2, 0.3, 0.02, 5.0, 4.0
        m = attractors.louvres(w, h, count, attractors=[(0.25, 1.0)], radius=2.0, max_angle_deg=60.0, depth=depth,
                               thickness=thick, rows=rows, falloff='linear')
        angles = attractors.louvre_angles(w, h, count, attractors=[(0.25, 1.0)], radius=2.0, max_angle_deg=60.0,
                                          rows=rows, falloff='linear')
        self.assertEqual(len(m.vertices), 8 * count * rows)
        self.assertEqual(len(m.faces), 6 * count * rows)
        self.assertAlmostEqual(m.volume(), count * rows * thick * depth * (h / rows), delta=1e-9)
        self.assertAlmostEqual(angles[0][0], 60.0)
        self.assertEqual(angles[1][-1], 0.0)
        v = np.array(m.vertices).reshape(count * rows, 8, 3)
        for r in range(rows):
            for i in range(count):
                box = v[r * count + i]
                depth_axis = box[4] - box[0]  # corner 4 is corner 0 moved along the blade's depth
                turned = math.degrees(math.atan2(depth_axis[0], depth_axis[2]))
                self.assertAlmostEqual(turned, angles[r][i], delta=1e-9)
                self.assertAlmostEqual(box[:, 0].mean(), (i + 0.5) * w / count)
        z = np.array(m.vertices)[:, 2]
        self.assertAlmostEqual(z.max(), depth)


if __name__ == '__main__':
    unittest.main()
