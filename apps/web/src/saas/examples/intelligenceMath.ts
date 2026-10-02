export type KnowledgeDocument = { id: string; title: string; content: string };
export type SearchHit = { document: KnowledgeDocument; score: number; matchedTerms: string[] };

/** Deliberately local lexical retrieval: Latin words and overlapping Chinese bigrams. */
export function tokenizeKnowledge(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []).flatMap(part => {
    if (!/[\u3400-\u9fff]/.test(part) || part.length === 1) return [part];
    return Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2));
  });
}

export function searchKnowledge(documents: KnowledgeDocument[], query: string, options: {
  threshold?: number; titleBoost?: number; emphasis?: string; emphasisWeight?: number;
} = {}): SearchHit[] {
  const queryTokens = tokenizeKnowledge(query);
  if (!queryTokens.length || !documents.length) return [];
  const titleBoost = Math.max(1, Math.min(5, options.titleBoost ?? 2));
  const emphasisWeight = Math.max(1, Math.min(5, options.emphasisWeight ?? 2));
  const emphasized = new Set(tokenizeKnowledge(options.emphasis ?? ''));
  const termMaps = documents.map(document => {
    const counts = new Map<string, number>();
    for (const term of tokenizeKnowledge(document.content)) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const term of tokenizeKnowledge(document.title)) counts.set(term, (counts.get(term) ?? 0) + titleBoost);
    return counts;
  });
  const frequencies = new Map<string, number>();
  for (const counts of termMaps) for (const term of counts.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const idf = (term: string) => Math.log((documents.length + 1) / ((frequencies.get(term) ?? 0) + 1)) + 1;
  const queryCounts = new Map<string, number>();
  for (const term of queryTokens) queryCounts.set(term, (queryCounts.get(term) ?? 0) + 1);
  const weightedQuery = [...queryCounts].map(([term, count]) => [term, (1 + Math.log(count)) * idf(term) * (emphasized.has(term) ? emphasisWeight : 1)] as const);
  const queryNorm = Math.hypot(...weightedQuery.map(([, weight]) => weight));
  return documents.map((document, index) => {
    const vector = new Map([...termMaps[index]].map(([term, count]) => [term, (1 + Math.log(count)) * idf(term)]));
    const norm = Math.hypot(...vector.values());
    const dot = weightedQuery.reduce((sum, [term, weight]) => sum + weight * (vector.get(term) ?? 0), 0);
    return { document, score: Math.min(1, dot / (norm * queryNorm || 1)), matchedTerms: [...queryCounts.keys()].filter(term => vector.has(term)) };
  }).filter(hit => hit.score > 0 && hit.score >= (options.threshold ?? 0.06))
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));
}

export type TrainingPoint = { x: number; y: number; label: 0 | 1 };
export type LogisticWeights = readonly [number, number, number];
export type ModelMetrics = { loss: number; accuracy: number };
export type TrainingSample = { epoch: number; train: ModelMetrics; validation: ModelMetrics };
export type TrainingState = { weights: LogisticWeights; history: TrainingSample[]; epoch: number };

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createTrainingData(noise: number): { train: TrainingPoint[]; validation: TrainingPoint[] } {
  const random = seededRandom(41027);
  const boundedNoise = Math.max(0, Math.min(0.4, Number.isFinite(noise) ? noise : 0));
  const points = Array.from({ length: 240 }, () => {
    const x = random() * 2 - 1;
    const y = random() * 2 - 1;
    const clean = 1.9 * x + 1.3 * y - 0.08 > 0;
    const label = (random() < boundedNoise ? !clean : clean) ? 1 : 0;
    return { x, y, label } as TrainingPoint;
  });
  return { train: points.slice(0, 180), validation: points.slice(180) };
}

export function logisticProbability(weights: LogisticWeights, x: number, y: number): number {
  const z = weights[0] * x + weights[1] * y + weights[2];
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

export function evaluateModel(weights: LogisticWeights, points: TrainingPoint[]): ModelMetrics {
  if (!points.length) return { loss: 0, accuracy: 0 };
  let loss = 0;
  let correct = 0;
  for (const point of points) {
    const z = weights[0] * point.x + weights[1] * point.y + weights[2];
    // Stable softplus cross entropy, without log(0) or exp overflow.
    loss += Math.max(z, 0) - z * point.label + Math.log1p(Math.exp(-Math.abs(z)));
    if (Number(logisticProbability(weights, point.x, point.y) >= 0.5) === point.label) correct += 1;
  }
  return { loss: loss / points.length, accuracy: correct / points.length };
}

export function initialTrainingState(data: ReturnType<typeof createTrainingData>): TrainingState {
  const weights: LogisticWeights = [0, 0, 0];
  return { epoch: 0, weights, history: [{ epoch: 0, train: evaluateModel(weights, data.train), validation: evaluateModel(weights, data.validation) }] };
}

export function advanceTraining(state: TrainingState, data: ReturnType<typeof createTrainingData>, learningRate: number, epochs: number): TrainingState {
  const rate = Number.isFinite(learningRate) ? Math.max(0.001, Math.min(1, learningRate)) : 0.15;
  const steps = Number.isFinite(epochs) ? Math.max(0, Math.min(300, Math.floor(epochs))) : 0;
  let weights: LogisticWeights = state.weights;
  const history = [...state.history];
  for (let step = 1; step <= steps; step += 1) {
    const gradient = [0, 0, 0];
    for (const point of data.train) {
      const error = logisticProbability(weights, point.x, point.y) - point.label;
      gradient[0] += error * point.x;
      gradient[1] += error * point.y;
      gradient[2] += error;
    }
    const count = Math.max(1, data.train.length);
    weights = [weights[0] - rate * gradient[0] / count, weights[1] - rate * gradient[1] / count, weights[2] - rate * gradient[2] / count];
    history.push({ epoch: state.epoch + step, train: evaluateModel(weights, data.train), validation: evaluateModel(weights, data.validation) });
  }
  return { weights, history, epoch: state.epoch + steps };
}
