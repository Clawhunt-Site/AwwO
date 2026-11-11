---
name: level-data
title: Levels as data: game levels in an LDtk-compatible file, validated and proven playable
title_zh: 关卡即数据：用 LDtk 兼容格式存游戏关卡，并校验、证明可玩
description: Use when a node makes a 2D game with levels (a platformer, a set of top-down rooms, a puzzle grid) or generates levels: keep each level as data in the open LDtk project format (an IntGrid layer for collision, an Entities layer with fields, levels in a world), so a person can open and edit it in the LDtk editor and the game reads it back; generate levels from a seed with design rules taken from the movement numbers; check what the format's schema cannot; and refuse to deliver a level an autopilot cannot finish.
description_zh: 节点做带关卡的 2D 游戏（平台跳跃、俯视房间、解谜网格）或生成关卡时使用：把每一关存成开放的 LDtk 项目格式数据（碰撞用 IntGrid 层，带字段的 Entities 层，多关组成一个世界），让人能用 LDtk 编辑器打开修改、游戏再读回来；按种子生成关卡，设计规则取自移动数值；检查格式的 schema 管不到的事；自动驾驶通不了关的关卡不交付。
category: engineering
applies: code,html,data
version: 1
attribution:
---
# Levels as data

Code that draws a level and data that describes it are different things. Keep the level as data in an open format, and one file serves the game, the editor and the tests.

## The file

LDtk, a free level editor for 2D games under the MIT licence, stores a whole project as one JSON file and publishes a JSON Schema for it.

- `defs`: layer definitions, entity definitions (each with its fields), enums, tilesets, level fields.
- `levels`: each with `identifier`, `uid`, `iid`, `pxWid`, `pxHei`, its place in the world, `__neighbours` and `layerInstances`.
- An IntGrid layer: `__cWid` by `__cHei` cells of `__gridSize` px; `intGridCsv` holds one integer per cell, row by row, 0 for empty (say 1 ground, 2 water, 3 one-way).
- An Entities layer: each instance with `__identifier`, `__grid`, `px`, `__pivot`, `width`, `height`, `defUid` and `fieldInstances` (`__identifier`, `__type`, `__value`, `defUid`).
- At the root: `jsonVersion`, `worldLayout` (LinearHorizontal, LinearVertical, GridVania or Free), `iid`, `defs`, `levels`, `toc`, `worlds`.

The editor also writes many editor-only fields. A file meant to open in the editor starts from a project the editor itself saved that already holds the layer and entity definitions the game needs (the person makes it once, or it is given to the node); the generator adds only levels, layer instances and entity instances, takes each new `uid` from the root's `nextUid` and raises it past them, and refreshes `toc`: values that merely have the right type (a grid size of 0, an empty colour, a uid nothing defines) can pass the schema and still break the editor. A file only for the game may follow the smaller schema of the minimal export, which allows no other fields. Give `iid`s stable made-up values derived from the seed, so the same seed writes the same file.

## Generating levels

- From one seed and a seeded generator (never `Math.random`), segment by segment.
- For a platformer: flat runs, steps, gaps, platforms, hazards, pickups, enemies. Rules come from the movement numbers (game-feel): a jump h cells high and a run of v px/s over t s of air time reach a known distance; keep gaps under 0.6 of that reach and steps under 0.6 of h. Never two gaps in a row; after a gap comes level ground at the take-off height; entities stand on empty cells with ground below them; pickups sit on the jump arcs.
- For top-down rooms or puzzles: doors, keys, walls and pieces instead, with the rules of that game's own moves; nothing needs ground below it.
- In every genre: a hazard is never the only way forward, nothing sits inside a wall, and the first minute teaches one idea at a time.

## What the schema cannot check

- `intGridCsv` length equals `__cWid` times `__cHei`.
- Exactly one start and one goal in each level; every entity inside the level and on an empty cell.
- In a Free or GridVania world, neighbours point both ways (linear worlds have none); every `iid` and every `uid` is unique, and so is each level's identifier; entity and layer identifiers repeat by design (two coins are both `Coin`).

## Proof that a level plays

A generated level is not delivered until an autopilot finishes it: the game's own actions in fixed steps of 1/60 s, an honest simple driver (in a platformer, run toward the goal and jump before a wall or a gap; in rooms or puzzles, a search over the game's own moves), zero deaths, under a time limit. One run found two gaps merged into a pit six cells wide and a two-cell step straight after a gap: the driver died 24 and 31 times in two of three levels while the file passed its schema. When a level fails, repair the failing segment or re-seed, and say which. A node without a sandbox computer cannot run the autopilot or a validator: it delivers the levels with every check reported as "not run" and names the checks a person or a later node must run.

Pickups need their own check (a search over the jump arcs from each standing cell), since a driver aimed at the goal skips most of them.

## Reading it in the game

Build collision from the IntGrid, spawn from Entities by `__identifier`, read fields by their identifiers. Between levels: in a LinearHorizontal or LinearVertical world the next level is the next entry of `levels` (the format leaves `__neighbours` empty there); in a Free or GridVania world follow `__neighbours`. For a recording, `renderAt(t)` replays the autopilot from t = 0 in fixed steps, so any frame stands alone.

## Before you hand over

1. The level file, its `jsonVersion`, and which schema (full or minimal) it was written against.
2. The generator's seed and its rules.
3. The structural checks' results.
4. Per level: finished or not, seconds, deaths, pickups reached.
5. One of three, stated plainly: opened in the editor (only if someone did), validated against the schema (only if a validator ran), or not checked.
