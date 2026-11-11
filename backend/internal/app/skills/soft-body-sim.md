---
name: soft-body-sim
title: Soft bodies, cloth and rope people can handle, simulated in the page
title_zh: 可以上手的软体、布料与绳索：页面内的物理模拟
description: Use when a page needs something that deforms and recovers under the hand (jelly, dough, a balloon, cloth, rope, a body turned on a lathe), simulated live in JavaScript with position-based dynamics and compliance (XPBD): the substep loop, distance, volume and shape constraints with their formulas, building the body from a signed distance, the finer mesh that rides on it, grabbing and twisting, tuning in physical words, the budget that keeps 60 frames a second, and the tests and planted failures that show it holds.
description_zh: 页面需要能在手里变形并恢复的东西（果冻、面团、气球、布料、绳索、车床旋出的回转体），并用 JavaScript 实时模拟时使用。方法是带柔度的基于位置的动力学（XPBD）：子步循环，距离、体积、形状约束及其公式，从有符号距离场构建身体，骑在其上的精细网格，抓取与扭转，用物理词汇调参，保持 60 帧的预算，以及证明它稳定的测试与植入缺陷。
category: engineering
applies: html,code,motion
version: 1
attribution:
---
# Soft bodies in the page

Position-based dynamics with compliance (XPBD) moves particles straight to where their constraints want them. It does not blow up at large steps, its softness is a number with a physical meaning, and it is deterministic, which a recorded page needs. Use it instead of springs integrated by hand.

## The loop

Run fixed frames of 1/60 s; split each into n substeps of h = 1 / (60 n), n from 8 to 12. Many substeps with one pass over the constraints beat one step with many passes. Per substep:

1. For every particle: `v.y -= g * h`; `v *= exp(-drag * h)`; `prev = x`; `x += v * h`.
2. Solve each constraint once, in a fixed order shuffled once at start so no direction is favoured.
3. Collide. A floor at y0: where `x.y < y0`, set `x.y = y0` and take back the sideways part of this substep's move by the factor `min(1, mu * depth / |sideways|)`, which is friction.
4. `v = (x - prev) / h`, then cap its length.

After the frame, damp velocities along edges (below) and put the body to sleep when its kinetic energy per unit mass stays under a small threshold.

## Constraints

For a constraint C over particles with inverse masses w and gradients g: `lambda = -C / (sum(w |g|^2) + a / h^2)`, then each particle moves by `w * lambda * g`. The compliance a is softness: 0 is rigid.

| Constraint | C | Gradients | Use |
|---|---|---|---|
| Distance | length of (xi - xj) minus the rest length | the unit direction, plus and minus | edges, rope, cloth stretch |
| Volume of a tetrahedron | 6 (V - V0) | for each corner, the cross product of the opposite face's two edges | keeps jelly from collapsing |
| Bend | distance between particles two apart | as distance | rope and cloth stiffness |
| Pressure | a closed surface's volume minus k times its rest volume | per vertex, a third of the sum of its triangles' area normals | balloons, inflating pouches |

- A tetrahedron squeezed under a quarter of its rest volume gets a = 0 on its volume constraint, so it cannot stay inverted.
- Shape matching, per tetrahedron or per cluster, is the cheapest stable elasticity. Keep each particle's rest offset q from the cluster's mass centre. Each substep: find the current centre c, build A = sum(m (x - c) q^T), extract its rotation R (start from last substep's quaternion and iterate twice), and pull each particle towards `c + R q` by the factor `1 / (1 + a')`. Add the volume constraint after it. This gives jelly that wobbles and always comes back.

## Building the body

- From a signed distance sd(p): lay a lattice with cells about a twelfth of the body's length. Keep the cells whose centre has `sd < 0.4 * cell`. Split each cube into five tetrahedra, alternating the split by the parity of i + j + k so neighbours' faces match. Move boundary nodes onto the surface along the gradient of sd; undo part of a move that leaves a tetrahedron under an eighth of its regular volume. Make every volume positive by swapping two corners.
- A corner gets a quarter of each of its tetrahedra's mass; an inverse mass of 0 pins it.
- Vary softness by place: read each tetrahedron's region from where its corners lie at rest (a firm core, a softer skin, floppy fins) and scale its compliance.
- Draw a finer mesh than you simulate. Mesh the same sd at a fifth of the cell (surface nets), and at rest bind every drawn vertex to the tetrahedron that contains it, by its four barycentric weights (find it through a spatial hash; outside every tetrahedron, take the one whose smallest weight is largest). Each frame a drawn vertex is the weighted sum of its four particles. Things inside the body (seeds, bubbles, a core) bind the same way and move with it.
- Use fewer dimensions when the subject allows. A rope is a chain. Cloth is a grid with stretch, shear and bend. A body turned about an axis (glass on a pipe, clay on a wheel) is one profile of radii along the axis with a volume per ring: a hundred times cheaper, and it handles the same.

## Handling

- Pick by a ray against the drawn triangles as they are now; if it misses, take the particle nearest the pointer on screen.
- Gather the particles within a radius of the hit, each weighted by a smooth falloff. Every substep pull them towards `target + R * offset` through a compliant constraint; never write positions. Limit how far the target may leave where it started, keep it above the floor, and raise the air drag while holding so the body follows instead of thrashing. Releasing keeps the velocity.
- The wheel, or a second finger, turns R about the view axis: a twist.
- A verb is an impulse added to velocities (a slap, a kick, a puff), sized by mass. To inflate or melt a region, ease its rest shape and rest volumes over about a second and let the solver follow.

## Tuning in words

| Word | Number |
|---|---|
| trembling to set | compliance on a log scale across about two decades, driven by one slider |
| lively to syrupy | a rate r from 2 to 40 per second, applied to the relative speed along each edge as `1 - exp(-r * h)` |
| grippy to slippery | friction mu from 0.8 down to 0.1 |
| heavy | more sag and a slower return: raise gravity or the compliance; scaling every mass alike changes little but how hard a grab or an impulse must pull |

State the scale ("1 unit is 2 cm") so gravity and the readouts mean something.

## Budget

- About 1,200 particles and 3,500 tetrahedra with 10 substeps cost 4 to 6 ms a frame in typed arrays (Float32Array for positions, previous positions and velocities; Uint32Array for indices). No allocation inside the loop, no objects per particle, no closures per constraint.
- When a step averages over 11 ms, drop substeps one at a time, not below 6.
- Guard: sample a few coordinates each frame; a value that is not finite resets the body to rest with a small drop and reports it.
- Readouts come from the solver: volume as the sum of tetrahedra over the rest sum, length between two named particles, kinetic energy.

## Tests and planted failures

Step the solver directly, with no animation frames:

1. After 600 steps at rest the volume is within 3 % of rest and no particle is below the floor.
2. Dropped from a height, the body's energy per mass falls under the sleep threshold within 5 s of simulated time.
3. Held 0.5 units aside for 60 steps and released, it returns within 2 % of its rest length in 4 s.
4. The same seed and the same scripted inputs give the same checksum of positions twice.
5. Inflating a region by 30 % raises the measured volume by 25 to 35 % of that region's share.

Plants: gravity with the wrong sign (1 fails), the volume constraint switched off (1 or 5), friction 0 (2), one substep a frame (3 or 4 drifts), the falloff weight left out of the grab (3).

## Before you hand over

1. Fixed steps and substeps; one pass per substep; a clamped frame time.
2. Volume kept; inverted elements recover; nothing passes the floor.
3. Typed arrays, no allocation in the loop, a measured step time shown in the notes.
4. Grab through a compliant pull with falloff, reach limited, release keeps velocity.
5. A drawn mesh finer than the simulated one, bound by weights.
6. The tests above with at least three plants, and their numbers in the hand-over.
