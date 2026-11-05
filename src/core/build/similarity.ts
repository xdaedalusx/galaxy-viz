import type { Sparse } from './text.ts';

export interface SimEdge {
  /** The newer paper (later in time order). */
  source: number;
  /** An older paper it resembles. */
  target: number;
  weight: number;
}

/**
 * Time-aware similarity edges. `docs` must be in time order. Each paper links back to its `k` most
 * similar *earlier* papers (cosine >= minSim), so a paper only ever attaches to work that already
 * existed when it appeared. Exact, via an inverted index that grows as papers are processed.
 */
export function similarityEdges(docs: Sparse[], vocabSize: number, k: number, minSim: number): SimEdge[] {
  const n = docs.length;
  const postDocs: number[][] = Array.from({ length: vocabSize }, () => []);
  const postVals: number[][] = Array.from({ length: vocabSize }, () => []);
  const scores = new Float64Array(n);
  const edges: SimEdge[] = [];

  for (let i = 0; i < n; i++) {
    const d = docs[i];
    const touched: number[] = [];
    for (let a = 0; a < d.idx.length; a++) {
      const t = d.idx[a];
      const w = d.val[a];
      const pd = postDocs[t];
      const pv = postVals[t];
      for (let b = 0; b < pd.length; b++) {
        const j = pd[b];
        if (scores[j] === 0) touched.push(j);
        scores[j] += w * pv[b];
      }
    }

    const cands: { j: number; s: number }[] = [];
    for (const j of touched) {
      if (scores[j] >= minSim) cands.push({ j, s: scores[j] });
      scores[j] = 0;
    }
    cands.sort((x, y) => y.s - x.s || y.j - x.j);
    for (const c of cands.slice(0, k)) edges.push({ source: i, target: c.j, weight: c.s });

    for (let a = 0; a < d.idx.length; a++) {
      postDocs[d.idx[a]].push(i);
      postVals[d.idx[a]].push(d.val[a]);
    }
  }
  return edges;
}
