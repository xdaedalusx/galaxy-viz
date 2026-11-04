import type { GraphData } from './types.ts';

/**
 * Structural checks on a graph file. Returns a list of problems (empty = valid). Useful in tests and
 * for a renderer that loads a graph.json it did not build itself.
 */
export function validateGraph(g: GraphData): string[] {
  const errs: string[] = [];
  const add = (msg: string) => {
    if (errs.length < 20) errs.push(msg);
  };
  const n = g.nodes.length;

  if (g.meta.schemaVersion !== 1) add(`unsupported schemaVersion ${String(g.meta.schemaVersion)}`);
  if (g.meta.nodeCount !== n) add(`meta.nodeCount ${g.meta.nodeCount} != nodes.length ${n}`);

  const ids = new Set<string>();
  g.nodes.forEach((nd, i) => {
    if (ids.has(nd.id)) add(`duplicate node id ${nd.id}`);
    ids.add(nd.id);
    if (i > 0 && nd.t < g.nodes[i - 1].t) add(`nodes not sorted by t at index ${i}`);
    if (![nd.x, nd.y, nd.z].every(Number.isFinite)) add(`node ${i}: non-finite position`);
    if (!Number.isInteger(nd.cluster) || nd.cluster < 0 || nd.cluster >= g.clusters.length) add(`node ${i}: cluster ${nd.cluster} out of range`);
    if (!(nd.mag >= 0 && nd.mag <= 1)) add(`node ${i}: mag ${nd.mag} outside [0,1]`);
    if (nd.t < g.meta.timeline.minT || nd.t > g.meta.timeline.maxT) add(`node ${i}: t outside meta.timeline`);
  });

  const seen = new Set<string>();
  const counts = { citation: 0, similarity: 0 };
  g.edges.forEach((e, i) => {
    if (!Number.isInteger(e.source) || !Number.isInteger(e.target) || e.source < 0 || e.target < 0 || e.source >= n || e.target >= n) {
      add(`edge ${i}: endpoint out of range`);
      return;
    }
    if (e.source === e.target) add(`edge ${i}: self-loop`);
    if (e.type !== 'citation' && e.type !== 'similarity') add(`edge ${i}: unknown type ${String(e.type)}`);
    else counts[e.type]++;
    if (!Number.isFinite(e.weight)) add(`edge ${i}: non-finite weight`);
    const expected = Math.max(g.nodes[e.source].t, g.nodes[e.target].t);
    if (e.t !== expected) add(`edge ${i}: t ${e.t} != max(endpoint t) ${expected}`);
    const key = `${e.type}|${e.source}|${e.target}`;
    if (seen.has(key)) add(`edge ${i}: duplicate ${e.type} edge`);
    seen.add(key);
  });
  if (counts.citation !== g.meta.edgeCounts.citation) add(`meta.edgeCounts.citation ${g.meta.edgeCounts.citation} != ${counts.citation}`);
  if (counts.similarity !== g.meta.edgeCounts.similarity) add(`meta.edgeCounts.similarity ${g.meta.edgeCounts.similarity} != ${counts.similarity}`);

  const sizeSum = g.clusters.reduce((s, c) => s + c.size, 0);
  if (sizeSum !== n) add(`cluster sizes sum to ${sizeSum}, expected ${n}`);

  const regionIds = new Set<string>();
  g.regions.forEach((r, i) => {
    if (regionIds.has(r.id)) add(`duplicate region id ${r.id}`);
    regionIds.add(r.id);
    if (!r.center.every(Number.isFinite) || !(r.radius > 0)) add(`region ${i}: bad center or radius`);
    if (r.t0 < g.meta.timeline.minT || r.t0 > g.meta.timeline.maxT) add(`region ${i}: t0 outside meta.timeline`);
    if (r.t1 !== undefined && r.t1 < r.t0) add(`region ${i}: t1 before t0`);
    if (r.between && (r.between[0] === r.between[1] || r.between.some((c) => c < 0 || c >= g.clusters.length))) add(`region ${i}: bad cluster pair`);
  });
  return errs;
}
