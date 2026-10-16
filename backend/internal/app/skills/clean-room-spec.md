---
name: clean-room-spec
title: Clean-room behaviour spec
title_zh: 净室行为规格
description: When a team will rebuild a product, app or file format it must not copy: turn what can be observed about it (public docs, format descriptions, interface notes, an analysis report) into the one spec builders work from, every statement marked observed, inferred or unknown.
description_zh: 需要重建某个不能照抄的产品、应用或文件格式时使用：把能观察到的内容（公开文档、格式说明、界面记录、分析报告）整理成构建者唯一依据的行为规格，每条都标明是观察到的、推断的还是未知的。
category: engineering
applies: plan,research,code,review
version: 1
attribution:
---
# Clean-room behaviour spec

A clean room has two rooms and one wall. The reading room studies the subject; the building room writes the new product. Only the spec passes the wall. This node is the reading room: what it writes is all the builders will ever see of the subject.

## What may cross the wall

- Behaviour: what a person does and what happens, in plain generic vocabulary (layer, mask, blend mode, epoch).
- Interfaces and formats: file layouts, field names and types, value ranges, ordering rules, error behaviour, as tables.
- Numbers: sizes, limits, timings, counts and defaults.
- Acceptance tests: an input and its expected result, phrased so a program can check it.

Never let these cross: source code (original, minified or decompiled), shader text, comments, icons, images, sounds, fonts, strings longer than a short label, the product's name or logo, or its exact layout copied pixel for pixel. Rewrite everything in your own words and give the new product its own name.

## Evidence labels

Mark every statement:

- **[observed]** read directly in an input you were given; say where (doc section, report field, file name).
- **[inferred]** follows from observations; give the reasoning in one clause.
- **[unknown]** needed but not established; give the safe default builders should use and how a test would settle it.

Never promote an inference to an observation. A spec with honest unknowns beats a confident one.

## Structure (use these headings)

1. **Purpose and scope**: one paragraph; what version 1 includes and what it leaves out.
2. **Glossary**: 10 to 30 terms, one line each.
3. **Data model**: every entity with fields, types, ranges and defaults; invariants as numbered rules.
4. **Commands**: a table of id (dot.case), label, shortcut, parameters (`name: type = default`), effect and whether it can be undone. Every interface action is a command; menus, palette and keys all call commands by id.
5. **Screens and layout**: regions with sizes in px or %, what each shows, and its empty, busy and error states.
6. **Module contracts**: for each module, the global names it defines, their signatures, what it may call and what it must not touch. Make them complete enough that modules written apart, by builders who never see each other's code, fit together on the first try.
7. **Formats**: every file the product reads or writes, field by field.
8. **Acceptance tests**: 15 to 40 numbered checks, each as given / when / then, each owned by one module. Star the five that matter most.
9. **Planted failures**: 3 to 6 deliberately wrong variants the tests must reject (an off-by-one, a swapped operand in a formula, an undo that forgets a field), each naming the test that catches it.
10. **Unknowns**: the [unknown] items again, each with its default.

## Using an analysis report

When the inputs include a code-analysis report (modules, imports, routes, events), use it for architecture facts: which parts exist, how they connect, what talks to what. Summarise it as structure (counts, feature names, the shape of the graph), never as code. A conclusion drawn only from a file or symbol name is [inferred].

## Checklist

- Every module in section 6 is fed by the data model and owns at least one acceptance test.
- Every command in section 4 is reachable from the layout in section 5.
- No sentence carries copied code, copied strings or a protected name or asset.
- Every unknown has a default; nothing is left for builders to guess silently.
