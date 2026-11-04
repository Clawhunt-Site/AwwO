"""Blender helpers for awwo_param's geometry: `from awwo_param import blender` inside Blender only (it imports bpy).
Everything goes through bpy.data (no operators that need a window), so it works in `blender --background`, as in the
workstation. Objects are linked to the given collection (an object, a name to find or make, or the scene's own)."""
import bpy

from .geometry import Curves, Mesh, check_count

MAX_DUPLICATES = 10_000          # objects points_instances(mode='duplicates') may make
MAX_INSTANCE_POINTS = 1_000_000  # points one Geometry Nodes point cloud may carry


def _collection(collection):
    scene = bpy.context.scene
    if collection is None:
        return scene.collection
    if isinstance(collection, str):
        found = bpy.data.collections.get(collection)
        if found is None:
            found = bpy.data.collections.new(collection)
            scene.collection.children.link(found)
        return found
    return collection


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _rgba(color):
    """(r, g, b[, a]) in Blender's linear colour, or a '#rrggbb' sRGB string as a designer gives it."""
    if isinstance(color, str):
        text = color.lstrip('#')
        if len(text) != 6:
            raise ValueError("a colour string must look like '#rrggbb'")
        return tuple(_srgb_to_linear(int(text[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (1.0,)
    values = tuple(float(c) for c in color)
    if len(values) not in (3, 4):
        raise ValueError('a colour is (r, g, b) or (r, g, b, a)')
    return values if len(values) == 4 else values + (1.0,)


def material(name, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5):
    """A Principled BSDF material (made, or updated when one of that name exists)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if not getattr(mat, 'use_nodes', True):
        mat.use_nodes = True
    rgba = _rgba(color)
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
        output = next((n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL'), None) \
            or mat.node_tree.nodes.new('ShaderNodeOutputMaterial')
        mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = rgba
    bsdf.inputs['Metallic'].default_value = float(metallic)
    bsdf.inputs['Roughness'].default_value = float(roughness)
    mat.diffuse_color = rgba
    mat.metallic = float(metallic)
    mat.roughness = float(roughness)
    return mat


def _material(value):
    if value is None or isinstance(value, bpy.types.Material):
        return value
    return bpy.data.materials.get(value) or material(value)


def mesh_object(mesh, name='awwo_mesh', collection=None, material=None, smooth=False):
    """A mesh object from an awwo_param Mesh (vertices + faces, via mesh.from_pydata). material: a Material or a
    material name. smooth=True shades every face smooth."""
    if not isinstance(mesh, Mesh):
        raise TypeError('mesh must be an awwo_param Mesh')
    data = bpy.data.meshes.new(name)
    data.from_pydata([tuple(v) for v in mesh.vertices], [], [tuple(f) for f in mesh.faces])
    data.update()
    if smooth and len(data.polygons):
        data.polygons.foreach_set('use_smooth', [True] * len(data.polygons))
    found = _material(material)
    if found is not None:
        data.materials.append(found)
    obj = bpy.data.objects.new(name, data)
    _collection(collection).objects.link(obj)
    return obj


def curve_object(curves, name='awwo_curve', bevel_depth=0.01, resolution=2, collection=None, material=None):
    """A curve object of poly splines from awwo_param Curves, given a round profile bevel_depth (metres) with
    `resolution` bevel steps (0 bevel_depth = bare curves, which do not render)."""
    if not isinstance(curves, Curves):
        raise TypeError('curves must be awwo_param Curves')
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '3D'
    data.bevel_depth = float(bevel_depth)
    data.bevel_resolution = int(resolution)
    data.use_fill_caps = True
    for line, closed in zip(curves.polylines, curves.closed):
        if len(line) < 2:
            continue
        spline = data.splines.new('POLY')
        spline.points.add(len(line) - 1)
        spline.points.foreach_set('co', [c for p in line for c in (p[0], p[1], p[2], 1.0)])
        spline.use_cyclic_u = bool(closed)
    found = _material(material)
    if found is not None:
        data.materials.append(found)
    obj = bpy.data.objects.new(name, data)
    _collection(collection).objects.link(obj)
    return obj


def _instance_nodes(name, source, realize):
    tree = bpy.data.node_groups.new(name, 'GeometryNodeTree')
    tree.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    tree.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nodes, links = tree.nodes, tree.links
    group_in, group_out = nodes.new('NodeGroupInput'), nodes.new('NodeGroupOutput')
    info = nodes.new('GeometryNodeObjectInfo')
    info.inputs['Object'].default_value = source
    info.transform_space = 'ORIGINAL'
    scale = nodes.new('GeometryNodeInputNamedAttribute')
    scale.data_type = 'FLOAT'
    scale.inputs['Name'].default_value = 'awwo_scale'
    place = nodes.new('GeometryNodeInstanceOnPoints')
    links.new(group_in.outputs['Geometry'], place.inputs['Points'])
    links.new(info.outputs['Geometry'], place.inputs['Instance'])
    links.new(scale.outputs['Attribute'], place.inputs['Scale'])
    last = place.outputs['Instances']
    if realize:
        real = nodes.new('GeometryNodeRealizeInstances')
        links.new(last, real.inputs['Geometry'])
        last = real.outputs['Geometry']
    links.new(last, group_out.inputs['Geometry'])
    return tree


def points_instances(points, source_object, scales=None, name='awwo_points', collection=None, mode='nodes',
                     realize=True, hide_source=True):
    """Copies of source_object at each point, scaled by scales (one per point, default 1). mode='nodes': one object,
    a point cloud with a Geometry Nodes modifier (Instance on Points, the source's own mesh in its local space), made
    real geometry when realize=True so a GLB export carries it; mode='duplicates': one linked duplicate object per
    point (sharing the source's data). hide_source hides the source from renders. Returns the object (or list)."""
    # Thousands of objects slow every later operation in Blender; one point cloud carries a million easily.
    check_count('points', len(points), MAX_DUPLICATES if mode == 'duplicates' else MAX_INSTANCE_POINTS)
    points = [tuple(float(c) for c in p) for p in points]
    scales = [1.0] * len(points) if scales is None else [float(s) for s in scales]
    if len(scales) != len(points):
        raise ValueError('scales must have one value per point')
    if hide_source:
        source_object.hide_render = True
    if mode == 'duplicates':
        out = []
        target = _collection(collection)
        for i, (p, s) in enumerate(zip(points, scales)):
            copy = bpy.data.objects.new(f'{name}.{i:05d}', source_object.data)
            copy.location, copy.scale = p, (s, s, s)
            target.objects.link(copy)
            out.append(copy)
        return out
    if mode != 'nodes':
        raise ValueError("mode must be 'nodes' or 'duplicates'")
    data = bpy.data.meshes.new(name)
    data.from_pydata(points, [], [])
    attribute = data.attributes.new('awwo_scale', 'FLOAT', 'POINT')
    attribute.data.foreach_set('value', scales)
    data.update()
    obj = bpy.data.objects.new(name, data)
    _collection(collection).objects.link(obj)
    modifier = obj.modifiers.new('awwo_instances', 'NODES')
    modifier.node_group = _instance_nodes(name + '_nodes', source_object, realize)
    return obj


def solidify(obj, thickness=0.01, offset=0.0, even=False):
    """Adds Blender's Solidify modifier (thickness in metres; offset -1 inward .. 1 outward) and returns it: how a
    minimal surface or a flat panel gets its thickness. even=True keeps the wall exactly `thickness` at creases, but
    divides by the cosine between face and vertex normals, so one needle triangle can throw a long spike."""
    modifier = obj.modifiers.new('awwo_solidify', 'SOLIDIFY')
    modifier.thickness = float(thickness)
    modifier.offset = float(offset)
    modifier.use_even_offset = bool(even)
    if hasattr(modifier, 'use_quality_normals'):
        modifier.use_quality_normals = True
    return modifier
