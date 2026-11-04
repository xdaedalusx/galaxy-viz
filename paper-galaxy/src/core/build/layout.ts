import type { Vec3 } from '../types.ts';
import { Rng } from '../util/rng.ts';

/**
 * Top-k most cosine-similar rows for every row of X (rows must be L2-normalised).
 * Brute force, O(n^2 d): a couple of seconds at 2-3k papers, offline only.
 */
export function knnGraph(X: Float32Array[], k: number): { idx: Int32Array; sim: Float32Array; k: number } {
  const n = X.length;
  const d = X[0].length;
  const kk = Math.max(1, Math.min(k, n - 1));
  const flat = new Float32Array(n * d);
  X.forEach((x, i) => flat.set(x, i * d));
  const idx = new Int32Array(n * kk).fill(-1);
  const sim = new Float32Array(n * kk).fill(-Infinity);

  for (let i = 0; i < n; i++) {
    const base = i * kk;
    const io = i * d;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const jo = j * d;
      let s = 0;
      for (let t = 0; t < d; t++) s += flat[io + t] * flat[jo + t];
      if (s <= sim[base + kk - 1]) continue;
      let p = kk - 1;
      while (p > 0 && sim[base + p - 1] < s) {
        sim[base + p] = sim[base + p - 1];
        idx[base + p] = idx[base + p - 1];
        p--;
      }
      sim[base + p] = s;
      idx[base + p] = j;
    }
  }
  return { idx, sim, k: kk };
}

/** UMAP-style fuzzy union of directed kNN memberships (each node's nearest neighbour gets weight 1). */
function fuzzyEdges(g: { idx: Int32Array; sim: Float32Array; k: number }, n: number) {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const maxS = g.sim[i * g.k];
    if (!(maxS > 0)) continue;
    for (let r = 0; r < g.k; r++) {
      const j = g.idx[i * g.k + r];
      const s = g.sim[i * g.k + r];
      if (j < 0 || !(s > 0)) continue;
      const w = Math.min(1, s / maxS);
      const key = i < j ? i * n + j : j * n + i;
      const prev = m.get(key);
      m.set(key, prev === undefined ? w : prev + w - prev * w);
    }
  }
  const keys = [...m.keys()].sort((a, b) => a - b);
  const a = new Int32Array(keys.length);
  const b = new Int32Array(keys.length);
  const w = new Float32Array(keys.length);
  keys.forEach((key, e) => {
    a[e] = Math.floor(key / n);
    b[e] = key % n;
    w[e] = m.get(key) as number;
  });
  return { a, b, w };
}

/** Top-3 principal components by power iteration with deflation. */
export function pca3(X: Float32Array[], seed: number): Vec3[] {
  const n = X.length;
  const dim = X[0]?.length ?? 0;
  const mean = new Float64Array(dim);
  for (const x of X) for (let d = 0; d < dim; d++) mean[d] += x[d] / n;
  const C = X.map((x) => {
    const r = new Float64Array(dim);
    for (let d = 0; d < dim; d++) r[d] = x[d] - mean[d];
    return r;
  });

  const rng = new Rng(seed ^ 0x9e3779b9);
  const comps: Float64Array[] = [];
  for (let c = 0; c < Math.min(3, dim); c++) {
    const v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) v[d] = rng.next() - 0.5;
    let norm = Math.hypot(...v) || 1;
    for (let d = 0; d < dim; d++) v[d] /= norm;

    for (let it = 0; it < 80; it++) {
      const w = new Float64Array(dim);
      for (const r of C) {
        let p = 0;
        for (let d = 0; d < dim; d++) p += r[d] * v[d];
        for (let d = 0; d < dim; d++) w[d] += p * r[d];
      }
      for (const u of comps) {
        let p = 0;
        for (let d = 0; d < dim; d++) p += w[d] * u[d];
        for (let d = 0; d < dim; d++) w[d] -= p * u[d];
      }
      norm = Math.hypot(...w);
      if (norm === 0) break;
      for (let d = 0; d < dim; d++) v[d] = w[d] / norm;
    }
    comps.push(v);
  }

  return C.map((r) => {
    const out: Vec3 = [0, 0, 0];
    comps.forEach((u, c) => {
      let p = 0;
      for (let d = 0; d < dim; d++) p += r[d] * u[d];
      out[c] = p;
    });
    return out;
  });
}

/**
 * UMAP-style 3D layout, implemented directly so there is no dependency: a fuzzy kNN graph in
 * embedding space, then stochastic gradient descent with attraction along graph edges and repulsion
 * from random negative samples (UMAP's own update rules with its default a, b). Initialised from PCA.
 * Neighbours come from text/embedding similarity only, never from citations, so citation edges stay
 * independent evidence about the layout.
 */
export function forceLayout(X: Float32Array[], opts: { seed: number; k?: number; epochs?: number; negatives?: number }): Vec3[] {
  const n = X.length;
  const rng = new Rng(opts.seed);
  const g = knnGraph(X, opts.k ?? 12);
  const { a: ea, b: eb, w: ew } = fuzzyEdges(g, n);
  const m = ea.length;

  const init = pca3(X, opts.seed);
  let maxAbs = 0;
  for (const p of init) for (let c = 0; c < 3; c++) maxAbs = Math.max(maxAbs, Math.abs(p[c]));
  const scale = maxAbs > 0 ? 10 / maxAbs : 1;
  const P = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) P[i * 3 + c] = init[i][c] * scale + (rng.next() - 0.5) * 1e-3;

  const A = 1.577;
  const B = 0.895;
  const epochs = opts.epochs ?? (n <= 2000 ? 400 : n <= 10000 ? 250 : 150);
  const negatives = opts.negatives ?? 5;
  const clip = (x: number) => (x > 4 ? 4 : x < -4 ? -4 : x);

  const repel = (i: number, alpha: number) => {
    for (let s = 0; s < negatives; s++) {
      const q = rng.int(n);
      if (q === i) continue;
      const dx = P[i * 3] - P[q * 3];
      const dy = P[i * 3 + 1] - P[q * 3 + 1];
      const dz = P[i * 3 + 2] - P[q * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 0) {
        const coeff = (2 * B) / ((0.001 + d2) * (A * Math.pow(d2, B) + 1));
        P[i * 3] += clip(coeff * dx) * alpha;
        P[i * 3 + 1] += clip(coeff * dy) * alpha;
        P[i * 3 + 2] += clip(coeff * dz) * alpha;
      } else {
        // coincident points: push apart in a random direction
        P[i * 3] += (rng.next() - 0.5) * alpha;
        P[i * 3 + 1] += (rng.next() - 0.5) * alpha;
        P[i * 3 + 2] += (rng.next() - 0.5) * alpha;
      }
    }
  };

  for (let ep = 0; ep < epochs; ep++) {
    const alpha = 1 - ep / epochs;
    for (let e = 0; e < m; e++) {
      if (rng.next() > ew[e]) continue;
      const i = ea[e];
      const j = eb[e];
      const dx = P[i * 3] - P[j * 3];
      const dy = P[i * 3 + 1] - P[j * 3 + 1];
      const dz = P[i * 3 + 2] - P[j * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 0) {
        const coeff = (-2 * A * B * Math.pow(d2, B - 1)) / (A * Math.pow(d2, B) + 1);
        const gx = clip(coeff * dx) * alpha;
        const gy = clip(coeff * dy) * alpha;
        const gz = clip(coeff * dz) * alpha;
        P[i * 3] += gx;
        P[i * 3 + 1] += gy;
        P[i * 3 + 2] += gz;
        P[j * 3] -= gx;
        P[j * 3 + 1] -= gy;
        P[j * 3 + 2] -= gz;
      }
      repel(i, alpha);
      repel(j, alpha);
    }
  }

  return Array.from({ length: n }, (_, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]] as Vec3);
}

/** Centre on the mean and scale so the 98th-percentile radius equals `radius`. */
export function fitToSphere(P: Vec3[], radius: number): Vec3[] {
  const n = P.length;
  if (n === 0) return [];
  const mean = [0, 0, 0];
  for (const p of P) for (let c = 0; c < 3; c++) mean[c] += p[c] / n;
  const radii = P.map((p) => Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2])).sort((a, b) => a - b);
  const r98 = radii[Math.min(n - 1, Math.floor(0.98 * n))];
  const s = r98 > 0 ? radius / r98 : 1;
  return P.map((p) => [(p[0] - mean[0]) * s, (p[1] - mean[1]) * s, (p[2] - mean[2]) * s] as Vec3);
}

export function layout3d(
  X: Float32Array[],
  opts: { method: 'force' | 'pca'; seed: number; radius: number },
): { positions: Vec3[]; method: 'force' | 'pca'; warning?: string } {
  let method = opts.method;
  let warning: string | undefined;
  if (method === 'force' && X.length < 8) {
    method = 'pca';
    warning = 'Fewer than 8 papers: used a PCA layout instead of the neighbor force layout.';
  }
  const raw = method === 'force' ? forceLayout(X, { seed: opts.seed }) : pca3(X, opts.seed);
  return { positions: fitToSphere(raw, opts.radius), method, warning };
}
