---
name: physical-props
title: Physical props: real sizes and masses
title_zh: 实物道具：真实尺寸与质量
description: Use when a page, layout, plan or simulation has to place real-world objects - a warehouse floor, a robot cell, a factory line, a shop or an office - and the sizes, heights, weights and gaps must hold up to someone who works with the real thing.
description_zh: 当页面、布局、方案或仿真要摆放真实物体（仓库地面、机器人工位、产线、门店、办公室），且尺寸、高度、重量、间距要经得起行内人检查时使用。
category: design
applies: html,design,plan
version: 1
attribution:
---
# Physical props

Scenes fail on numbers, not on shading: a forklift drawn the size of a car, a pallet rack a person could step over, a crate two fingers lift that would take two people. The table below is prop data from a simulation-grade asset library - footprint, height, mass and rigid-body count. Use it instead of guessing, and state every number you use.

You do not have these models. You have their figures. Build your own proxy geometry at these sizes.

## What these figures are, and are not

- **Sizes** are each asset's own bounding box, so they are as true as the model. **Mass** is the figure its author recorded, not a weighing. **Nothing else is here**: no clearance, no load capacity, no reach envelope, no turning radius, no payload rating. Where a plan needs one, state it as your own assumption or as a figure to source from the maker, and never derive it from a size.
- One scene unit is one metre. Say so in the page, and give the camera and grid in metres.
- Heights are the object standing on the floor. The two footprint numbers are the bounding box's floor extent; which is width and which is depth depends on how the asset was authored, so take the larger as the long side unless your layout needs otherwise - and a bounding box is not a thickness: the braced fence run below measures 2.04 m through its bracing, not a 2 m thick wall.

## The props

Every row is CC-BY 4.0, (c) NVIDIA unless the row names another holder.

| what | footprint (m) | height (m) | mass (kg) | bodies |
|---|---|---|---|---|
| forklift, counterbalance | 1.36 x 3.73 | 2.17 | 1730 | 32 |
| pallet jack, low profile | 0.65 x 1.63 | 1.27 | 164 | 8 |
| pallet jack, heavy duty | 0.68 x 1.60 | 1.20 | 168 | 9 |
| hand truck, convertible | 0.50 x 0.48 | 1.35 | 30 | 11 |
| platform cart | 0.67 x 1.22 | 0.95 | 142 | 6 |
| pallet, wooden | 1.21 x 1.00 | 0.21 | 62 | 1 |
| pallet rack bay, shelved | 3.10 x 0.70 | 2.50 | 797 | 1 |
| roller conveyor section | 2.10 x 2.07 | 1.17 | 128 | 29 |
| packing table, heavy duty | 1.87 x 1.22 | 0.99 | 226 | 1 |
| step ladder, rolling | 0.76 x 0.66 | 1.52 | 79 | 9 |
| safety fence run, braced | 2.04 x 6.03 | 2.30 | 542 | 4 |
| machine guard panel | 0.70 x 0.15 | 1.70 | 74 | 1 |
| stacking crate | 0.60 x 0.40 | 0.10 | 1.9 | 1 |
| cardboard carton | 0.34 x 0.26 | 0.17 | 0.2 | 1 |
| plastic basket | 0.25 x 0.33 | 0.13 | 0.7 | 5 |
| lidded container | 0.62 x 0.40 | 0.45 | 1.0 | 2 |
| steel drum | 0.64 x 0.66 | 0.87 | 102 | 2 |
| waste container | 0.48 x 0.37 | 0.70 | 46 | 3 |
| floor sign, folding | 0.31 x 0.31 | 0.92 | 49 | 1 |
| control panel, wall | 0.21 x 1.83 | 1.54 | 22 | 106 |
| desk | 0.80 x 1.80 | 0.76 | 121 | 1 |
| office chair | 0.62 x 0.71 | 1.09 | 8.2 | 13 |
| robot arm, floor standing (CC-BY 4.0, LucaDiRuscio) | 0.56 x 0.52 | 2.16 | 330 | 7 |
| robot, collaborative (CC-BY 4.0, Standard Bots) | 0.20 x 0.45 | 1.52 | 31 | 11 |
| gripper, two-finger 6 kg class (BSD-3-Clause, OnRobot A/S) | 0.10 x 0.08 | 0.28 | 1.1 | 12 |
| gripper, two-finger 14 kg class (BSD-3-Clause, OnRobot A/S) | 0.12 x 0.07 | 0.17 | 1.5 | 5 |

## Build the layout from the props, not from feel

Derive every gap by arithmetic from the props you placed, and write the arithmetic into the page or the plan:

1. **Lanes.** A straight lane is at least the width of the widest vehicle in it plus the clearance you state on each side: a forklift at 1.36 m in a lane with 0.5 m either side is 2.36 m. A pallet jack at 0.65 m passes where the forklift cannot. Where that forklift turns out of a lane, its 3.73 m length is a floor on the width of the aisle it turns into and nothing more - the figure that settles a turn is its turning radius, which is the maker's.
2. **Racks.** Across a 3.10 m bay, two pallets laid long side out (2 x 1.21 = 2.42 m) leave 0.68 m of upright and gap. Through the bay they overhang it: a 1.00 m deep pallet on a 0.70 m frame stands 0.15 m past each beam, which is how racking works - so measure the aisle from the load, not from the frame.
3. **Levels.** A 2.50 m bay with a floor level and two beam levels at 0.80 m pitch has decks at 0, 0.80 and 1.60 m. Above each 0.21 m pallet that leaves 0.59 m of load on the lower two and 0.69 m on the top, with 0.10 m of bay to spare. Three *beam* levels would put the top pallet at 2.61 m, past the bay: say which arrangement you drew.
4. **Transfers.** Conveyor top 1.17 m against table top 0.99 m is a 0.18 m lift; say which way the work moves and who lifts it.
5. **Reach is not here.** Height is not reach, in either direction. That a 2.16 m arm stands taller than a 1.81 m top deck, or the 1.52 m collaborative robot shorter than it, says only where each bounding box ends - an arm reaches above its own height when extended. Whether either serves that bay is a reach envelope, which this table does not carry: call it unknown, name what to source, and never conclude a reach from a height.
6. **Payload is not here either.** The grippers' "6 kg class" and "14 kg class" come from their asset names: makers' ratings, not measurements. What the table does settle is what they would lift. Either takes the carton (0.2 kg), basket (0.7 kg), container (1.0 kg) or crate (1.9 kg); neither comes near the drum (102 kg) or a pallet (62 kg before any load), so pallets move by jack or forklift. Anything between, and any stack limit, needs a rating you sourced.
7. **Footprint before furniture.** Lay the fixed props (racks, conveyors, fences, panels) first, then the lanes, then the loose props. A plan whose lanes come last always ends up with a lane through a rack.
8. **Enclosures.** A 6.03 m braced run and a 0.70 m guard panel are the two granularities you have: build enclosures from whole runs and panels, show the gate, and keep the run's 2.04 m bounding depth out of your wall thickness.

## Mass

Mass is the figure the asset carries, not a weighing. Use it for relative heft, for what a person or a jack can move, and for the inertia a simulation needs. Some figures are plainly high for the real object - a folding floor sign at 49 kg, a desk at 121 kg, and judge the rest yourself - so when a number drives a claim a reader can check, say it is the asset's own figure, or round it to what the real object weighs and say you did. Never silently rewrite it.

The rigid-body count tells you how articulated the real asset is: 1 body is a solid, 32 bodies is a forklift with wheels, mast and forks that move. Match your proxy's joints to it, or say you simplified.

## Attribution

Any delivery that uses these numbers carries a bill of materials: one line per prop, with the prop, the quantity, the size and mass you used, and the holder and licence from the row (CC-BY 4.0, (c) NVIDIA unless the row names another). It belongs in the delivered page or document, not in a comment.

## Checklist

1. One unit is one metre, stated, with the grid and camera in metres, and the long side of every footprint chosen on purpose.
2. Every placed prop's size comes from a row above or from a number you state and justify.
3. Every lane, gap, pitch and lift is arithmetic from the props, written out.
4. No reach, payload, capacity, clearance or turning figure claimed from this table: each one is named as an assumption of yours or as a figure to source.
5. Masses carried as the asset's own figures, with any correction said out loud.
6. Proxy articulation matches the rigid-body count, or the simplification is stated.
7. A bill of materials in the delivery, with holder and licence per prop.
8. Nothing claimed as rendered, tested or walked through unless the task's inputs show it.
