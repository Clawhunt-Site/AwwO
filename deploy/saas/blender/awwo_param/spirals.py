"""Phyllotaxis and spirals (after 斐波拉济图形, 阿基米德费马螺旋线, 渐伸线, 螺旋缠绕线): Vogel's sunflower model and
its cousins on a sphere, cylinder and cone (points plus a size for instancing), planar spirals, a helix, and spirals
wound round a sphere, torus or cylinder."""
import math

import numpy as np

from .geometry import MAX_EXTENT, Curves, check_count, check_extent, ensure_finite

GOLDEN_ANGLE = 180.0 * (3.0 - math.sqrt(5.0))  # 137.50776... degrees
MAX_POINTS = 100_000
MAX_TURNS = 10_000


def _spacing(area_per_point):
    """Half the nearest-neighbour distance of a hexagonal packing with this area per point: the radius at which
    instanced spheres just touch."""
    return 0.5 * np.sqrt(2.0 * np.asarray(area_per_point) / math.sqrt(3.0))


def phyllotaxis(n=500, c=0.05, angle_deg=GOLDEN_ANGLE, surface='disc', radius=1.0, height=1.0, power=0.5):
    """n points k = 0..n-1, each turned angle_deg (the golden angle) from the last, and each point's scale (the
    radius at which spheres instanced there touch their neighbours). surface:
    'disc'     Vogel's model: r = c * k**power (power 0.5 packs evenly; above it the outer points spread and grow);
    'sphere'   the Fibonacci lattice: z = radius * (1 - 2 (k + 0.5) / n), evenly spread;
    'cylinder' z = height * (k + 0.5) / n on a cylinder of `radius`;
    'cone'     apex at (0, 0, height), base of `radius` on z = 0, Vogel's model on the unrolled cone.
    Returns (points [(x, y, z)], scales [s])."""
    if not isinstance(n, int) or n < 1:
        raise ValueError('n must be a positive integer')
    check_count('n', n, MAX_POINTS)
    if not (c > 0 and radius > 0 and height > 0 and 0 < power <= 4):
        raise ValueError('c, radius and height must be positive and power in (0, 4]')
    check_extent('the disc', c * max(n - 1, 1) ** power if surface == 'disc' else max(radius, height))
    if not math.isfinite(angle_deg):
        raise ValueError('angle_deg must be a finite number')
    k = np.arange(n, dtype=np.float64)
    theta = np.radians(angle_deg) * k
    if surface == 'disc':
        r = c * k ** power
        x, y, z = r * np.cos(theta), r * np.sin(theta), np.zeros(n)
        area = math.pi * c * c * 2.0 * power * (k + 0.5) ** (2.0 * power - 1.0)
    elif surface == 'sphere':
        z = radius * (1.0 - 2.0 * (k + 0.5) / n)
        rho = np.sqrt(np.maximum(radius * radius - z * z, 0.0))
        x, y = rho * np.cos(theta), rho * np.sin(theta)
        area = np.full(n, 4.0 * math.pi * radius * radius / n)
    elif surface == 'cylinder':
        x, y, z = radius * np.cos(theta), radius * np.sin(theta), height * (k + 0.5) / n
        area = np.full(n, 2.0 * math.pi * radius * height / n)
    elif surface == 'cone':
        slant = math.hypot(radius, height)
        kappa = (k + 0.5) / n
        s = slant * kappa ** power
        rho = radius * s / slant
        x, y, z = rho * np.cos(theta), rho * np.sin(theta), height * (1.0 - s / slant)
        area = 2.0 * math.pi * radius * slant * power * kappa ** (2.0 * power - 1.0) / n
    else:
        raise ValueError("surface must be 'disc', 'sphere', 'cylinder' or 'cone'")
    points = [tuple(p) for p in np.stack([x, y, z], axis=1).tolist()]
    return ensure_finite(points), ensure_finite(_spacing(area).tolist())


SPIRALS = {'archimedean': (0.0, 0.03), 'fermat': (0.2, None), 'logarithmic': (0.05, 0.1), 'involute': (0.03, None)}


def spiral(kind='archimedean', turns=5, a=None, b=None, points=400):
    """A planar spiral (z = 0) over `turns` turns, as one open polyline sampled evenly in angle theta:
    'archimedean' r = a + b * theta (defaults a = 0, b = 0.03 m per radian);
    'fermat'      r = a * sqrt(theta), both branches through the origin (a = 0.2);
    'logarithmic' r = a * exp(b * theta) (a = 0.05, b = 0.1; the golden spiral is b = 0.3063);
    'involute'    the involute of a circle of radius a (= 0.03): r = a * sqrt(1 + theta^2)."""
    if kind not in SPIRALS:
        raise ValueError(f'unknown spiral {kind!r}; one of {sorted(SPIRALS)}')
    if not (isinstance(points, int) and points >= 2):
        raise ValueError('points must be an integer >= 2')
    check_count('points', points, MAX_POINTS)
    check_count('turns', turns, MAX_TURNS)
    if not turns > 0:
        raise ValueError('turns must be positive')
    da, db = SPIRALS[kind]
    a = da if a is None else float(a)
    b = db if b is None else float(b)
    if not (math.isfinite(a) and (b is None or math.isfinite(b))):
        raise ValueError('a and b must be finite numbers')
    # The farthest the spiral reaches, worked out before any point is (exp overflows past b * theta of about 709).
    end = 2.0 * math.pi * turns
    if kind == 'logarithmic':
        if a and b * end + math.log(abs(a)) > math.log(MAX_EXTENT):
            raise ValueError(f'a logarithmic spiral with a = {a:g}, b = {b:g} over {turns:g} turns would reach beyond '
                             f'{MAX_EXTENT:g} m: use fewer turns or a smaller b')
        reach = abs(a) * math.exp(max(b * end, 0.0))
    elif kind == 'archimedean':
        reach = abs(a) + abs(b) * end
    elif kind == 'fermat':
        reach = abs(a) * math.sqrt(end)
    else:
        reach = abs(a) * math.sqrt(1.0 + end * end)
    check_extent(f'the {kind} spiral', reach)
    t = np.linspace(0.0, end, points)
    if kind == 'involute':
        x, y = a * (np.cos(t) + t * np.sin(t)), a * (np.sin(t) - t * np.cos(t))
    else:
        r = {'archimedean': lambda: a + b * t, 'fermat': lambda: a * np.sqrt(t),
             'logarithmic': lambda: a * np.exp(b * t)}[kind]()
        x, y = r * np.cos(t), r * np.sin(t)
        if kind == 'fermat':
            x, y = np.concatenate([-x[:0:-1], x]), np.concatenate([-y[:0:-1], y])
    return ensure_finite(Curves([[(float(px), float(py), 0.0) for px, py in zip(x, y)]], [False]))


def helix(radius=1.0, pitch=0.5, turns=5, points=400):
    """A helix round the z axis from z = 0, rising `pitch` per turn."""
    if not (isinstance(points, int) and points >= 2):
        raise ValueError('points must be an integer >= 2')
    check_count('points', points, MAX_POINTS)
    check_count('turns', turns, MAX_TURNS)
    check_extent('the helix radius', radius)
    check_extent('the helix height', pitch * turns)
    t = np.linspace(0.0, 2.0 * math.pi * turns, points)
    pts = np.stack([radius * np.cos(t), radius * np.sin(t), pitch * t / (2.0 * math.pi)], axis=1)
    return ensure_finite(Curves([[tuple(p) for p in pts.tolist()]], [False]))


def wound(surface='sphere', turns=10, radius=1.0, minor_radius=0.3, height=2.0, points=800, strands=1):
    """Spirals wound round a surface (螺旋缠绕线), `strands` of them evenly offset in angle:
    'sphere'   from pole to pole while turning `turns` times about z (radius);
    'torus'    `turns` times round the tube while going once round the ring (radius = ring, minor_radius = tube);
               closed when turns is a whole number;
    'cylinder' `turns` times round a cylinder of `radius` from z = 0 to z = height."""
    if not (isinstance(points, int) and points >= 3 and isinstance(strands, int) and strands >= 1):
        raise ValueError('points (>= 3) and strands (>= 1) must be integers')
    check_count('points', points * strands, MAX_POINTS)
    check_count('turns', turns, MAX_TURNS)
    for name, value in (('radius', radius), ('minor_radius', minor_radius), ('height', height)):
        check_extent(name, value)
    closed = surface == 'torus' and float(turns).is_integer()
    t = np.linspace(0.0, 1.0, points, endpoint=not closed)
    lines = []
    for s in range(strands):
        spin = 2.0 * math.pi * (turns * t + s / strands)
        if surface == 'sphere':
            phi = math.pi * t
            pts = np.stack([radius * np.sin(phi) * np.cos(spin), radius * np.sin(phi) * np.sin(spin),
                            radius * np.cos(phi)], axis=1)
        elif surface == 'torus':
            u = 2.0 * math.pi * t
            ring = radius + minor_radius * np.cos(spin)
            pts = np.stack([ring * np.cos(u), ring * np.sin(u), minor_radius * np.sin(spin)], axis=1)
        elif surface == 'cylinder':
            pts = np.stack([radius * np.cos(spin), radius * np.sin(spin), height * t], axis=1)
        else:
            raise ValueError("surface must be 'sphere', 'torus' or 'cylinder'")
        lines.append([tuple(p) for p in pts.tolist()])
    return ensure_finite(Curves(lines, [closed] * strands))
