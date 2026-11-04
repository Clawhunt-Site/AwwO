import ast
import json
import os
import re
import unittest

import awwo_param
from awwo_param import geometry
from awwo_param.geometry import Curves, Mesh, beam, box, extrude_flat, merged

from ._checks import assert_manifold

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAMILIES = ('minimal', 'voronoi', 'attractors', 'icecrack', 'spirals', 'reciprocal', 'slime')


class PackageTest(unittest.TestCase):
    def test_version_and_families(self):
        self.assertEqual(awwo_param.__version__, '0.2.0')
        for name in FAMILIES:
            self.assertTrue(hasattr(awwo_param, name), name)
            self.assertRegex(awwo_param.__doc__, rf'\b{name}\b')

    def test_every_listed_generator_exists(self):
        # Lines of the docstring that name a function as "name(" under a module heading must point at real code.
        module = None
        for line in awwo_param.__doc__.splitlines():
            heading = re.match(r'^(\w+) -- ', line)
            if heading:
                module = getattr(awwo_param, heading.group(1), None)
                continue
            if line.startswith('blender'):
                break
            if module is not None and line.startswith('  '):
                for name in re.findall(r'(\w+)\(', line):
                    self.assertTrue(callable(getattr(module, name, None)), f'{module.__name__}.{name}')

    def test_only_the_blender_module_imports_bpy(self):
        for file in sorted(os.listdir(HERE)):
            if not file.endswith('.py'):
                continue
            with open(os.path.join(HERE, file), encoding='utf-8') as handle:
                tree = ast.parse(handle.read())
            modules = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules |= {alias.name.split('.')[0] for alias in node.names}
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    modules.add(node.module.split('.')[0])
            self.assertEqual('bpy' in modules, file == 'blender.py', file)
            # The standard library and numpy only: Blender's bundled Python has nothing else to offer.
            self.assertLessEqual(modules, {'bpy', 'numpy', 'math', 'random', 'heapq', 'collections', 'dataclasses'}, file)


class GeometryTest(unittest.TestCase):
    def unit_box(self):
        return box((0.5, 0.5, 0.5), ((1, 0, 0), (0, 1, 0), (0, 0, 1)), (0.5, 0.5, 0.5))

    def test_box_is_closed_and_faces_out(self):
        m = self.unit_box()
        self.assertEqual(assert_manifold(self, m.faces), [])
        self.assertAlmostEqual(m.volume(), 1.0)
        self.assertAlmostEqual(m.area(), 6.0)
        self.assertEqual(m.bounds(), ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)))
        self.assertEqual(m.triangle_count(), 12)

    def test_beam_spans_its_axis(self):
        b = beam((0, 0, 0), (3, 4, 0), 0.2, 0.1)
        self.assertAlmostEqual(b.volume(), 5 * 0.2 * 0.1)
        lo, hi = b.bounds()
        self.assertAlmostEqual(hi[2] - lo[2], 0.1)
        with self.assertRaises(ValueError):
            beam((1, 1, 1), (1, 1, 1), 0.1, 0.1)

    def test_transforms_and_merge(self):
        m = self.unit_box()
        both = merged(m, m.translated(2, 0, 0))
        self.assertEqual(len(both.vertices), 16)
        self.assertEqual(max(max(f) for f in both.faces), 15)
        self.assertAlmostEqual(both.volume(), 2.0)
        self.assertAlmostEqual(m.scaled(2).volume(), 8.0)
        mirrored = m.scaled((-1, 1, 1))
        self.assertAlmostEqual(mirrored.volume(), 1.0)  # faces reversed, still outward
        self.assertEqual(Mesh.merged(m).vertices, m.vertices)
        json.dumps(both.summary())

    def test_curves(self):
        c = Curves([[(0, 0, 0), (3, 4, 0)], [(0, 0, 0), (1, 0, 0), (1, 1, 0)]], [False, True])
        self.assertEqual(c.point_count(), 5)
        self.assertEqual(c.lengths()[0], 5.0)
        self.assertAlmostEqual(c.lengths()[1], 2 + 2 ** 0.5)
        self.assertEqual(c.translated(1, 0, 0).bounds()[1][0], 4.0)
        self.assertEqual(Curves.merged(c, c).summary()['polylines'], 4)
        json.dumps(c.scaled(2).summary())

    def test_extrude_flat_closes_a_frame(self):
        # A square ring: outer 0..3 and hole 1..2, as four trapezoids.
        verts = [(0, 0, 0), (3, 0, 0), (3, 3, 0), (0, 3, 0), (1, 1, 0), (2, 1, 0), (2, 2, 0), (1, 2, 0)]
        faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        solid = extrude_flat(Mesh(verts, faces), 0.5)
        self.assertEqual(assert_manifold(self, solid.faces), [])
        self.assertAlmostEqual(solid.volume(), (9 - 1) * 0.5)

    def test_results_with_non_finite_coordinates_are_refused(self):
        from awwo_param import voronoi
        geometry.ensure_finite(Mesh([(0, 0, 0)], []))
        geometry.ensure_finite(Curves([], []))
        for bad in (Mesh([(0, float('nan'), 0)], []), Curves([[(0, 0, float('inf'))]], [False]),
                    Mesh([(geometry.MAX_EXTENT * 2, 0, 0)], []), [(1.0, float('nan'))]):
            with self.assertRaises(ValueError):
                geometry.ensure_finite(bad)
        # Through a generator: a surface that returns NaN for some (u, v).
        panel = voronoi.perforated_panel(1.0, 1.0, cells=8, frame=0.05)
        with self.assertRaises(ValueError):
            voronoi.wrap(panel, lambda u, v: (u, v, float('nan') if u > 0.5 else 0.0))
        with self.assertRaises(ValueError):
            geometry.check_extent('r', float('inf'))

    def test_check_count(self):
        self.assertEqual(geometry.check_count('n', 5, 10), 5)
        with self.assertRaises(ValueError):
            geometry.check_count('n', 11, 10)
        with self.assertRaises(ValueError):
            geometry.check_count('n', float('nan'), 10)


if __name__ == '__main__':
    unittest.main()
