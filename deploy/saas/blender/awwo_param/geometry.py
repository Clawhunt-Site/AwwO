"""Plain geometry the generators return: a Mesh (vertices + faces) and Curves (polylines). Only floats, ints, lists and
tuples, so an agent can put counts and bounds straight into a JSON result. Metres, Z up; faces are counter-clockwise
seen from outside (or from above, for flat meshes)."""
import math
from dataclasses import dataclass, field

import numpy as np


def _bounds(points):
    if not points:
        return (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)
    xs, ys, zs = zip(*points)
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def _scale3(s):
    if isinstance(s, (int, float)):
        return float(s), float(s), float(s)
    sx, sy, sz = s
    return float(sx), float(sy), float(sz)


@dataclass(repr=False)
class Mesh:
    """vertices: [(x, y, z)]; faces: [(i, j, k, ...)] triangles, quads or n-gons indexing vertices."""
    vertices: list = field(default_factory=list)
    faces: list = field(default_factory=list)

    def __repr__(self):
        """Its counts, not its lists: a mesh printed, or a method of it named but not called, is one short line (a
        lattice printed whole, 270,000 vertices, once made a Blender call's answer too large to read)."""
        return f'Mesh({len(self.vertices):,} vertices, {len(self.faces):,} faces)'

    @staticmethod
    def merged(*meshes):
        return merged(*meshes)

    def translated(self, dx=0.0, dy=0.0, dz=0.0):
        return Mesh([(x + dx, y + dy, z + dz) for x, y, z in self.vertices], list(self.faces))

    def scaled(self, s):
        """s: one factor or (sx, sy, sz), about the origin. A mirroring scale reverses the faces so they keep facing out."""
        sx, sy, sz = _scale3(s)
        faces = list(self.faces)
        if sx * sy * sz < 0:
            faces = [tuple(reversed(f)) for f in faces]
        return Mesh([(x * sx, y * sy, z * sz) for x, y, z in self.vertices], faces)

    def bounds(self):
        """((minx, miny, minz), (maxx, maxy, maxz)); zeros for an empty mesh."""
        return _bounds(self.vertices)

    def triangle_count(self):
        return sum(len(f) - 2 for f in self.faces)

    def area(self):
        """Total face area (each n-gon fanned from its first vertex, exact for planar convex faces)."""
        total = 0.0
        v = self.vertices
        for f in self.faces:
            ax, ay, az = v[f[0]]
            for i in range(1, len(f) - 1):
                bx, by, bz = v[f[i]]
                cx, cy, cz = v[f[i + 1]]
                ux, uy, uz = bx - ax, by - ay, bz - az
                wx, wy, wz = cx - ax, cy - ay, cz - az
                total += 0.5 * math.sqrt((uy * wz - uz * wy) ** 2 + (uz * wx - ux * wz) ** 2 + (ux * wy - uy * wx) ** 2)
        return total

    def volume(self):
        """Signed enclosed volume (divergence theorem); meaningful only for a closed mesh with outward faces."""
        total = 0.0
        v = self.vertices
        for f in self.faces:
            ax, ay, az = v[f[0]]
            for i in range(1, len(f) - 1):
                bx, by, bz = v[f[i]]
                cx, cy, cz = v[f[i + 1]]
                total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
        return total / 6.0

    def summary(self):
        """Counts and bounds as plain JSON-ready values."""
        lo, hi = self.bounds()
        return {'vertices': len(self.vertices), 'faces': len(self.faces), 'triangles': self.triangle_count(),
                'bounds': [list(lo), list(hi)]}


def merged(*meshes):
    """One Mesh holding all the given meshes (indices shifted; vertices are not welded)."""
    vertices, faces = [], []
    for mesh in meshes:
        base = len(vertices)
        vertices.extend(mesh.vertices)
        faces.extend(tuple(i + base for i in f) for f in mesh.faces)
    return Mesh(vertices, faces)


@dataclass(repr=False)
class Curves:
    """polylines: [[(x, y, z), ...]]; closed[i] says whether polyline i joins its last point back to its first."""
    polylines: list = field(default_factory=list)
    closed: list = field(default_factory=list)

    def __repr__(self):
        """Its counts, not its points (Mesh.__repr__)."""
        return f'Curves({len(self.polylines):,} polylines, {self.point_count():,} points)'

    @staticmethod
    def merged(*curves):
        out = Curves()
        for c in curves:
            out.polylines.extend(c.polylines)
            out.closed.extend(c.closed)
        return out

    def translated(self, dx=0.0, dy=0.0, dz=0.0):
        return Curves([[(x + dx, y + dy, z + dz) for x, y, z in line] for line in self.polylines], list(self.closed))

    def scaled(self, s):
        sx, sy, sz = _scale3(s)
        return Curves([[(x * sx, y * sy, z * sz) for x, y, z in line] for line in self.polylines], list(self.closed))

    def bounds(self):
        return _bounds([p for line in self.polylines for p in line])

    def point_count(self):
        return sum(len(line) for line in self.polylines)

    def lengths(self):
        out = []
        for line, closed in zip(self.polylines, self.closed):
            pts = line + line[:1] if closed and line else line
            out.append(sum(math.dist(a, b) for a, b in zip(pts, pts[1:])))
        return out

    def summary(self):
        lo, hi = self.bounds()
        return {'polylines': len(self.polylines), 'points': self.point_count(), 'closed': sum(map(bool, self.closed)),
                'bounds': [list(lo), list(hi)]}


# A box's corners are numbered as bits (u, v, w) = i + 2j + 4k; these faces are counter-clockwise seen from outside
# for a right-handed (u, v, w).
BOX_FACES = ((0, 4, 6, 2), (1, 3, 7, 5), (0, 1, 5, 4), (2, 6, 7, 3), (0, 2, 3, 1), (4, 5, 7, 6))


def _sub(a, b):
    return a[0] - b[0], a[1] - b[1], a[2] - b[2]


def _cross(a, b):
    return a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]


def _unit(a):
    n = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    if n == 0.0:
        raise ValueError('zero-length direction')
    return a[0] / n, a[1] / n, a[2] / n


def box(center, axes, half):
    """An oriented box: axes = (u, v, w) unit vectors, right-handed; half = half extents along them."""
    (u, v, w), (a, b, c) = axes, half
    verts = []
    for k in (-1, 1):
        for j in (-1, 1):
            for i in (-1, 1):
                verts.append(tuple(center[n] + i * a * u[n] + j * b * v[n] + k * c * w[n] for n in range(3)))
    return Mesh(verts, list(BOX_FACES))


def beam(p0, p1, width, depth, up=(0.0, 0.0, 1.0)):
    """A box from p0 to p1 (its axis), `width` across (perpendicular to `up`) and `depth` along `up`."""
    p0, p1 = tuple(map(float, p0)), tuple(map(float, p1))
    u = _unit(_sub(p1, p0))
    v = _unit(_cross(up, u))
    w = _cross(u, v)
    center = tuple((p0[n] + p1[n]) / 2 for n in range(3))
    return box(center, (u, v, w), (math.dist(p0, p1) / 2, width / 2, depth / 2))


def extrude_flat(mesh, depth):
    """A closed solid from a flat, welded mesh at z = 0 whose faces face +z: the faces again at z = depth, reversed at
    z = 0, and walls along every boundary edge (an edge no other face uses the other way round)."""
    n = len(mesh.vertices)
    verts = [(x, y, 0.0) for x, y, _z in mesh.vertices] + [(x, y, float(depth)) for x, y, _z in mesh.vertices]
    faces = [tuple(i + n for i in f) for f in mesh.faces] + [tuple(reversed(f)) for f in mesh.faces]
    directed = set()
    for f in mesh.faces:
        for a, b in zip(f, f[1:] + f[:1]):
            directed.add((a, b))
    for f in mesh.faces:
        for a, b in zip(f, f[1:] + f[:1]):
            if (b, a) not in directed:
                faces.append((a, b, b + n, a + n))
    return Mesh(verts, faces)


MAX_EXTENT = 1e6  # metres: no generator's point may lie farther than this from the origin


def ensure_finite(result):
    """The last check every generator's result goes through (a Mesh, Curves, or a list of points or numbers): a
    coordinate that is not finite (an overflow, a NaN from bad input) or lies beyond MAX_EXTENT raises ValueError
    rather than reaching Blender. Returns the result unchanged."""
    if isinstance(result, Mesh):
        values = result.vertices
    elif isinstance(result, Curves):
        values = [p for line in result.polylines for p in line]
    else:
        values = result
    if len(values):
        array = np.asarray(values, dtype=np.float64)
        if not np.all(np.isfinite(array)):
            raise ValueError('the result has non-finite coordinates (an overflow, or a NaN or infinity in the input)')
        if np.abs(array).max() > MAX_EXTENT:
            raise ValueError(f'the result reaches beyond {MAX_EXTENT:g} m from the origin')
    return result


def check_extent(name, value):
    """Refuses a size (radius, length...) a generator would reach before it computes anything."""
    if not math.isfinite(value) or abs(value) > MAX_EXTENT:
        raise ValueError(f'{name} would reach {value:g} m, beyond the maximum {MAX_EXTENT:g} m')
    return value


def check_count(name, value, maximum):
    """The size guard every generator uses: an agent asking for 10^9 cells gets a clear error, not a hung Blender."""
    if not isinstance(value, (int, float)) or value != value:
        raise ValueError(f'{name} must be a number')
    if value > maximum:
        raise ValueError(f'{name} = {value} is beyond the maximum {maximum}')
    return value
