export interface Sparse {
  idx: Int32Array;
  val: Float64Array;
}

export interface TfidfModel {
  terms: string[];
  idf: Float64Array;
  /** L2-normalised sparse TF-IDF vector per document. */
  docs: Sparse[];
}

const STOPWORDS = new Set(
  (
    'a about above across after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours ' +
    // generic academic filler that carries no topical signal
    'paper propose proposed proposes approach method methods result results show shows shown study studies introduce introduces novel new present presents using used use based work works however thus within via among towards toward may might many much one two three several various consistent consistently strong improvements experiments experimental baselines benchmark benchmarks framework'
  ).split(/\s+/),
);

/** Very light plural stripping, ASCII words only. */
function stem(w: string): string {
  if (!/^[a-z]+$/.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || /^\d+$/.test(raw)) continue;
    const w = stem(raw);
    if (STOPWORDS.has(raw) || STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** Token segments (bigrams never cross a segment boundary). Titles and keywords count double. */
export function paperSegments(p: { title: string; abstract?: string; keywords?: string[] }): string[][] {
  const title = tokenize(p.title);
  const segs: string[][] = [title, title];
  for (const k of p.keywords ?? []) {
    const t = tokenize(k);
    segs.push(t, t);
  }
  if (p.abstract) for (const s of p.abstract.split(/[.!?;]\s+/)) segs.push(tokenize(s));
  return segs.filter((s) => s.length > 0);
}

/** Unigram + bigram TF-IDF (sublinear tf, smooth idf). Rare and near-ubiquitous terms are dropped on larger corpora. */
export function buildTfidf(docSegments: string[][][]): TfidfModel {
  const N = docSegments.length;
  const counts = docSegments.map((segs) => {
    const m = new Map<string, number>();
    for (const seg of segs) {
      for (let i = 0; i < seg.length; i++) {
        m.set(seg[i], (m.get(seg[i]) ?? 0) + 1);
        if (i + 1 < seg.length) {
          const bigram = seg[i] + ' ' + seg[i + 1];
          m.set(bigram, (m.get(bigram) ?? 0) + 1);
        }
      }
    }
    return m;
  });

  const df = new Map<string, number>();
  for (const m of counts) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  const minDf = N >= 30 ? 2 : 1;
  const maxDf = N >= 30 ? Math.floor(0.6 * N) : N;
  const terms = [...df.entries()]
    .filter(([, d]) => d >= minDf && d <= maxDf)
    .map(([t]) => t)
    .sort();
  const index = new Map(terms.map((t, i) => [t, i] as const));
  const idf = new Float64Array(terms.length);
  terms.forEach((t, i) => {
    idf[i] = Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
  });

  const docs: Sparse[] = counts.map((m) => {
    const pairs: [number, number][] = [];
    for (const [t, c] of m) {
      const j = index.get(t);
      if (j !== undefined) pairs.push([j, (1 + Math.log(c)) * idf[j]]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    let norm = 0;
    for (const [, v] of pairs) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return { idx: Int32Array.from(pairs, (p) => p[0]), val: Float64Array.from(pairs, (p) => p[1] / norm) };
  });

  return { terms, idf, docs };
}
