import { Rng } from '../util/rng.ts';
import { l2normalize } from './embed.ts';
import type { TfidfModel } from './text.ts';

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Heuristic default: grows slowly with collection size, clamped to a readable range. */
export function autoK(n: number): number {
  return Math.max(2, Math.min(14, Math.round(Math.sqrt(n / 3))));
}

function runOnce(X: Float32Array[], k: number, rng: Rng, maxIter: number): { labels: Int32Array; score: number } {
  const n = X.length;
  const dim = X[0].length;

  // k-means++ seeding on cosine distance
  const centroids: Float32Array[] = [Float32Array.from(X[rng.int(n)])];
  const d2 = new Float64Array(n).fill(Infinity);
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      d2[i] = Math.min(d2[i], Math.max(1 - dot(X[i], last), 0));
      total += d2[i] * d2[i];
    }
    let pick = rng.int(n);
    if (total > 0) {
      let r = rng.next() * total;
      for (let i = 0; i < n; i++) {
        r -= d2[i] * d2[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
    }
    centroids.push(Float32Array.from(X[pick]));
  }

  const labels = new Int32Array(n).fill(-1);
  const sims = new Float64Array(n);
  let score = 0;
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    score = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const s = dot(X[i], centroids[c]);
        if (s > bestSim) {
          bestSim = s;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed++;
      }
      sims[i] = bestSim;
      score += bestSim;
    }

    const sums = Array.from({ length: k }, () => new Float32Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      const s = sums[labels[i]];
      for (let d = 0; d < dim; d++) s[d] += X[i][d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        // re-seed an empty cluster at the point worst served by its current centroid
        let worst = 0;
        let worstSim = Infinity;
        for (let i = 0; i < n; i++) {
          if (sims[i] < worstSim) {
            worstSim = sims[i];
            worst = i;
          }
        }
        centroids[c] = Float32Array.from(X[worst]);
        sims[worst] = Infinity;
        changed++;
      } else centroids[c] = l2normalize(sums[c]);
    }
    if (changed === 0) break;
  }
  return { labels, score };
}

/** Renumber so cluster 0 is the largest; empty clusters are dropped. `order[newId]` is the old id. */
export function relabelBySize(labels: Int32Array): { labels: Int32Array; count: number; order: number[] } {
  const sizes = new Map<number, number>();
  for (const l of labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);
  const order = [...sizes.keys()].sort((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0) || a - b);
  const remap = new Map(order.map((old, i) => [old, i] as const));
  return { labels: Int32Array.from(labels, (l) => remap.get(l) ?? 0), count: order.length, order };
}

/** Spherical k-means (cosine) with restarts; deterministic for a given seed. Clusters are sized-ordered. */
export function sphericalKMeans(X: Float32Array[], k: number, seed: number, restarts = 4, maxIter = 50) {
  const rng = new Rng(seed);
  const kk = Math.max(1, Math.min(k, X.length));
  let best: { labels: Int32Array; score: number } | undefined;
  for (let r = 0; r < restarts; r++) {
    const res = runOnce(X, kk, rng, maxIter);
    if (!best || res.score > best.score) best = res;
  }
  return relabelBySize((best as { labels: Int32Array }).labels);
}

const termWords = (t: string) => t.split(' ');

/** Label each cluster with its most distinctive terms (mean TF-IDF weight, boosted by cluster specificity). */
export function labelClusters(model: TfidfModel, labels: Int32Array, count: number): { label: string; keywords: string[] }[] {
  const V = model.terms.length;
  const N = labels.length;
  const global = new Float64Array(V);
  const per = Array.from({ length: count }, () => new Float64Array(V));
  const sizes = new Int32Array(count);

  for (let i = 0; i < N; i++) {
    const c = labels[i];
    sizes[c]++;
    const d = model.docs[i];
    for (let a = 0; a < d.idx.length; a++) {
      per[c][d.idx[a]] += d.val[a];
      global[d.idx[a]] += d.val[a];
    }
  }

  return per.map((p, c) => {
    if (sizes[c] === 0) return { label: `Cluster ${c + 1}`, keywords: [] };
    const scored: [string, number][] = [];
    for (let j = 0; j < V; j++) {
      if (p[j] === 0) continue;
      const mc = p[j] / sizes[c];
      const mg = global[j] / N;
      scored.push([model.terms[j], mc * Math.sqrt(mc / (mg + 1e-9))]);
    }
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

    const picked: string[] = [];
    for (const [t] of scored) {
      const tw = termWords(t);
      // skip terms that merely restate (or are restated by) one already chosen: "graph" vs "graph neural"
      if (picked.some((q) => tw.every((w) => termWords(q).includes(w)) || termWords(q).every((w) => tw.includes(w)))) continue;
      picked.push(t);
      if (picked.length >= 8) break;
    }
    return { label: picked.slice(0, 3).join(' · ') || `Cluster ${c + 1}`, keywords: picked };
  });
}
