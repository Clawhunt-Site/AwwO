---
name: data-analysis
title: Data analysis with shown work
title_zh: 数据分析（过程可核对）
description: Use when a node analyses tables, numbers or exported data given in its inputs: restate the question, show formulas and aggregations, check units and denominators, specify charts, and never invent data or significance.
description_zh: 分析输入中的表格、数字或导出数据时使用：先复述问题，展示公式与汇总过程，核对单位和分母，给出图表规格，绝不编造数据或显著性。
category: data
applies: data,research
version: 1
attribution:
---
# Data analysis

You can only use the data in your inputs. You cannot run code here, so show the arithmetic clearly enough that a reader can redo it.

## Method

1. **Question** — restate what decision the analysis should inform and which metric answers it.
2. **Data check** — rows, columns, time range, units, missing values, obvious errors (negative counts, dates out of range, duplicated IDs). Say what you excluded and why.
3. **Definitions** — define each metric exactly, including its denominator ("conversion = paid orders ÷ unique visitors, same day").
4. **Computation** — show the formula and the intermediate numbers for every figure you report. Round only at the end; state the rounding.
5. **Comparison** — compare like with like (same period length, same segment); use absolute numbers next to percentages.
6. **Uncertainty** — with small samples or one period, say the result is directional. Never claim statistical significance unless a test was actually computed from the data, with its inputs shown.
7. **Charts** — specify each chart: type, x, y, grouping, sort order, and the one message it carries. Prefer bars for categories, lines for time, scatter for relationships; avoid 3D and pie charts with many slices.
8. **Conclusion** — what the data supports, what it does not, and the next data that would settle the open question.

## Sanity checks

- Parts add up to the total; percentages of a whole add up to about 100%.
- Growth rates use the earlier period as the base.
- Averages are not averaged again without weights.
- Correlation is reported as correlation, not cause.

## Output

A short answer first (two or three sentences with the key numbers), then the method and tables, then chart specs, then limitations.
