import type { PaperInput } from './types.ts';
import { Rng } from './util/rng.ts';

export interface GenerateOptions {
  seed: number;
  papers: number;
  /** Number of research topics. The first 12 are named presets; extras use invented vocabulary. */
  topics: number;
  startYear: number;
  endYear: number;
  /** Adjacent topic pairs that are deliberately never connected: no hybrid papers, no cross-citations. */
  voids: number;
  /** Topics that stop publishing a few years before `endYear`. */
  dormant: number;
  /** Topics that other papers keep mentioning as open questions, but that are almost never studied. */
  orphans: number;
  avgReferences: number;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  seed: 42,
  papers: 400,
  topics: 12,
  startYear: 2008,
  endYear: 2025,
  voids: 2,
  dormant: 1,
  orphans: 1,
  avgReferences: 8,
};

/** What the generator planted, so later analysis (void detection etc.) can be scored against it. */
export interface SyntheticTruth {
  options: GenerateOptions;
  topics: { id: number; name: string; birthYear: number; deathYear?: number; orphan: boolean; adjacent: number[] }[];
  /** paper id -> topic ids. First entry is the primary topic; a second entry marks a hybrid paper. */
  paperTopics: Record<string, number[]>;
  /** Adjacent topic pairs with no bridge: related vocabulary, but no hybrid papers and no cross-citations. */
  bridgeVoids: { a: number; b: number }[];
  /** Adjacent topic pairs that do have hybrid papers and cross-citations. */
  bridged: { a: number; b: number }[];
}

interface TopicPreset {
  name: string;
  keywords: string[];
}

const PRESETS: TopicPreset[] = [
  { name: 'Graph neural networks', keywords: ['message passing', 'node embeddings', 'graph convolution', 'spectral filters', 'neighborhood aggregation', 'over-smoothing', 'heterophily', 'link prediction', 'molecular graphs', 'graph pooling', 'neighbor sampling', 'expressive power', 'graph transformers', 'positional encodings'] },
  { name: 'Federated learning', keywords: ['client drift', 'secure aggregation', 'non-iid data', 'communication efficiency', 'personalization', 'local updates', 'straggler clients', 'cross-device training', 'model averaging', 'client sampling', 'edge devices', 'differential privacy', 'split learning', 'federated optimization'] },
  { name: 'Reinforcement learning', keywords: ['policy gradient', 'reward shaping', 'exploration bonus', 'value function', 'offline datasets', 'actor-critic', 'sample efficiency', 'model-based planning', 'off-policy correction', 'hierarchical policies', 'multi-agent coordination', 'sparse rewards', 'replay buffer', 'imitation learning'] },
  { name: 'Language models', keywords: ['pretraining corpus', 'instruction tuning', 'prompt design', 'in-context learning', 'tokenization', 'hallucination', 'retrieval augmentation', 'long context', 'alignment', 'scaling behavior', 'reasoning chains', 'decoding strategies', 'multilingual transfer', 'evaluation suites'] },
  { name: 'Computer vision', keywords: ['object detection', 'semantic segmentation', 'image classification', 'data augmentation', 'convolutional backbones', 'vision transformers', 'self-supervised features', 'depth estimation', 'pose estimation', 'video understanding', 'domain adaptation', 'medical imaging', 'point clouds', 'image generation'] },
  { name: 'Causal inference', keywords: ['counterfactual reasoning', 'confounding', 'treatment effects', 'structural causal models', 'instrumental variables', 'propensity scores', 'causal discovery', 'identifiability', 'interventions', 'mediation analysis', 'invariant prediction', 'observational data', 'front-door adjustment', 'uplift modeling'] },
  { name: 'Bayesian methods', keywords: ['posterior inference', 'variational inference', 'Markov chain Monte Carlo', 'Gaussian processes', 'prior specification', 'uncertainty quantification', 'calibration', 'hierarchical models', 'Bayesian optimization', 'probabilistic programming', 'evidence lower bound', 'approximate inference', 'credible intervals', 'model evidence'] },
  { name: 'Interpretability', keywords: ['feature attribution', 'saliency maps', 'concept probing', 'mechanistic circuits', 'faithfulness metrics', 'counterfactual explanations', 'attention visualization', 'sparse autoencoders', 'activation patching', 'surrogate models', 'explanation stability', 'human evaluation', 'model auditing', 'representation analysis'] },
  { name: 'Robustness', keywords: ['adversarial examples', 'distribution shift', 'certified defenses', 'out-of-distribution detection', 'corruption benchmarks', 'adversarial training', 'worst-group accuracy', 'spurious correlations', 'randomized smoothing', 'test-time adaptation', 'backdoor attacks', 'data poisoning', 'robust generalization', 'perturbation bounds'] },
  { name: 'Optimization', keywords: ['stochastic gradient descent', 'learning rate schedules', 'adaptive methods', 'momentum', 'nonconvex landscapes', 'saddle points', 'second-order curvature', 'convergence rates', 'large-batch training', 'gradient clipping', 'loss landscape', 'implicit regularization', 'weight decay', 'variance reduction'] },
  { name: 'Recommender systems', keywords: ['collaborative filtering', 'matrix factorization', 'implicit feedback', 'cold start', 'session-based recommendation', 'click-through prediction', 'ranking losses', 'exposure bias', 'user embeddings', 'two-tower retrieval', 'diversity', 'popularity bias', 'sequential recommendation', 'counterfactual evaluation'] },
  { name: 'Time series', keywords: ['forecasting horizons', 'seasonality', 'anomaly detection', 'state space models', 'irregular sampling', 'temporal convolution', 'autoregressive models', 'change point detection', 'multivariate dependence', 'probabilistic forecasting', 'patch tokenization', 'spectral analysis', 'missing values', 'concept drift'] },
];

/** Topics (by preset index) whose vocabularies overlap in a way that makes a bridge between them plausible. */
const ADJACENT_PRESETS: [number, number][] = [
  [0, 10], [0, 1], [1, 8], [1, 10], [2, 5], [2, 9], [3, 7], [4, 7], [4, 8], [5, 7],
  [5, 6], [6, 11], [11, 2], [3, 8], [9, 1], [0, 11], [6, 9], [7, 8], [3, 4], [5, 10],
];

const FIRST_NAMES = ['Ada', 'Bruno', 'Chen', 'Dara', 'Elif', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jamal', 'Kira', 'Liam', 'Mei', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sven', 'Tariq', 'Uma', 'Viktor', 'Wen', 'Ximena', 'Yara', 'Zane', 'Amara', 'Boris', 'Chloe', 'Dmitri'];
const LAST_NAMES = ['Okafor', 'Lindqvist', 'Tanaka', 'Moreau', 'Haddad', 'Petrov', 'Silva', 'Kowalski', 'Nguyen', 'Abernathy', 'Castillo', 'Ivanova', 'Mensah', 'Fischer', 'Rao', 'Larsen', 'Yilmaz', 'Brennan', 'Sato', 'Duarte', 'Novak', 'Osei', 'Hartmann', 'Banerjee', 'Costa', 'Vasquez', 'Jensen', 'Khoury', 'Marchetti', 'Ahn'];
const VENUES = ['Intl. Conf. on Learning Systems', 'Journal of Applied Inference', 'Workshop on Foundations of Data Science', 'Transactions on Scalable Methods', 'Symposium on Algorithms and Society', 'Letters in Computational Intelligence'];
const ADJECTIVES = ['scalable', 'robust', 'principled', 'efficient', 'unified', 'lightweight', 'general'];
const SYLLABLES = ['ka', 'vo', 'ri', 'mu', 'ze', 'tal', 'shen', 'dor', 'nix', 'bel', 'quo', 'fa', 'lum', 'pri', 'sto'];

interface Topic {
  id: number;
  name: string;
  keywords: string[];
  birth: number;
  death?: number;
  weight: number;
  orphan: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.split(' ').map(cap).join(' ');
const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** First index whose cumulative value exceeds x. */
function bisect(cum: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function pseudoWord(rng: Rng): string {
  let w = '';
  for (let i = 0, n = 2 + rng.int(2); i < n; i++) w += rng.pick(SYLLABLES);
  return w;
}

function pseudoKeywords(rng: Rng): string[] {
  const out = new Set<string>();
  while (out.size < 14) out.add(`${pseudoWord(rng)} ${pseudoWord(rng)}`);
  return [...out];
}

/**
 * Deterministic synthetic paper collection with planted structure: topics that are born and grow,
 * hybrid papers that bridge adjacent topics, adjacent topics with no bridge (voids), a topic that
 * goes dormant, and a topic that is often mentioned but rarely studied. Ground truth is returned
 * separately so it never leaks into the papers themselves.
 */
export function generateCollection(overrides: Partial<GenerateOptions> = {}): { papers: PaperInput[]; truth: SyntheticTruth } {
  const o: GenerateOptions = { ...DEFAULT_GENERATE_OPTIONS, ...overrides };
  if (!(o.endYear > o.startYear)) throw new Error('endYear must be greater than startYear');
  if (o.papers < 3) throw new Error('papers must be at least 3');
  const rng = new Rng(o.seed);
  const span = o.endYear - o.startYear;
  const T = Math.max(2, Math.floor(o.topics));

  // --- topics -------------------------------------------------------------------------------
  const presetOrder = rng.shuffle(PRESETS.map((_, i) => i));
  const presetToTopic = new Map<number, number>();
  const topics: Topic[] = [];
  for (let t = 0; t < T; t++) {
    if (t < PRESETS.length) {
      const pi = presetOrder[t];
      presetToTopic.set(pi, t);
      topics.push({ id: t, name: PRESETS[pi].name, keywords: PRESETS[pi].keywords, birth: o.startYear, weight: 1, orphan: false });
    } else {
      topics.push({ id: t, name: `Synthetic topic ${t + 1}`, keywords: pseudoKeywords(rng), birth: o.startYear, weight: 1, orphan: false });
    }
  }

  const adj: Set<number>[] = topics.map(() => new Set<number>());
  const link = (a: number, b: number) => {
    if (a !== b) {
      adj[a].add(b);
      adj[b].add(a);
    }
  };
  for (const [pa, pb] of ADJACENT_PRESETS) {
    const a = presetToTopic.get(pa);
    const b = presetToTopic.get(pb);
    if (a !== undefined && b !== undefined) link(a, b);
  }
  for (let t = PRESETS.length; t < T; t++) {
    link(t, rng.int(t));
    link(t, rng.int(t));
  }
  for (const t of topics) if (adj[t.id].size === 0) link(t.id, (t.id + 1 + rng.int(T - 1)) % T);

  const pairs: [number, number][] = [];
  for (let a = 0; a < T; a++) {
    for (const b of [...adj[a]].sort((x, y) => x - y)) if (a < b) pairs.push([a, b]);
  }
  const shuffledPairs = rng.shuffle([...pairs]);
  const nVoids = Math.min(Math.max(0, Math.floor(o.voids)), Math.floor(pairs.length / 2));
  const voidPairs = shuffledPairs.slice(0, nVoids);
  const bridgedPairs = shuffledPairs.slice(nVoids);
  const voidSet = new Set(voidPairs.map(([a, b]) => pairKey(a, b)));
  const bridgedSet = new Set(bridgedPairs.map(([a, b]) => pairKey(a, b)));

  // --- orphan / dormant topics, birth years -----------------------------------------------------
  const inVoid = new Set(voidPairs.flat());
  const orphanIds = new Set(
    rng.shuffle(topics.map((t) => t.id).filter((id) => !inVoid.has(id))).slice(0, Math.min(Math.max(0, o.orphans), Math.floor(T / 4))),
  );
  const dormantIds = new Set(
    rng.shuffle(topics.map((t) => t.id).filter((id) => !orphanIds.has(id))).slice(0, Math.min(Math.max(0, o.dormant), Math.floor(T / 4))),
  );
  const founding = new Set(rng.shuffle(topics.map((t) => t.id)).slice(0, Math.max(2, Math.round(T / 4))));
  for (const t of topics) {
    t.orphan = orphanIds.has(t.id);
    t.weight = t.orphan ? 0.12 : 0.8 + rng.next() * 0.8;
    t.birth = founding.has(t.id) ? o.startYear : o.startYear + Math.floor(rng.next() * span * 0.65);
    if (dormantIds.has(t.id)) {
      t.birth = o.startYear + rng.int(Math.max(1, Math.floor(span * 0.25)));
      t.death = Math.min(o.endYear - 1, Math.max(t.birth + 3, o.endYear - 4 - rng.int(3)));
    }
  }

  const rate = (t: Topic, year: number): number => {
    if (year < t.birth || (t.death !== undefined && year > t.death)) return 0;
    return t.weight / (1 + Math.exp(-(year - t.birth - 2.5) / 1.6));
  };

  // --- publication dates: the literature grows exponentially, topic by topic -------------------
  const monthYear: number[] = [];
  const monthNum: number[] = [];
  const cumMonth: number[] = [];
  let totalWeight = 0;
  for (let y = o.startYear; y <= o.endYear; y++) {
    const yearRate = topics.reduce((s, t) => s + rate(t, y), 0) * Math.exp(0.1 * (y - o.startYear));
    for (let m = 1; m <= 12; m++) {
      totalWeight += yearRate;
      monthYear.push(y);
      monthNum.push(m);
      cumMonth.push(totalWeight);
    }
  }
  const slots = Array.from({ length: o.papers }, () => bisect(cumMonth, rng.next() * totalWeight)).sort((a, b) => a - b);

  // --- text helpers -------------------------------------------------------------------------------
  const pickKeywords = (ids: number[], count: number): string[] => {
    const out: string[] = [];
    for (let guard = 0; out.length < count && guard < 200; guard++) {
      let t = ids[out.length % ids.length];
      if (ids.length === 1 && adj[t].size > 0 && rng.chance(0.12)) t = rng.pick([...adj[t]].sort((a, b) => a - b));
      const pool = topics[t].keywords;
      const kw = pool[Math.floor(pool.length * Math.pow(rng.next(), 1.6))];
      if (!out.includes(kw)) out.push(kw);
    }
    return out;
  };

  const makeTitle = (kws: string[]): string => {
    const a = titleCase(kws[0]);
    const b = titleCase(kws[1]);
    const adjective = cap(rng.pick(ADJECTIVES));
    return rng.pick([
      `${adjective} ${a} for ${b}`,
      `Towards ${a} with ${b}`,
      `On the Limits of ${a} in ${b}`,
      `Rethinking ${a} through ${b}`,
      `${adjective} ${a} via ${b}`,
      `${a} Meets ${b}`,
      `Does ${a} Help ${b}?`,
    ]);
  };

  const makeAbstract = (kws: string[]): string => {
    const adjective = () => rng.pick(ADJECTIVES);
    const n = 2 + rng.int(8);
    const parts = [
      rng.pick([
        `${cap(kws[0])} remains challenging when ${kws[1]} is limited.`,
        `Recent work on ${kws[0]} has largely overlooked ${kws[1]}.`,
        `We study ${kws[0]} in the setting of ${kws[1]}.`,
        `Understanding ${kws[0]} is central to progress in ${kws[1]}.`,
      ]),
      rng.pick([
        `We propose a ${adjective()} framework that combines ${kws[2]} with ${kws[3]}.`,
        `Our method builds on ${kws[2]} and introduces a new treatment of ${kws[3]}.`,
        `We introduce an approach based on ${kws[2]}, extending prior work on ${kws[3]}.`,
      ]),
      rng.pick([
        `Experiments on ${n} benchmarks show consistent improvements over strong baselines.`,
        `We prove ${adjective()} guarantees and validate them empirically across ${n} datasets.`,
        `Our analysis reveals that ${kws[4]} is the dominant factor, contrary to common assumptions.`,
      ]),
    ];
    if (rng.chance(0.35)) {
      parts.push(
        rng.pick([
          `A limitation of our approach is its reliance on ${kws[5]}; extending it is left for future work.`,
          `Results are limited to small-scale settings, and ${kws[5]} is not addressed.`,
        ]),
      );
    }
    return parts.join(' ');
  };

  // --- papers -------------------------------------------------------------------------------------
  const idWidth = Math.max(4, String(o.papers).length);
  const authorPools = topics.map(() => Array.from({ length: 12 }, () => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`));
  const orphanTopics = topics.filter((t) => t.orphan);
  const papers: PaperInput[] = [];
  const topicsOf: number[][] = [];
  const paperT: number[] = [];

  for (let i = 0; i < o.papers; i++) {
    const year = monthYear[slots[i]];
    const month = monthNum[slots[i]];
    const weights = topics.map((t) => rate(t, year));
    const wTotal = weights.reduce((a, b) => a + b, 0);
    let r = rng.next() * wTotal;
    let primary = topics.length - 1;
    for (let k = 0; k < weights.length; k++) {
      r -= weights[k];
      if (r <= 0) {
        primary = k;
        break;
      }
    }
    if (weights[primary] <= 0) primary = weights.findIndex((w) => w > 0);

    let ids = [primary];
    if (!topics[primary].orphan && rng.chance(0.12)) {
      const cands = [...adj[primary]]
        .sort((a, b) => a - b)
        .filter((b) => bridgedSet.has(pairKey(primary, b)) && weights[b] > 0 && !topics[b].orphan);
      if (cands.length > 0) {
        const cw = cands.map((b) => weights[b]);
        let x = rng.next() * cw.reduce((a, b) => a + b, 0);
        let chosen = cands[cands.length - 1];
        for (let k = 0; k < cands.length; k++) {
          x -= cw[k];
          if (x <= 0) {
            chosen = cands[k];
            break;
          }
        }
        ids = [primary, chosen];
      }
    }

    const kws = pickKeywords(ids, 6);
    let abstract = makeAbstract(kws);
    for (const ot of orphanTopics) {
      if (year > ot.birth && adj[primary].has(ot.id) && rng.chance(0.3)) {
        abstract += ` Whether these ideas extend to ${rng.pick(ot.keywords.slice(0, 4))} remains an open question.`;
      }
    }

    const authors: string[] = [];
    for (let a = 0, n = 2 + rng.int(4); a < n; a++) {
      const name = a > 0 && rng.chance(0.3) ? `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}` : rng.pick(authorPools[ids[a % ids.length]]);
      if (!authors.includes(name)) authors.push(name);
    }

    papers.push({
      id: `syn-${String(i + 1).padStart(idWidth, '0')}`,
      title: makeTitle(kws),
      date: `${year}-${String(month).padStart(2, '0')}`,
      abstract,
      authors,
      venue: VENUES[(primary + (rng.chance(0.3) ? rng.int(VENUES.length) : 0)) % VENUES.length],
      keywords: kws.slice(0, 3),
    });
    topicsOf.push(ids);
    paperT.push(year * 12 + month - 1);
  }

  // --- citations: older papers, same topic first, never across a planted void ----------------------
  const affinity = (p: number[], c: number[]): number => {
    let best = 0.15;
    for (const x of p) {
      for (const y of c) {
        if (voidSet.has(pairKey(x, y))) return 0;
        if (x === y) best = Math.max(best, 8);
        else if (bridgedSet.has(pairKey(x, y))) best = Math.max(best, 1.5);
      }
    }
    return best;
  };

  const indeg = new Int32Array(o.papers);
  for (let i = 1; i < o.papers; i++) {
    const cum = new Float64Array(i);
    let acc = 0;
    for (let j = 0; j < i; j++) {
      const ageYears = (paperT[i] - paperT[j]) / 12;
      acc += affinity(topicsOf[i], topicsOf[j]) * Math.pow(indeg[j] + 1, 0.9) * Math.exp(-ageYears / 7);
      cum[j] = acc;
    }
    if (acc <= 0) continue;
    const want = Math.min(i, Math.max(1, rng.poisson(o.avgReferences)));
    const chosen = new Set<number>();
    for (let tries = 0; chosen.size < want && tries < want * 6; tries++) chosen.add(bisect(cum, rng.next() * acc));
    papers[i].references = [...chosen].sort((a, b) => a - b).map((j) => papers[j].id);
    for (const j of chosen) indeg[j]++;
  }

  const truth: SyntheticTruth = {
    options: o,
    topics: topics.map((t) => ({
      id: t.id,
      name: t.name,
      birthYear: t.birth,
      deathYear: t.death,
      orphan: t.orphan,
      adjacent: [...adj[t.id]].sort((a, b) => a - b),
    })),
    paperTopics: Object.fromEntries(papers.map((p, i) => [p.id, topicsOf[i]])),
    bridgeVoids: voidPairs.map(([a, b]) => ({ a, b })),
    bridged: bridgedPairs.map(([a, b]) => ({ a, b })),
  };
  return { papers, truth };
}
