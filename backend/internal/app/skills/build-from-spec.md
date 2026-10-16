---
name: build-from-spec
title: Build a module to its contract
title_zh: 按契约构建模块
description: When a node writes one module of a larger program from a spec it shares with other builders: implement exactly its contract (names, signatures, data), use nothing the contracts do not define, stay compact and runnable as pasted, and register its commands, tests and planted failures.
description_zh: 节点按与其他构建者共享的规格编写大型程序中的一个模块时使用：严格实现自己的契约（名称、签名、数据），不使用契约之外的东西，代码紧凑、粘贴即可运行，并注册命令、测试和植入缺陷。
category: engineering
applies: code
version: 1
attribution:
---
# Build a module to its contract

Several builders write one program at the same time, each from the same spec and never from each other's code. An assemble step then pastes the modules into one page in a fixed order, byte for byte, without a model. What you deliver must fit exactly, because nobody will retype it to make it fit.

## The contract

- Define only the global names your module's contract lists, with exactly those signatures. Keep everything else private inside one closure.
- Use other modules only through the names their contracts list. Never redefine, patch or wrap them.
- If you need something no contract provides, build it privately inside your module, and say so in one line after the code.
- Nothing runs at load except definitions and registrations. Work starts when the entry module calls you.
- Data follows the spec's data model: the same field names, units and ranges. Check inputs at your boundary and throw a clear Error instead of guessing a default.
- No network, storage or external library unless the spec names it.

## Registering with the program

The spec defines a small kernel every module registers with. Use its names; if the spec gives none, use these:

- Commands: `App.commands.register({ id, label, shortcut, enabled, run })`. Menus, the command palette and keys call commands by id, never your functions directly.
- Tests: `App.tests.add(name, fn)`, where `fn` returns or resolves to true, or throws with the reason. Test your module's behaviour with real inputs and expected values, not merely that nothing threw.
- Planted failures: `App.tests.plant(name, swap)`, where `swap()` puts the wrong variant in place and returns a function that restores the original. Plant the mistakes the spec assigns to your module.

## Writing it

- Compact: no comments, no blank lines, short local names, and tables or loops instead of repeated code.
- Finish first. Size the module to the budget the task gives; when space runs short, drop polish before you drop a contract name.
- Interface text in the language the spec gives, with numbers formatted the same way everywhere.
- Before answering, check silently: every bracket closed, every contract name defined exactly once, no name defined that another contract owns.

## Output

Only the code, as one fenced block when the task asks for code, followed by at most three lines: the names defined, the commands registered, and the tests and plants registered.
