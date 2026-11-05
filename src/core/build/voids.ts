import type { GraphEdge, MonthIndex, Region, Vec3 } from '../types.ts';

/**
 * Bridge-gap detection: pairs of clusters whose papers read alike but do not cite each other.
 *
 * Two link-enrichment ratios are computed per cluster pair, each as observed cross-cluster links over
 * the count expected if edges ignored clusters (configuration model: S_a * S_b / 2E, with S = a
 * cluster's edge endpoints):
 *
 *   textRatio   over similarity edges.  High = the clusters share vocabulary ("related").
 *   citeRatio   over citation edges.    Low  = the clusters rarely cite each other ("unbridged").
 *
 * Related-but-unbridged pairs are reported. Both ratios come from the edge structure, never from the
 * 3D layout, because a projection distorts distances and would invent holes; the layout is only used
 * afterwards to choose where to draw the void.
 *
 * Without citation data there is nothing to contrast the text links against, so no voids are reported.
 */
export interface VoidOptions {
  /** Report at most this many voids (highest score first). */
  maxVoids: number;
  /** Minimum text-link enrichment for a pair to count as related. */
  minTextRatio: number;
  /** Minimum number of observed text links across the pair (guards against a single stray edge). */
  minTextLinks: number;
  /** Maximum citation-link enrichment for a pair to count as unbridged. */
  maxCiteRatio: number;
  /** Skip pairs whose expected citation count is below this: too little evidence to call links "missing". */
  minExpectedCites: number;
  /** A cluster counts as established once it has this many papers (sets when the void appears). */
  establishedSize: number;
}

export const DEFAULT_VOID_OPTIONS: VoidOptions = {
  maxVoids: 6,
  minTextRatio: 0.2,
  minTextLinks: 3,
  maxCiteRatio: 0.5,
  minExpectedCites: 3,
  establishedSize: 5,
};

export interface VoidCandidate {
  a: number;
  b: number;
  textObserved: number;
  textExpected: number;
  textRatio: number;
  citeObserved: number;
  citeExpected: number;
  citeRatio: number;
  /** textRatio x (1 - citeRatio): related and unbridged both count. */
  score: number;
}

export interface VoidInput {
  labels: Int32Array;
  clusterCount: number;
  citationEdges: GraphEdge[];
  similarityEdges: GraphEdge[];
  positions: Vec3[];
  /** Node month, same order as `labels`. */
  t: MonthIndex[];
  clusterLabels: string[];
}

export interface VoidResult {
  regions: Region[];
  /** Every evaluated pair (reported or not), for diagnostics and tests. */
  candidates: VoidCandidate[];
}

/** Observed and expected cross-cluster link counts for every cluster pair. */
function linkEnrichment(edges: GraphEdge[], labels: Int32Array, K: number) {
  const stubs = new Float64Array(K);
  const obs = new Float64Array(K * K);
  for (const e of edges) {
    const a = labels[e.source];
    const b = labels[e.target];
    stubs[a]++;
    stubs[b]++;
    if (a !== b) {
      obs[a * K + b]++;
      obs[b * K + a]++;
    }
  }
  const E = edges.length;
  return (a: number, b: number) => ({
    observed: obs[a * K + b],
    expected: E > 0 ? (stubs[a] * stubs[b]) / (2 * E) : 0,
  });
}

export function detectBridgeVoids(input: VoidInput, overrides: Partial<VoidOptions> = {}): VoidResult {
  const o = { ...DEFAULT_VOID_OPTIONS, ...overrides };
  const { labels, clusterCount: K, citationEdges, similarityEdges, positions, t } = input;
  const n = labels.length;
  if (K < 3 || citationEdges.length === 0 || similarityEdges.length === 0 || n === 0) return { regions: [], candidates: [] };

  const size = new Int32Array(K);
  for (let i = 0; i < n; i++) size[labels[i]]++;
  const text = linkEnrichment(similarityEdges, labels, K);
  const cite = linkEnrichment(citationEdges, labels, K);

  const candidates: VoidCandidate[] = [];
  for (let a = 0; a < K; a++) {
    for (let b = a + 1; b < K; b++) {
      if (size[a] < o.establishedSize || size[b] < o.establishedSize) continue;
      const c = cite(a, b);
      if (c.expected < o.minExpectedCites) continue;
      const x = text(a, b);
      if (x.expected <= 0) continue;
      const textRatio = x.observed / x.expected;
      const citeRatio = c.observed / c.expected;
      candidates.push({
        a,
        b,
        textObserved: x.observed,
        textExpected: x.expected,
        textRatio,
        citeObserved: c.observed,
        citeExpected: c.expected,
        citeRatio,
        score: textRatio * (1 - Math.min(1, citeRatio)),
      });
    }
  }

  const picked = candidates
    .filter((c) => c.textObserved >= o.minTextLinks && c.textRatio >= o.minTextRatio && c.citeRatio <= o.maxCiteRatio)
    .sort((x, y) => y.score - x.score)
    .slice(0, o.maxVoids);

  // Month a cluster becomes established: the month of its establishedSize-th paper.
  const reach = (c: number): MonthIndex => {
    const ts: MonthIndex[] = [];
    for (let i = 0; i < n; i++) if (labels[i] === c) ts.push(t[i]);
    ts.sort((x, y) => x - y);
    return ts[Math.min(ts.length, o.establishedSize) - 1];
  };

  const regions: Region[] = picked.map((c, rank) => {
    // Cluster centres in the layout; the void is drawn at the emptiest spot on the segment between them.
    const ca = centroid3(positions, labels, c.a);
    const cb = centroid3(positions, labels, c.b);
    const segLen = Math.hypot(cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]);
    let best: Vec3 = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2, (ca[2] + cb[2]) / 2];
    let bestClear = -1;
    const steps = 11;
    for (let s = 1; s < steps; s++) {
      const f = s / steps;
      const p: Vec3 = [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
      const clear = nearestNode(positions, p);
      if (clear > bestClear) {
        bestClear = clear;
        best = p;
      }
    }
    return {
      id: `void-${rank + 1}`,
      kind: 'void' as const,
      center: [round1(best[0]), round1(best[1]), round1(best[2])] as Vec3,
      radius: round1(Math.max(1, Math.min(bestClear * 0.9, segLen / 2))),
      t0: Math.max(reach(c.a), reach(c.b)),
      label: `${input.clusterLabels[c.a]} ⟷ ${input.clusterLabels[c.b]}`,
      between: [c.a, c.b] as [number, number],
      score: Math.round(c.score * 1000) / 1000,
      evidence:
        `Papers in these clusters read alike (${c.textObserved} similarity links across them, ${c.textRatio.toFixed(2)}x the chance rate for unrelated pairs of this size) ` +
        `but cite each other rarely (${c.citeObserved} citation(s), where ~${c.citeExpected.toFixed(0)} would be expected if clusters were ignored).`,
    };
  });

  return { regions, candidates };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function centroid3(pos: Vec3[], labels: Int32Array, c: number): Vec3 {
  const out: Vec3 = [0, 0, 0];
  let m = 0;
  for (let i = 0; i < pos.length; i++) {
    if (labels[i] !== c) continue;
    m++;
    out[0] += pos[i][0];
    out[1] += pos[i][1];
    out[2] += pos[i][2];
  }
  if (m > 0) for (let a = 0; a < 3; a++) out[a] /= m;
  return out;
}

function nearestNode(pos: Vec3[], p: Vec3): number {
  let best = Infinity;
  for (const q of pos) {
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
