import { normalizeDoi } from '../import/normalize.ts';
import type {
  BuildOptions,
  BuildStats,
  ClusterInfo,
  DetailsFile,
  GraphData,
  GraphEdge,
  GraphNode,
  MonthIndex,
  PaperDetails,
  PaperInput,
  Vec3,
} from '../types.ts';
import { monthIndex, parseDate } from '../util/dates.ts';
import { autoK, labelClusters, relabelBySize, sphericalKMeans } from './cluster.ts';
import { l2normalize, projectDocs } from './embed.ts';
import { layout3d } from './layout.ts';
import { similarityEdges } from './similarity.ts';
import { detectConflicts } from './conflicts.ts';
import { detectBridgeVoids } from './voids.ts';
import { buildTfidf, paperSegments } from './text.ts';

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  seed: 42,
  similarityK: 4,
  minSimilarity: 0.1,
  clusters: 'auto',
  layout: 'force',
  radius: 300,
  embeddingDim: 192,
};

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface Rec {
  p: PaperInput;
  year: number;
  t: MonthIndex;
}

/**
 * Turn a paper collection into the time-aware graph the renderer loads. Pure and deterministic
 * (same input + options => identical output), and free of Node APIs, so it also runs in the browser.
 */
export function buildGraph(input: PaperInput[], overrides: Partial<BuildOptions> = {}): { graph: GraphData; details: DetailsFile } {
  const options: BuildOptions = { ...DEFAULT_BUILD_OPTIONS, ...overrides };
  const warnings: string[] = [];
  const stats: BuildStats = {
    papersIn: input.length,
    papersKept: 0,
    duplicateIds: 0,
    yearOnlyDates: 0,
    referencesTotal: 0,
    referencesResolved: 0,
    citationsToLaterPapers: 0,
  };

  // 1. validate, de-duplicate ids, order by time ---------------------------------------------------
  const recs: Rec[] = [];
  const usedIds = new Set<string>();
  for (const p of input) {
    const d = parseDate(p.date);
    if (!p.title || !p.title.trim() || !d) continue;
    let id = String(p.id);
    if (usedIds.has(id)) {
      stats.duplicateIds++;
      let n = 2;
      while (usedIds.has(`${id}#${n}`)) n++;
      id = `${id}#${n}`;
    }
    usedIds.add(id);
    if (d.precision === 'year') stats.yearOnlyDates++;
    recs.push({ p: { ...p, id }, year: d.year, t: monthIndex(d.year, d.month) });
  }
  stats.papersKept = recs.length;
  if (recs.length < 3) throw new Error(`Need at least 3 papers with a title and a usable date (got ${recs.length} of ${input.length})`);
  recs.sort((a, b) => a.t - b.t || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
  const n = recs.length;

  const byId = new Map<string, number>();
  const byDoi = new Map<string, number>();
  recs.forEach((r, i) => {
    byId.set(r.p.id, i);
    const doi = normalizeDoi(r.p.doi);
    if (doi && !byDoi.has(doi)) byDoi.set(doi, i);
  });
  const resolve = (ref: string): number | undefined => byId.get(ref) ?? byDoi.get(normalizeDoi(ref) ?? '');

  // 2. citation edges: citing -> cited, appearing when the later of the two papers appears -----------
  const edges: GraphEdge[] = [];
  const cited = new Set<string>();
  const indegree = new Int32Array(n);
  recs.forEach((r, i) => {
    const seen = new Set<number>();
    for (const ref of r.p.references ?? []) {
      stats.referencesTotal++;
      const j = resolve(ref);
      if (j === undefined || j === i || seen.has(j)) continue;
      seen.add(j);
      stats.referencesResolved++;
      if (recs[j].t > r.t) stats.citationsToLaterPapers++;
      indegree[j]++;
      edges.push({ source: i, target: j, type: 'citation', weight: 1, t: Math.max(r.t, recs[j].t) });
      cited.add(pairKey(i, j));
    }
  });
  const citationEdgeCount = edges.length;

  // 3. text model and embedding ---------------------------------------------------------------------
  const model = buildTfidf(recs.map((r) => paperSegments(r.p)));
  const provided = recs.map((r) => r.p.embedding);
  const providedDim = provided[0]?.length ?? 0;
  const allProvided = providedDim > 0 && provided.every((e) => e !== undefined && e.length === providedDim);
  let embeddingKind: 'provided' | 'tfidf-projection' = 'tfidf-projection';
  let emb: Float32Array[];
  if (allProvided) {
    emb = provided.map((e) => l2normalize(Float32Array.from(e as number[])));
    embeddingKind = 'provided';
  } else {
    const some = provided.filter((e) => e !== undefined).length;
    if (some > 0) warnings.push(`Only ${some} of ${n} papers have a usable embedding (or lengths differ): ignored them and used text embeddings.`);
    emb = projectDocs(model, options.embeddingDim, options.seed);
  }

  // 4. similarity edges: each paper links back to similar *earlier* papers ------------------------------
  for (const s of similarityEdges(model.docs, model.terms.length, options.similarityK, options.minSimilarity)) {
    if (cited.has(pairKey(s.source, s.target))) continue; // the citation already says it
    edges.push({
      source: s.source,
      target: s.target,
      type: 'similarity',
      weight: r3(s.weight),
      t: Math.max(recs[s.source].t, recs[s.target].t),
    });
  }

  // 5. clusters -------------------------------------------------------------------------------------
  const categories = recs.map((r) => r.p.category?.trim() ?? '');
  let labels: Int32Array;
  let clusterCount: number;
  let categoryNames: string[] | undefined;
  let clusterMethod: 'category' | 'kmeans';
  if (categories.every(Boolean)) {
    const names = [...new Set(categories)];
    const rel = relabelBySize(Int32Array.from(categories, (c) => names.indexOf(c)));
    labels = rel.labels;
    clusterCount = rel.count;
    categoryNames = rel.order.map((old) => names[old]);
    clusterMethod = 'category';
  } else {
    const k = options.clusters === 'auto' ? autoK(n) : Math.round(options.clusters);
    const res = sphericalKMeans(emb, k, options.seed);
    labels = res.labels;
    clusterCount = res.count;
    clusterMethod = 'kmeans';
  }

  // 6. 3D layout ------------------------------------------------------------------------------------
  const layout = layout3d(emb, { method: options.layout, seed: options.seed, radius: options.radius });
  if (layout.warning) warnings.push(layout.warning);
  const pos = layout.positions;

  // 7. assemble -------------------------------------------------------------------------------------
  const labelInfo = labelClusters(model, labels, clusterCount);
  const members: number[][] = Array.from({ length: clusterCount }, () => []);
  labels.forEach((c, i) => members[c].push(i));
  const clusters: ClusterInfo[] = members.map((idxs, c) => {
    const cen: Vec3 = [0, 0, 0];
    for (const i of idxs) for (let a = 0; a < 3; a++) cen[a] += pos[i][a] / idxs.length;
    const dists = idxs.map((i) => Math.hypot(pos[i][0] - cen[0], pos[i][1] - cen[1], pos[i][2] - cen[2])).sort((a, b) => a - b);
    const p90 = dists[Math.min(dists.length - 1, Math.floor(0.9 * dists.length))] ?? 0;
    return {
      id: c,
      label: categoryNames?.[c] ?? labelInfo[c].label,
      keywords: labelInfo[c].keywords,
      size: idxs.length,
      centroid: [r1(cen[0]), r1(cen[1]), r1(cen[2])],
      radius: r1(p90),
      firstT: recs[idxs[0]].t, // recs are time-ordered, so the lowest index is the earliest paper
    };
  });

  const counts = recs.map((r, i) => r.p.citationCount ?? indegree[i]);
  let maxCount = 0;
  for (const c of counts) if (c > maxCount) maxCount = c;
  const nodes: GraphNode[] = recs.map((r, i) => ({
    id: r.p.id,
    title: r.p.title.trim(),
    year: r.year,
    t: r.t,
    x: r1(pos[i][0]),
    y: r1(pos[i][1]),
    z: r1(pos[i][2]),
    cluster: labels[i],
    citations: counts[i],
    mag: maxCount > 0 ? r3(Math.log1p(counts[i]) / Math.log1p(maxCount)) : 0,
  }));

  // 7b. bridge-gap voids: clusters that read alike (similarity edges) but rarely cite each other.
  // Needs citation data to contrast against; without it no voids are reported (and a warning says so).
  const { regions: voidRegions } = detectBridgeVoids({
    labels,
    clusterCount,
    citationEdges: edges.filter((e) => e.type === 'citation'),
    similarityEdges: edges.filter((e) => e.type === 'similarity'),
    positions: pos,
    t: recs.map((r) => r.t),
    clusterLabels: clusters.map((c) => c.label),
  });

  // 7c. conflicts: claims on which papers take opposite stances (needs `findings` on the papers).
  const conflictRegions = detectConflicts({
    ids: nodes.map((nd) => nd.id),
    findings: recs.map((r) => r.p.findings),
    t: recs.map((r) => r.t),
    positions: pos,
  });
  const regions = [...voidRegions, ...conflictRegions];

  const details: DetailsFile = {};
  recs.forEach((r, i) => {
    const d: PaperDetails = {};
    if (r.p.abstract) d.abstract = r.p.abstract;
    if (r.p.authors?.length) d.authors = r.p.authors;
    if (r.p.venue) d.venue = r.p.venue;
    if (r.p.keywords?.length) d.keywords = r.p.keywords;
    if (r.p.doi) d.doi = r.p.doi;
    if (r.p.url) d.url = r.p.url;
    if (r.p.findings?.length) d.findings = r.p.findings;
    const refs = (r.p.references ?? []).map(resolve).filter((j): j is number => j !== undefined && j !== i);
    if (refs.length) d.references = [...new Set(refs)].map((j) => recs[j].p.id);
    details[nodes[i].id] = d;
  });

  // 8. report ---------------------------------------------------------------------------------------
  const dropped = input.length - stats.papersKept;
  if (dropped > 0) warnings.push(`${dropped} paper(s) skipped: missing title or unusable date.`);
  if (stats.duplicateIds > 0) warnings.push(`${stats.duplicateIds} duplicate id(s) were renamed with a "#2"-style suffix.`);
  if (stats.yearOnlyDates > 0) {
    warnings.push(`${stats.yearOnlyDates} paper(s) have year-only dates and were placed in January, so the time slider will show a January burst for them.`);
  }
  if (embeddingKind === 'tfidf-projection' && recs.filter((r) => r.p.abstract).length < n * 0.5) {
    warnings.push('Fewer than half the papers have an abstract: similarity and clustering rely on titles and keywords only.');
  }
  if (stats.referencesResolved === 0) {
    warnings.push('No citation links between papers in this collection were found: the graph uses similarity edges only, and no voids can be detected (they need citations to contrast against text similarity).');
  }
  if (stats.citationsToLaterPapers > 0) {
    warnings.push(`${stats.citationsToLaterPapers} citation(s) point to a paper dated later than the citing paper (preprint vs. publication dates?); each appears when the later of the two does.`);
  }

  const graph: GraphData = {
    meta: {
      schemaVersion: 1,
      nodeCount: n,
      edgeCounts: { citation: citationEdgeCount, similarity: edges.length - citationEdgeCount },
      timeline: { minT: recs[0].t, maxT: recs[n - 1].t },
      hasCitationData: stats.referencesResolved > 0,
      clusterMethod,
      layout: layout.method,
      embedding: embeddingKind,
      options,
      stats,
      warnings,
    },
    nodes,
    edges,
    clusters,
    regions,
  };
  return { graph, details };
}
