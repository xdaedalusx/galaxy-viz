import { Rng, fnv1a } from '../util/rng.ts';
import type { TfidfModel } from './text.ts';

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const norm = Math.sqrt(s);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * Dense embedding by random projection of the TF-IDF vectors (Johnson-Lindenstrauss): each term gets a
 * fixed pseudo-random +/-1 vector seeded from the term text, so results are deterministic and
 * independent of document order. Preserves cosine similarity approximately, needs no model download.
 */
export function projectDocs(model: TfidfModel, dim: number, seed: number): Float32Array[] {
  const cache = new Map<number, Float32Array>();
  const termVector = (j: number): Float32Array => {
    let v = cache.get(j);
    if (!v) {
      const r = new Rng(fnv1a(model.terms[j]) ^ seed);
      v = new Float32Array(dim);
      for (let d = 0; d < dim; d++) v[d] = r.next() < 0.5 ? -1 : 1;
      cache.set(j, v);
    }
    return v;
  };

  return model.docs.map((doc) => {
    const out = new Float32Array(dim);
    for (let k = 0; k < doc.idx.length; k++) {
      const v = termVector(doc.idx[k]);
      const w = doc.val[k];
      for (let d = 0; d < dim; d++) out[d] += w * v[d];
    }
    return l2normalize(out);
  });
}
