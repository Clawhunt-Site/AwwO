"""awwo_param: tested parametric generators for AwwO's Blender workstation, re-implementing the owner's Grasshopper
algorithm families in Python (numpy only). Import it in execute_blender_code; generators return plain geometry -- a
Mesh (vertices, faces) or Curves (polylines) in metres, Z up -- and `from awwo_param import blender` turns that into
Blender objects. Every random generator takes seed=0 and gives the same result for the same seed; sizes beyond each
documented maximum raise ValueError. help(awwo_param.<module>.<function>) gives the details.

minimal -- minimal surfaces (极小曲面)
  tpms(kind, size, cells, resolution, level, shape)  gyroid, schwarz_p, schwarz_d, neovius, lidinoid, iwp... meshed by
                                                     marching cubes, clipped to a 'box', 'sphere' or 'cylinder'
  parametric(kind, resolution)                       enneper, catenoid, helicoid, scherk, henneberg, catalan,
                                                     richmond, bour as quads
  evaluate(kind, points, size, cells)                the TPMS implicit function at points
voronoi -- Voronoi skins and perforation (泰森多边形)
  voronoi_cells(points2d, bounds, periodic)          convex cells clipped to a rectangle
  random_points(n, bounds, seed, relax)              uniform sites, Lloyd-relaxed
  perforated_panel(width, height, cells, frame, ...) flat panel of cell frames (holes), z = 0
  wrap(mesh, surface, radius, ...)                   bend a flat panel onto a cylinder, sphere or callable surface
attractors -- attractor-driven facades (点干扰)
  panels(width, height, nx, ny, attractors, ...)     square frames opening with distance (or image values=)
  louvres(width, height, count, attractors, ...)     vertical blades turning with distance
  field(points, attractors, radius, falloff)         the 0..1 influence itself
icecrack -- ice-crack tessellation (冰裂纹)
  ice_crack(width, height, cells, seed, min_angle_deg)   cells tiling a rectangle
  ice_crack_lattice(width, height, cells, bar, depth)    the window lattice as one closed solid
spirals -- phyllotaxis and spirals (斐波那契, 螺旋线)
  phyllotaxis(n, c, angle_deg, surface, ...)         (points, scales) on a disc, sphere, cylinder or cone
  spiral(kind, turns, a, b, points)                  archimedean, fermat, logarithmic, involute
  helix(radius, pitch, turns, points)                a helix
  wound(surface, turns, ...)                         spirals wound round a sphere, torus or cylinder (缠绕线)
reciprocal -- reciprocal frames and timber trusses (互承结构, 交叉木桁架)
  reciprocal_grid(pattern, size, edge, engagement, width, depth)   'hex', 'quad' or 'tri' beam grid as boxes
  reciprocal_lines(...)                              the same in plan, with which beam rests on which
  diagrid(width, height, nx, ny, member)             crossed diagonal truss in a frame
slime -- slime-mould (Physarum) networks (黏菌)
  physarum(width, height, agents, steps, ..., food, seed)   trail map 0..1; food points get linked
  contours(field, level, size)                       iso-lines of a field as Curves
  heightfield(field, size, height, step)             a relief mesh of a field
geometry -- Mesh, Curves (merged, translated, scaled, bounds, triangle_count, summary)

blender (inside Blender only: `from awwo_param import blender`)
  mesh_object(mesh, name, collection, material, smooth)   curve_object(curves, name, bevel_depth, resolution)
  points_instances(points, source_object, scales)         solidify(obj, thickness, offset)
  material(name, color, metallic, roughness)
Flat results (panels, lattices, trusses) lie in the XY plane, +z out of them: stand one up with
obj.rotation_euler = (math.radians(90), 0, 0)."""

from . import attractors, icecrack, minimal, reciprocal, slime, spirals, voronoi
from .geometry import Curves, Mesh

__version__ = '0.2.0'
__all__ = ['Curves', 'Mesh', 'attractors', 'icecrack', 'minimal', 'reciprocal', 'slime', 'spirals', 'voronoi']
