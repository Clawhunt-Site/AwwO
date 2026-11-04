"""Slime-mould (Physarum) transport networks after Jeff Jones (2010), "Characteristics of pattern formation and
evolution in approximations of Physarum transport networks": agents that sense a trail ahead, turn towards the most of
it, move and deposit, on a trail map that diffuses and decays. Food points deposit all the time, so the network links
them (the owner's 黏菌算法 road networks between city nodes). Then contours() and heightfield() turn the map into
curves or a relief mesh."""
import math

import numpy as np

from . import _march
from .geometry import Curves, Mesh, check_count, ensure_finite

MAX_SIDE = 1024
MAX_AGENTS = 500_000
MAX_STEPS = 5000
MAX_WORK = 200_000_000   # agents x steps (about a minute of numpy at most)
MAX_HEIGHTFIELD_VERTICES = 1_000_000
MAX_FIELD_CELLS = 4 * MAX_SIDE * MAX_SIDE  # a field given to contours() or heightfield()
MAX_FOOD = 256
MAX_FOOD_RADIUS = 32         # pixels
MAX_SCENT_WORK = 64_000_000  # food points x map pixels: one pass over the map per food point for its scent
# deposit (food_strength: 10 times it): a pixel can gather every agent's deposit every step, at most MAX_WORK of them
# with no decay, which must stay finite. The map is normalised, so only food_strength / deposit shapes it.
MAX_DEPOSIT = 1e6


def _blur3(trail, wrap):
    """3 x 3 mean, separable."""
    p = np.pad(trail, 1, mode='wrap' if wrap else 'edge')
    rows = p[:, :-2] + p[:, 1:-1] + p[:, 2:]
    return (rows[:-2] + rows[1:-1] + rows[2:]) / 9.0


def physarum(width=256, height=256, agents=20000, steps=400, sensor_angle_deg=45.0, sensor_distance=9.0,
             turn_angle_deg=45.0, step=1.0, deposit=5.0, decay=0.9, diffuse=True, food=None, seed=0,
             food_strength=None, wrap=False, spawn='uniform', food_radius=6.0, food_reach=None):
    """The trail map (height x width, float32, 0..1, row = y) after `steps` steps of `agents` agents, vectorised
    over the agents. Each step every agent samples the trail at three sensors `sensor_distance` pixels ahead (straight,
    +-sensor_angle_deg), keeps going if the middle is strongest, turns randomly if it is weakest, else turns
    turn_angle_deg towards the stronger side; moves `step` pixels (at the border it stays and picks a new heading,
    unless wrap=True), and deposits `deposit`; then the map is blurred (diffuse, 3 x 3 mean) and multiplied by decay.
    Sensing and deposits are bilinear, so roads run in any direction, not along the pixel rows.
    food = [(x, y)] pixels: each deposits food_strength (default 10 x deposit) on a disc of food_radius pixels every
    step and gives off a faint scent reaching food_reach pixels (default 0.35 x the map's side) that guides agents off
    the network; an agent arriving at food leaves in a random direction and ignores that food's scent until it reaches
    another, so it heads on to a neighbour. Together they pin the network to the food points and grow roads between
    them, as in Jones's nutrient experiments; like the real mould, which roads form depends on the seed. Around the
    default 400 steps most food points are linked; much longer runs contract to fewer, straighter roads.
    spawn='food' starts the agents on the food points instead of everywhere. Bounds: sensor_distance and step at
    most the map's longer side, food_radius at most MAX_FOOD_RADIUS, food_reach at most 10 x the side, at most
    MAX_FOOD food points and MAX_SCENT_WORK food points x pixels.
    Normalised by the 99.5th percentile of the network (food spots left out) and clipped to 0..1."""
    for name, value, top in (('width', width, MAX_SIDE), ('height', height, MAX_SIDE), ('agents', agents, MAX_AGENTS),
                             ('steps', steps, MAX_STEPS)):
        if not (isinstance(value, int) and value >= 1):
            raise ValueError(f'{name} must be a positive integer')
        check_count(name, value, top)
    check_count('agents x steps', agents * steps, MAX_WORK)
    # Every length in pixels is bounded (by the map, or a documented maximum) before anything is sized from it.
    side = max(width, height)
    if not 0.0 <= decay <= 1.0:
        raise ValueError('decay must be in 0..1')
    if not (0.0 < sensor_distance <= side and 0.0 < step <= side):
        raise ValueError(f"sensor_distance and step must be in (0, {side}] pixels (the map's longer side)")
    if not 0.0 <= food_radius <= MAX_FOOD_RADIUS:
        raise ValueError(f'food_radius must be in 0..{MAX_FOOD_RADIUS} pixels')
    if food_reach is not None and not 0.0 < food_reach <= 10.0 * side:
        raise ValueError(f'food_reach must be in (0, {10 * side}] pixels')
    if not all(math.isfinite(v) for v in (sensor_angle_deg, turn_angle_deg, deposit,
                                           0.0 if food_strength is None else food_strength)):
        raise ValueError('the angles, deposit and food_strength must be finite numbers')
    if abs(deposit) > MAX_DEPOSIT or (food_strength is not None and abs(food_strength) > 10 * MAX_DEPOSIT):
        raise ValueError(f'deposit must be at most {MAX_DEPOSIT:g} and food_strength at most {10 * MAX_DEPOSIT:g} '
                         '(the map is normalised: only food_strength / deposit shapes it)')
    if spawn not in ('uniform', 'food'):
        raise ValueError("spawn must be 'uniform' or 'food'")
    rng = np.random.default_rng(seed)
    size = np.array([width, height], dtype=np.float64)
    food = np.array(food if food is not None else [], dtype=np.float64).reshape(-1, 2)
    check_count('food points', len(food), MAX_FOOD)
    check_count('food points x map pixels', len(food) * width * height, MAX_SCENT_WORK)
    if len(food) and not (np.all(np.isfinite(food)) and np.all(food >= 0) and np.all(food < size)):
        raise ValueError('food points must lie inside the map, as (x, y) pixels')
    food_index = None
    if len(food):
        # Each food point covers a small disc, wider than one strand, so agents passing near it are caught; each disc
        # is drawn only where it overlaps the map.
        at_food = np.zeros((height, width), dtype=bool)
        which_food = np.full((height, width), -1, dtype=np.int64)
        r = int(math.ceil(food_radius))
        for k, (x, y) in enumerate(food.astype(np.int64).tolist()):
            x0, x1, y0, y1 = max(x - r, 0), min(x + r + 1, width), max(y - r, 0), min(y + r + 1, height)
            yy, xx = np.mgrid[y0:y1, x0:x1]
            disc = (xx - x) ** 2 + (yy - y) ** 2 <= food_radius * food_radius
            at_food[y0:y1, x0:x1] |= disc
            which_food[y0:y1, x0:x1][disc] = k
        at_food, which_food = at_food.reshape(-1), which_food.reshape(-1)
        food_index = np.nonzero(at_food)[0]
        # A faint attractant reaching across the map: off the network agents climb it towards food; on the network
        # the trail, far stronger, decides. Past the saddle between two foods it leads on to the other one.
        reach = 0.35 * max(width, height) if food_reach is None else float(food_reach)
        gy, gx = np.mgrid[0:height, 0:width] + 0.5
        scent = np.zeros((height, width))
        for x, y in food:
            scent += np.exp(-np.hypot(gx - x - 0.5, gy - y - 0.5) / reach)
        scent = (deposit * scent).reshape(-1)
    food_amount = 10.0 * deposit if food_strength is None else float(food_strength)
    if spawn == 'food' and len(food):
        pos = food[rng.integers(0, len(food), agents)] + 0.5 + rng.uniform(-1.0, 1.0, (agents, 2))
        pos = np.clip(pos, 0.0, size - 1e-6)
    else:
        pos = rng.random((agents, 2)) * size
    heading = rng.random(agents) * 2.0 * math.pi
    was_at_food = np.ones(agents, dtype=bool)
    last_food = np.full(agents, -1, dtype=np.int64)
    trail = np.zeros((height, width), dtype=np.float64)
    sa, ra = math.radians(sensor_angle_deg), math.radians(turn_angle_deg)

    def corners(x, y):
        """The four pixels round (x, y) (pixel centres at +0.5) and their bilinear weights. Bilinear sensing and
        deposits keep the network isotropic: with whole pixels, trails along the pixel rows read stronger and the
        roads come out axis-aligned."""
        x, y = x - 0.5, y - 0.5
        x0, y0 = np.floor(x), np.floor(y)
        fx, fy = x - x0, y - y0
        x0, y0 = x0.astype(np.int64), y0.astype(np.int64)
        out = []
        for dx, dy, wgt in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            cx, cy = x0 + dx, y0 + dy
            if wrap:
                cx, cy = cx % width, cy % height
            else:
                cx, cy = np.clip(cx, 0, width - 1), np.clip(cy, 0, height - 1)
            out.append((cy * width + cx, wgt))
        return out

    def sense(angle):
        x, y = pos[:, 0] + sensor_distance * np.cos(angle), pos[:, 1] + sensor_distance * np.sin(angle)
        if food_index is None:
            return sum(trail.reshape(-1)[i] * w for i, w in corners(x, y))
        flat = trail.reshape(-1) + scent
        value = sum(flat[i] * w for i, w in corners(x, y))
        # An agent that has just fed ignores that food's scent, so it heads on to another food instead of
        # climbing straight back: that is what lays roads between food points rather than stubs round each.
        fed = last_food >= 0
        own = food[np.maximum(last_food, 0)] + 0.5
        return value - np.where(fed, deposit * np.exp(-np.hypot(x - own[:, 0], y - own[:, 1]) / reach), 0.0)

    for _ in range(steps):
        ahead, left, right = sense(heading), sense(heading + sa), sense(heading - sa)
        keep = (ahead > left) & (ahead > right)
        lost = ~keep & (ahead < left) & (ahead < right)
        coin = rng.random(agents) < 0.5
        turn = np.where(lost, np.where(coin, ra, -ra), 0.0)
        turn += np.where(~keep & ~lost & (left > right), ra, 0.0)
        turn -= np.where(~keep & ~lost & (right > left), ra, 0.0)
        heading += turn
        moved = pos + step * np.stack([np.cos(heading), np.sin(heading)], axis=1)
        if wrap:
            moved %= size
        else:
            out = np.any((moved < 0.0) | (moved >= size), axis=1)
            moved[out] = pos[out]
            heading[out] = rng.random(int(out.sum())) * 2.0 * math.pi
        pos = moved
        if food_index is not None:
            # An agent arriving at food turns round, so agents shuttle between food points along the trail they
            # came by and the links between them keep being reinforced (otherwise they pass through and decay).
            pixel = np.floor(pos[:, 1]).astype(np.int64) * width + np.floor(pos[:, 0]).astype(np.int64)
            here = at_food[pixel]
            arrived = here & ~was_at_food
            heading = np.where(arrived, rng.random(agents) * 2.0 * math.pi, heading)
            last_food = np.where(arrived, which_food[pixel], last_food)
            was_at_food = here
        for index, weight in corners(pos[:, 0], pos[:, 1]):
            trail += deposit * np.bincount(index, weights=weight, minlength=width * height).reshape(height, width)
        if food_index is not None:
            np.add.at(trail.reshape(-1), food_index, food_amount)
        if diffuse:
            trail = _blur3(trail, wrap)
        trail *= decay
    # Within the bounds the map stays finite; were it not, a map of NaNs would pass for a result.
    if not np.all(np.isfinite(trail)):
        raise ValueError('the trail map overflowed: lower deposit and food_strength (only their ratio shapes it)')
    # The scale comes from the network itself, not the food spots, which are brighter than any road.
    network = trail.reshape(-1)[~at_food] if food_index is not None else trail.reshape(-1)
    scale = float(np.percentile(network, 99.5)) if network.size else 0.0
    if scale <= 0.0:
        scale = float(trail.max())
    if scale <= 0.0:
        return np.zeros((height, width), dtype=np.float32)
    return np.clip(trail / scale, 0.0, 1.0).astype(np.float32)


def _extent(field, size):
    rows, cols = np.asarray(field).shape
    if rows < 2 or cols < 2:
        raise ValueError('field must be a 2D grid of at least 2 x 2')
    w, h = (1.0, (rows - 1) / (cols - 1)) if size is None else (float(size[0]), float(size[1]))
    if not (w > 0 and h > 0):
        raise ValueError('size must be positive')
    return rows, cols, w, h


def _field2d(field):
    field = np.asarray(field, dtype=np.float64)
    if field.ndim != 2:
        raise ValueError('field must be a 2D grid')
    check_count('field cells', field.size, MAX_FIELD_CELLS)
    if not np.all(np.isfinite(field)):
        raise ValueError('field has values that are not finite')
    return field


def contours(field, level=0.5, size=None):
    """Iso-lines of a 2D field (row = y, row 0 at y = 0) by marching squares, as Curves at z = 0 spanning
    size = (w, h) metres (default 1 m wide, the field's aspect). Lines keep the region above `level` on their left;
    lines that meet the border stay open."""
    field = _field2d(field)
    if not math.isfinite(level):
        raise ValueError('level must be a finite number')
    rows, cols, w, h = _extent(field, size)
    out = Curves()
    for points, closed in _march.marching_squares(field, float(level)):
        out.polylines.append([(float(c) * w / (cols - 1), float(r) * h / (rows - 1), 0.0) for c, r in points])
        out.closed.append(bool(closed))
    return ensure_finite(out)


def heightfield(field, size=None, height=0.2, step=2):
    """A grid mesh over size = (w, h) metres (default 1 m wide, the field's aspect) whose z is height x the field,
    sampled every `step` cells (the last row and column always kept). Quads facing +z."""
    field = _field2d(field)
    if not (isinstance(step, int) and step >= 1):
        raise ValueError('step must be a positive integer')
    rows, cols, w, h = _extent(field, size)
    r_idx = sorted(set(range(0, rows, step)) | {rows - 1})
    c_idx = sorted(set(range(0, cols, step)) | {cols - 1})
    check_count('vertices', len(r_idx) * len(c_idx), MAX_HEIGHTFIELD_VERTICES)
    sub = field[np.ix_(r_idx, c_idx)]
    xs = np.array(c_idx) * w / (cols - 1)
    ys = np.array(r_idx) * h / (rows - 1)
    gx, gy = np.meshgrid(xs, ys)
    vertices = np.stack([gx.ravel(), gy.ravel(), height * sub.ravel()], axis=1)
    nr, nc = len(r_idx), len(c_idx)
    index = np.arange(nr * nc).reshape(nr, nc)
    quads = np.stack([index[:-1, :-1], index[:-1, 1:], index[1:, 1:], index[1:, :-1]], axis=-1).reshape(-1, 4)
    return ensure_finite(Mesh([tuple(v) for v in vertices.tolist()], [tuple(q) for q in quads.tolist()]))
