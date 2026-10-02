import { tokenizeKnowledge } from '../intelligenceMath';
import type { Localized } from '../officialWorkflows';

export type ResearchRole = 'reader' | 'researcher' | 'lead';
export type ResearchDocument = { id: string; version: number; title: Localized; body: Localized; access: ResearchRole; entities: string[] };
const L = (zh: string, en: string): Localized => ({ zh, en });
export const RESEARCH_DOCUMENTS: ResearchDocument[] = [
  { id: 'BAT-01', version: 1, title: L('固态电池 A · 台架测试', 'Solid-state cell A · bench test'), access: 'reader', entities: ['CELL-A', 'LAB-N'], body: L('样品 A 在室温台架完成测试。\n\n[claim:cycle-life=800 cycles]\n测试协议使用 0.5C 充放电，样本数 12。\n\n[claim:energy-density=310 Wh/kg]\n此结果属于小样本实验，不等同量产性能。', 'Cell A completed room-temperature bench testing.\n\n[claim:cycle-life=800 cycles]\nProtocol uses 0.5C cycling with 12 samples.\n\n[claim:energy-density=310 Wh/kg]\nA small lab sample is not production evidence.') },
  { id: 'BAT-01', version: 2, title: L('固态电池 A · 复核修订', 'Solid-state cell A · revised review'), access: 'reader', entities: ['CELL-A', 'LAB-N'], body: L('复核发现三只样品温控偏移，修订测试结论。\n\n[claim:cycle-life=720 cycles]\n仅保留温控合格的 9 个样本。\n\n[claim:energy-density=310 Wh/kg]\n量产前必须扩大样本验证。', 'A review found temperature deviations in three cells and revised the result.\n\n[claim:cycle-life=720 cycles]\nOnly nine temperature-qualified samples remain.\n\n[claim:energy-density=310 Wh/kg]\nExpand validation before production.') },
  { id: 'BAT-02', version: 1, title: L('供应商循环寿命声明', 'Supplier cycle-life declaration'), access: 'researcher', entities: ['CELL-A', 'VENDOR-K'], body: L('供应商在不同协议下提供循环测试摘要。\n\n[claim:cycle-life=1000 cycles]\n0.2C 充放电与内部协议不同，不能直接等同。\n\n[claim:lead-time=42 days]\n交期从预付款及设计冻结起计算。', 'A supplier provides a cycle summary under a different protocol.\n\n[claim:cycle-life=1000 cycles]\n0.2C cycling differs from the internal protocol; results are not equivalent.\n\n[claim:lead-time=42 days]\nLead time starts after deposit and design freeze.') },
  { id: 'SAF-03', version: 1, title: L('热失控安全评估', 'Thermal-runaway safety assessment'), access: 'lead', entities: ['CELL-A', 'LAB-S'], body: L('安全实验室进行了针刺与过充试验。\n\n[claim:safety-gate=pending]\n过充样品出现异常；安全负责人复核前不得写通过。\n\n[claim:test-count=6 samples]\n六只样品不能代表批次一致性。', 'The safety lab performed penetration and overcharge tests.\n\n[claim:safety-gate=pending]\nAn overcharge anomaly requires owner review before passing.\n\n[claim:test-count=6 samples]\nSix samples cannot establish batch consistency.') },
  { id: 'MFG-04', version: 1, title: L('试产工艺与良率', 'Pilot process and yield'), access: 'researcher', entities: ['CELL-A', 'LINE-2'], body: L('二号产线进行了三批次试产。\n\n[claim:pilot-yield=87 percent]\n主要缺陷为极片边缘毛刺。\n\n[claim:lead-time=56 days]\n包括返工缓冲，交期与供应商口径不同。', 'Line 2 ran three pilot batches.\n\n[claim:pilot-yield=87 percent]\nThe main defect is electrode-edge burrs.\n\n[claim:lead-time=56 days]\nRework buffers differ from supplier lead-time assumptions.') },
  { id: 'MFG-04', version: 2, title: L('试产良率 · 工艺更新', 'Pilot yield · process revision'), access: 'researcher', entities: ['CELL-A', 'LINE-2'], body: L('更换刀具后的三批次报告。\n\n[claim:pilot-yield=93 percent]\n缺陷减少，仍需跨批验证。\n\n[claim:lead-time=49 days]\n修订交期包含七天质量复核。', 'Three batches after a tooling change.\n\n[claim:pilot-yield=93 percent]\nDefects decreased; cross-batch validation remains necessary.\n\n[claim:lead-time=49 days]\nThe revised lead time includes seven days of quality review.') },
  { id: 'FIN-05', version: 1, title: L('研发试验预算', 'Research trial budget'), access: 'lead', entities: ['CELL-A', 'FINANCE'], body: L('下一阶段扩大样本与设备校准预算。\n\n[claim:trial-budget=180000 CNY]\n预算仅为合成案例，无真实付款。\n\n[claim:sample-target=60 samples]\n分成三个批次，每批二十只样品。', 'Budget for expanded sampling and equipment calibration.\n\n[claim:trial-budget=180000 CNY]\nSynthetic example budget; no actual payment.\n\n[claim:sample-target=60 samples]\nThree batches of twenty cells are planned.') },
  { id: 'GOV-06', version: 1, title: L('证据使用与版本规范', 'Evidence and version protocol'), access: 'reader', entities: ['GOVERNANCE', 'LAB-N'], body: L('所有数字必须附来源编号与版本。\n\n历史版本不得作为最新结论。不同协议的同名指标需并列呈现。\n\n访问角色仅模拟展示；生产权限必须在服务端验证。', 'Every number must cite its document ID and version.\n\nHistorical revisions are not current conclusions. Identical metric names under different protocols must be shown separately.\n\nRoles simulate visibility only; production authorization belongs on the server.') },
];
const ROLE_LEVEL: Record<ResearchRole, number> = { reader: 0, researcher: 1, lead: 2 };
export function accessibleDocuments(documents: ResearchDocument[], role: ResearchRole, history = false): ResearchDocument[] {
  const visible = documents.filter(document => ROLE_LEVEL[document.access] <= ROLE_LEVEL[role]);
  return history ? visible : visible.filter(document => !visible.some(other => other.id === document.id && other.version > document.version));
}
export type ResearchChunk = { key: string; document: ResearchDocument; index: number; text: string; score: number };
export function searchResearch(documents: ResearchDocument[], query: string, locale: 'zh' | 'en', titleWeight = 2, k1 = 1.2): ResearchChunk[] {
  const chunks = documents.flatMap(document => document.body[locale].split(/\n\s*\n/).filter(Boolean).map((text, index) => ({ key: `${document.id}@${document.version}#${index + 1}`, document, index, text, score: 0 })));
  const terms = [...new Set(tokenizeKnowledge(query))];
  if (!terms.length || !chunks.length) return [];
  const tokenLists = chunks.map(chunk => tokenizeKnowledge(chunk.text));
  const avgLength = tokenLists.reduce((sum, tokens) => sum + tokens.length, 0) / chunks.length || 1;
  const safeK = Math.max(0.1, Math.min(3, k1));
  const safeTitle = Math.max(0, Math.min(5, titleWeight));
  const documentFrequency = terms.map(term => tokenLists.filter((tokens, i) => tokens.includes(term) || tokenizeKnowledge(chunks[i].document.title[locale]).includes(term)).length);
  return chunks.map((chunk, index) => ({ ...chunk, score: terms.reduce((sum, term, ti) => {
    const tf = tokenLists[index].filter(token => token === term).length + (tokenizeKnowledge(chunk.document.title[locale]).includes(term) ? safeTitle : 0);
    const idf = Math.log(1 + (chunks.length - documentFrequency[ti] + 0.5) / (documentFrequency[ti] + 0.5));
    return sum + idf * (tf * (safeK + 1)) / (tf + safeK * (0.25 + 0.75 * tokenLists[index].length / avgLength) || 1);
  }, 0) })).filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
export function researchClaims(documents: ResearchDocument[], locale: 'zh' | 'en') {
  return documents.flatMap(document => [...document.body[locale].matchAll(/\[claim:([^=\]\n]+)=([^\]\n]+)\]/g)].map(match => ({ key: match[1].trim(), value: match[2].trim(), source: `${document.id}@${document.version}`, document })));
}
export function researchConflicts(documents: ResearchDocument[], locale: 'zh' | 'en') {
  const claims = researchClaims(documents, locale);
  return [...new Set(claims.map(claim => claim.key))].map(key => ({ key, claims: claims.filter(claim => claim.key === key) })).filter(group => new Set(group.claims.map(claim => claim.value)).size > 1);
}
export const RESEARCH_QUERIES = [
  { query: L('循环寿命', 'cycle life'), expected: ['BAT-01', 'BAT-02'] }, { query: L('良率', 'yield'), expected: ['MFG-04'] },
  { query: L('安全', 'safety'), expected: ['SAF-03'] }, { query: L('交期', 'lead time'), expected: ['BAT-02', 'MFG-04'] },
  { query: L('不存在的火星植物', 'unobtainium botany'), expected: [] },
];
export function evaluateResearch(documents: ResearchDocument[], locale: 'zh' | 'en', titleWeight: number, k1: number) {
  return RESEARCH_QUERIES.map(item => {
    const visibleExpected = item.expected.filter(id => documents.some(document => document.id === id));
    const actual = [...new Set(searchResearch(documents, item.query[locale], locale, titleWeight, k1).slice(0, 5).map(hit => hit.document.id))];
    const hits = visibleExpected.filter(id => actual.includes(id)).length;
    return { ...item, expected: visibleExpected, actual, recall: visibleExpected.length ? hits / visibleExpected.length : actual.length ? 0 : 1, precision: actual.length ? hits / actual.length : visibleExpected.length ? 0 : 1, unavailable: item.expected.length > 0 && visibleExpected.length === 0 };
  });
}

export type MLPoint = { id: string; x: number; y: number; label: 0 | 1 };
export type MLDataset = { version: string; seed: number; noise: number; train: MLPoint[]; validation: MLPoint[]; test: MLPoint[] };
export type MLConfig = { algorithm: 'logistic' | 'stump'; rate: number; epochs: number; regularization: number };
export type MLModel = { config: MLConfig; weights: [number, number, number]; stump: { feature: 'x' | 'y'; threshold: number; left: number; right: number }; history: number[] };
export function rng(seed: number) { let state = seed >>> 0; return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; }; }
export function createMLDataset(version: 'v1' | 'v2' = 'v1', noise = 0.08): MLDataset {
  const random = rng(version === 'v1' ? 773 : 921);
  const points: MLPoint[] = Array.from({ length: 360 }, (_, i) => {
    const x = random() * 2 - 1 + (version === 'v2' ? 0.45 : 0); const y = random() * 2 - 1;
    const clean = (version === 'v1' ? 1.8 * x + y - 0.1 : x + 1.8 * y - 0.5) > 0;
    return { id: `${version}-${i}`, x, y, label: Number(random() < Math.max(0, Math.min(0.4, noise)) ? !clean : clean) as 0 | 1 };
  });
  return { version, seed: version === 'v1' ? 773 : 921, noise: Math.max(0, Math.min(0.4, noise)), train: points.slice(0, 216), validation: points.slice(216, 288), test: points.slice(288) };
}
export const sigmoid = (z: number) => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
export function predictML(model: MLModel, point: Pick<MLPoint, 'x' | 'y'>): number {
  return model.config.algorithm === 'logistic' ? sigmoid(model.weights[0] * point.x + model.weights[1] * point.y + model.weights[2]) : point[model.stump.feature] <= model.stump.threshold ? model.stump.left : model.stump.right;
}
export function classificationMetrics(probabilities: number[], labels: number[], threshold = 0.5) {
  let tp = 0, tn = 0, fp = 0, fn = 0, loss = 0;
  probabilities.forEach((p, i) => { const bounded = Math.max(1e-12, Math.min(1 - 1e-12, p)); loss -= labels[i] ? Math.log(bounded) : Math.log1p(-bounded); if (p >= threshold) { if (labels[i]) tp++; else fp++; } else if (labels[i]) fn++; else tn++; });
  const count = probabilities.length;
  return { tp, tn, fp, fn, count, loss: count ? loss / count : 0, accuracy: count ? (tp + tn) / count : 0, precision: tp + fp ? tp / (tp + fp) : 0, recall: tp + fn ? tp / (tp + fn) : 0 };
}
export function fitML(train: MLPoint[], raw: MLConfig): MLModel {
  const config = { ...raw, rate: Math.max(0.001, Math.min(1, raw.rate)), epochs: Math.max(1, Math.min(300, Math.floor(raw.epochs))), regularization: Math.max(0, Math.min(1, raw.regularization)) };
  const model: MLModel = { config, weights: [0, 0, 0], stump: { feature: 'x', threshold: 0, left: 0.5, right: 0.5 }, history: [] };
  if (!train.length) return model;
  const record = () => model.history.push(classificationMetrics(train.map(point => predictML(model, point)), train.map(point => point.label)).loss);
  record();
  if (config.algorithm === 'logistic') {
    for (let epoch = 0; epoch < config.epochs; epoch++) {
      const gradient = [0, 0, 0];
      for (const point of train) { const error = predictML(model, point) - point.label; gradient[0] += error * point.x; gradient[1] += error * point.y; gradient[2] += error; }
      model.weights = model.weights.map((weight, i) => weight - config.rate * (gradient[i] / train.length + (i < 2 ? config.regularization * weight : 0))) as [number, number, number]; record();
    }
  } else {
    const smoothing = 0.5 + config.regularization * 5;
    const leaf = (points: MLPoint[]) => (points.reduce((sum, point) => sum + point.label, 0) + smoothing) / (points.length + smoothing * 2);
    const prior = leaf(train);
    model.stump = { feature: 'x', threshold: 0, left: prior, right: prior };
    let bestLoss = classificationMetrics(train.map(() => prior), train.map(point => point.label)).loss;
    for (const feature of ['x', 'y'] as const) {
      const values = [...new Set(train.map(point => point[feature]))].sort((a, b) => a - b);
      for (let i = 1; i < values.length; i++) {
        const threshold = (values[i - 1] + values[i]) / 2;
        const left = train.filter(point => point[feature] <= threshold), right = train.filter(point => point[feature] > threshold);
        const candidate = { feature, threshold, left: leaf(left), right: leaf(right) };
        const probabilities = train.map(point => point[feature] <= threshold ? candidate.left : candidate.right);
        const loss = classificationMetrics(probabilities, train.map(point => point.label)).loss;
        if (loss < bestLoss) { bestLoss = loss; model.stump = candidate; }
      }
    }
    record();
  }
  return model;
}
export function rocCurve(probabilities: number[], labels: number[]) {
  const thresholds = [1.000001, ...new Set(probabilities)].sort((a, b) => b - a).concat(-0.000001);
  const points = thresholds.map(threshold => { const m = classificationMetrics(probabilities, labels, threshold); return { threshold, tpr: m.recall, fpr: m.fp + m.tn ? m.fp / (m.fp + m.tn) : 0 }; });
  const hasBoth = labels.includes(0) && labels.includes(1);
  const auc = hasBoth ? points.slice(1).reduce((sum, point, i) => sum + (point.fpr - points[i].fpr) * (point.tpr + points[i].tpr) / 2, 0) : null;
  return { points, auc };
}
export function bestCostThreshold(probabilities: number[], labels: number[], falsePositiveCost: number, falseNegativeCost: number) {
  return [0, ...new Set(probabilities), 1.000001].map(threshold => { const metrics = classificationMetrics(probabilities, labels, threshold); return { threshold, cost: metrics.fp * falsePositiveCost + metrics.fn * falseNegativeCost, metrics }; }).sort((a, b) => a.cost - b.cost || Math.abs(a.threshold - 0.5) - Math.abs(b.threshold - 0.5))[0];
}
export function populationStability(reference: number[], current: number[]): number {
  if (!reference.length || !current.length) return 0;
  const boundaries = [-Infinity, -0.6, -0.2, 0.2, 0.6, Infinity];
  return boundaries.slice(1).reduce((sum, upper, i) => { const lower = boundaries[i]; const frequency = (values: number[]) => (values.filter(value => value > lower && value <= upper).length + 0.5) / (values.length + 2.5); const p = frequency(reference), q = frequency(current); return sum + (q - p) * Math.log(q / p); }, 0);
}

export type Lesson = { id: string; title: Localized; minutes: number; mentor: number; after: string[]; difficulty: number; question: Localized; choices: Localized[]; correct: number; explanation: Localized };
export const LESSONS: Lesson[] = [
  { id: 'basics', title: L('数据素养', 'Data literacy'), minutes: 20, mentor: 0, after: [], difficulty: 1, question: L('比较两组数据前应先确认什么？', 'What should be checked before comparing datasets?'), choices: [L('采样口径一致', 'Compatible sampling definitions'), L('颜色一样', 'Matching chart colors'), L('记录数完全相等', 'Identical row counts')], correct: 0, explanation: L('口径、单位和样本来源决定比较是否成立。', 'Definitions, units and sampling determine whether a comparison is valid.') },
  { id: 'python', title: L('Python 与表格', 'Python and tables'), minutes: 35, mentor: 0, after: ['basics'], difficulty: 2, question: L('缺失值处理前首先应该？', 'Before handling missing values, first:'), choices: [L('全部填零', 'Fill everything with zero'), L('检查缺失原因和比例', 'Inspect causes and proportions'), L('删除整张表', 'Delete the table')], correct: 1, explanation: L('填零可能引入系统偏差，应先检查缺失机制。', 'Zero-filling can introduce bias; inspect the missingness mechanism.') },
  { id: 'statistics', title: L('概率与统计', 'Probability and statistics'), minutes: 30, mentor: 0, after: ['basics'], difficulty: 2, question: L('相关性能够直接证明因果吗？', 'Does correlation directly prove causation?'), choices: [L('总是可以', 'Always'), L('样本大就可以', 'If the sample is large'), L('不能，需要额外证据', 'No, additional evidence is needed')], correct: 2, explanation: L('混杂因素可能同时影响两个变量。', 'Confounders may affect both variables.') },
  { id: 'cleaning', title: L('质量与清洗', 'Quality and cleaning'), minutes: 30, mentor: 0, after: ['python'], difficulty: 2, question: L('划分数据之前用全量均值填补有什么问题？', 'What is wrong with imputing from the full dataset before splitting?'), choices: [L('信息泄漏', 'Information leakage'), L('一定变慢', 'It must be slower'), L('没有问题', 'No problem')], correct: 0, explanation: L('测试信息流入训练预处理，会高估泛化效果。', 'Test information leaks into training preprocessing and can inflate generalization estimates.') },
  { id: 'visualization', title: L('可视化叙事', 'Visual storytelling'), minutes: 25, mentor: 0, after: ['statistics'], difficulty: 2, question: L('展示每日变化趋势优先选择？', 'Which chart best shows daily change over time?'), choices: [L('饼图', 'Pie chart'), L('折线图', 'Line chart'), L('装饰图标', 'Decorative icons')], correct: 1, explanation: L('有序时间轴上的折线有助于观察趋势。', 'A line on an ordered time axis makes trends visible.') },
  { id: 'regression', title: L('回归与分类', 'Regression and classification'), minutes: 40, mentor: 0, after: ['cleaning', 'statistics'], difficulty: 3, question: L('逻辑回归做二分类时输出什么？', 'What does binary logistic regression output?'), choices: [L('必然正确的标签', 'A guaranteed correct label'), L('数据库记录', 'A database row'), L('类别概率估计', 'A class probability estimate')], correct: 2, explanation: L('概率经过阈值转换为类别，仍需要评测。', 'A threshold maps probabilities to classes; evaluation is still required.') },
  { id: 'evaluation', title: L('评测与实验', 'Evaluation and experiments'), minutes: 35, mentor: 0, after: ['regression'], difficulty: 3, question: L('选择超参数主要看哪个集合？', 'Which split should guide hyperparameter selection?'), choices: [L('验证集', 'Validation split'), L('最终测试集反复试', 'Repeated final-test trials'), L('训练准确率最高', 'Highest training accuracy')], correct: 0, explanation: L('测试集留给最终一次评估，避免调参泄漏。', 'Reserve the test set for final evaluation to avoid tuning leakage.') },
  { id: 'ethics', title: L('责任与证据', 'Responsibility and evidence'), minutes: 20, mentor: 0, after: ['statistics'], difficulty: 2, question: L('发现群体间误差不同，应该？', 'What should you do when errors differ across groups?'), choices: [L('只报总准确率', 'Report only overall accuracy'), L('分组检查并记录限制', 'Inspect groups and document limitations'), L('删掉异常组', 'Delete the unusual group')], correct: 1, explanation: L('总体指标可能掩盖局部问题，需记录范围与限制。', 'Aggregate metrics can conceal localized failures; document scope and limitations.') },
  { id: 'clinic', title: L('导师实验诊所', 'Mentor experiment clinic'), minutes: 45, mentor: 1, after: ['evaluation', 'visualization'], difficulty: 4, question: L('向导师交付实验应包括？', 'What belongs in an experiment handoff?'), choices: [L('只有截图', 'Screenshots only'), L('只有结论', 'Conclusions only'), L('数据版本、配置、指标与限制', 'Data version, configuration, metrics and limits')], correct: 2, explanation: L('可复现材料让导师复核实验过程。', 'Reproducible materials let a mentor review the experiment.') },
  { id: 'capstone', title: L('毕业项目', 'Capstone project'), minutes: 60, mentor: 1, after: ['clinic', 'ethics'], difficulty: 5, question: L('模型上线前最后应确认？', 'What must be verified before deploying a model?'), choices: [L('监控、回滚和验收证据', 'Monitoring, rollback and acceptance evidence'), L('演示动画够漂亮', 'Beautiful demo animation'), L('训练集接近100%', 'Near-perfect training accuracy')], correct: 0, explanation: L('交付不仅包含模型，还需要监控与回退机制。', 'A delivery includes monitoring and recovery mechanisms alongside the model.') },
];
export type Mastery = Record<string, { alpha: number; beta: number }>;
export const initialMastery = (): Mastery => Object.fromEntries(LESSONS.map(lesson => [lesson.id, { alpha: lesson.id === 'basics' ? 5 : 2, beta: 2 }]));
export const masteryScore = (mastery: Mastery, id: string) => { const score = mastery[id] ?? { alpha: 2, beta: 2 }; return score.alpha / (score.alpha + score.beta); };
export function updateMastery(mastery: Mastery, id: string, correct: boolean): Mastery { const previous = mastery[id] ?? { alpha: 2, beta: 2 }; return { ...mastery, [id]: { alpha: previous.alpha + (correct ? 2 : 0), beta: previous.beta + (correct ? 0 : 2) } }; }
export function planLearning(lessons: Lesson[], completed: string[], goal: string, budget: number, mentorSlots: number, mastery: Mastery) {
  const required = new Set<string>(); const visit = (id: string, stack: Set<string>) => { if (stack.has(id)) throw new Error('Cyclic lesson prerequisites'); if (required.has(id) || completed.includes(id)) return; const lesson = lessons.find(item => item.id === id); if (!lesson) throw new Error(`Unknown lesson ${id}`); required.add(id); for (const prior of lesson.after) visit(prior, new Set([...stack, id])); }; visit(goal, new Set());
  const candidates = lessons.filter(lesson => required.has(lesson.id));
  let best: Lesson[] = [], bestScore = -1;
  for (let mask = 0; mask < 2 ** candidates.length; mask++) {
    const chosen = candidates.filter((_, index) => (mask & (1 << index)) !== 0); const ids = new Set([...completed, ...chosen.map(item => item.id)]);
    if (chosen.some(lesson => lesson.after.some(prior => !ids.has(prior)))) continue;
    if (chosen.reduce((sum, lesson) => sum + lesson.minutes, 0) > budget || chosen.reduce((sum, lesson) => sum + lesson.mentor, 0) > mentorSlots) continue;
    const score = chosen.reduce((sum, lesson) => sum + 1 + (1 - masteryScore(mastery, lesson.id)) * lesson.difficulty + (lesson.id === goal ? 10 : 0), 0);
    if (score > bestScore) { best = chosen; bestScore = score; }
  }
  // Kahn ordering also works when a caller supplies lessons in non-topological order.
  const ordered: Lesson[] = [], resolved = new Set(completed);
  while (ordered.length < best.length) { const next = best.find(lesson => !resolved.has(lesson.id) && lesson.after.every(id => resolved.has(id))); if (!next) break; ordered.push(next); resolved.add(next.id); }
  return { lessons: ordered, minutes: ordered.reduce((sum, lesson) => sum + lesson.minutes, 0), mentorSlots: ordered.reduce((sum, lesson) => sum + lesson.mentor, 0), reachesGoal: completed.includes(goal) || ordered.some(lesson => lesson.id === goal), remaining: candidates.filter(lesson => !ordered.includes(lesson)), totalRequired: candidates.reduce((sum, lesson) => sum + lesson.minutes, 0) };
}

export type ContractDocument = { id: string; version: number; title: Localized; body: string };
export const CONTRACT_DOCUMENTS: ContractDocument[] = [
  { id: 'CT-201', version: 1, title: L('数字产品咨询服务', 'Digital product consulting'), body: 'SCOPE|Research and prototype / 调研与原型\nOBL|D1|2026-10-08|Studio|Research report / 调研报告\nOBL|D2|2026-10-22|Studio|Interactive prototype / 交互原型\nPAY|P1|2026-10-05|Client|30000|CNY\nPAY|P2|2026-10-25|Client|30000|CNY\nREVIEW|2026-10-01|Both parties\nNOTE|Synthetic teaching example / 合成教学示例' },
  { id: 'CT-201', version: 2, title: L('数字产品咨询服务', 'Digital product consulting'), body: 'SCOPE|Research and prototype / 调研与原型\nOBL|D1|2026-10-08|Studio|Research report / 调研报告\nOBL|D2|2026-10-18|Studio|Interactive prototype / 交互原型\nOBL|D3|2026-10-23||Accessibility review / 无障碍复核\nPAY|P1|2026-10-05|Client|30000|CNY\nPAY|P2|2026-10-25|Client|40000|CNY\nREVIEW|2026-10-02|Both parties\nNOTE|Synthetic teaching example / 合成教学示例' },
  { id: 'CT-202', version: 1, title: L('品牌内容制作服务', 'Brand content production'), body: 'SCOPE|Campaign assets / 活动素材\nOBL|B1|2026-10-03|Agency|Creative directions / 创意提案\nOBL|B2|2026-10-14|Agency|Final media pack / 成片素材\nPAY|B3|2026-10-07|Client|45000|CNY\nNOTE|No actual parties or transactions / 无真实主体或交易' },
  { id: 'CT-203', version: 1, title: L('数据治理专业服务', 'Data governance services'), body: 'SCOPE|Data quality assessment / 数据质量评估\nOBL|G1|2026-09-28|Consultant|Quality baseline / 质量基线\nOBL|G2|2026-10-12|Consultant|Remediation plan / 修复方案\nOBL|G3|not-set|Client|Access approval / 访问批准\nPAY|G4|2026-10-15|Client|80000|CNY\nNOTE|Rule-based educational example / 规则教学示例' },
];
export type Obligation = { key: string; kind: 'OBL' | 'PAY'; id: string; due: string; owner: string; description: string; line: number; amount: number | null; validDate: boolean };
export function validISODate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
export function extractObligations(document: ContractDocument): Obligation[] {
  return document.body.split('\n').flatMap((line, i) => { const parts = line.split('|'); if (parts[0] !== 'OBL' && parts[0] !== 'PAY') return []; return [{ key: `${document.id}@${document.version}:${i + 1}`, kind: parts[0], id: parts[1] || `line-${i + 1}`, due: parts[2] ?? '', owner: parts[3] ?? '', description: parts[0] === 'PAY' ? `${parts[4] ?? '?'} ${parts[5] ?? ''}` : parts.slice(4).join('|'), line: i + 1, amount: parts[0] === 'PAY' && Number.isFinite(Number(parts[4])) && parts[4]?.trim() ? Number(parts[4]) : null, validDate: validISODate(parts[2] ?? '') }] as Obligation[]; });
}
export function contractFindings(document: ContractDocument, today: string, evidence: Set<string>) {
  const day = validISODate(today) ? Date.parse(`${today}T00:00:00Z`) : Date.parse('2026-10-01T00:00:00Z');
  return extractObligations(document).flatMap(obligation => {
    const common = { obligation, source: `${document.id}@${document.version}:L${obligation.line}` };
    const findings: { id: string; code: 'missing-owner' | 'invalid-date' | 'overdue' | 'due-soon' | 'invalid-amount'; severity: 'high' | 'medium'; obligation: Obligation; source: string }[] = [];
    if (!obligation.owner.trim()) findings.push({ ...common, id: `${obligation.key}:owner`, code: 'missing-owner', severity: 'high' });
    if (!obligation.validDate) findings.push({ ...common, id: `${obligation.key}:date`, code: 'invalid-date', severity: 'high' });
    if (obligation.kind === 'PAY' && (obligation.amount === null || obligation.amount < 0)) findings.push({ ...common, id: `${obligation.key}:amount`, code: 'invalid-amount', severity: 'high' });
    if (obligation.validDate && !evidence.has(obligation.key)) { const days = (Date.parse(`${obligation.due}T00:00:00Z`) - day) / 86400000; if (days < 0) findings.push({ ...common, id: `${obligation.key}:deadline`, code: 'overdue', severity: 'high' }); else if (days <= 7) findings.push({ ...common, id: `${obligation.key}:deadline`, code: 'due-soon', severity: 'medium' }); }
    return findings;
  });
}
export function lineDiff(before: string, after: string): { kind: 'same' | 'added' | 'removed'; text: string }[] {
  const a = before.split('\n').slice(0, 250), b = after.split('\n').slice(0, 250);
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0) as number[]);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) matrix[i][j] = a[i] === b[j] ? 1 + matrix[i + 1][j + 1] : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  const result: ReturnType<typeof lineDiff> = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) { if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'same', text: a[i++] }); j++; } else if (j < b.length && (i === a.length || matrix[i][j + 1] >= matrix[i + 1][j])) result.push({ kind: 'added', text: b[j++] }); else result.push({ kind: 'removed', text: a[i++] }); }
  return result;
}
