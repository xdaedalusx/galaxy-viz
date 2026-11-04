import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildGraph } from '../src/core/build/build.ts';
import { generateCollection } from '../src/core/generate.ts';
import { importCollection } from '../src/core/import/index.ts';
import type { GraphData, PaperInput } from '../src/core/types.ts';
import { validateGraph } from '../src/core/validate.ts';

const example = (name: string) => readFileSync(new URL(`../data/examples/${name}`, import.meta.url), 'utf8');

test('imports the BibTeX example', () => {
  const r = importCollection(example('sample.bib'), 'sample.bib');
  assert.equal(r.format, 'bibtex');
  assert.equal(r.papers.length, 7);
  const p = r.papers[0];
  assert.equal(p.id, 'okafor2019sparse');
  assert.equal(p.title, 'Sparse Attention for Long Document Retrieval'); // braces stripped
  assert.equal(p.date.slice(0, 4), '2019');
  assert.deepEqual(p.authors?.slice(0, 2), ['Ada Okafor', 'Sven Lindqvist']);
});

test('imports the Zotero-style CSV example', () => {
  const r = importCollection(example('sample.csv'), 'sample.csv');
  assert.equal(r.format, 'csv');
  assert.equal(r.papers.length, 7);
  assert.ok(r.papers.every((p) => p.title && p.date));
  assert.ok(r.papers[0].doi?.startsWith('10.'));
});

test('imports JSON and sniffs the format without a filename', () => {
  const text = JSON.stringify([
    { id: 'a', title: 'First', date: '2020-05' },
    { id: 'b', title: 'Second', year: 2021, references: ['a'] },
  ]);
  const r = importCollection(text);
  assert.equal(r.format, 'json');
  assert.equal(r.papers.length, 2);
  assert.deepEqual(r.papers[1].references, ['a']);
});

test('refuses a collection with fewer than 3 usable papers', () => {
  const papers: PaperInput[] = [
    { id: '1', title: 'One', date: '2020-01' },
    { id: '2', title: '', date: '2020-02' },
    { id: '3', title: 'No date', date: 'soon' },
  ];
  assert.throws(() => buildGraph(papers), /at least 3 papers/);
});

test('builds the BibTeX example end to end and passes validation', () => {
  const r = importCollection(example('sample.bib'), 'sample.bib');
  const { graph, details } = buildGraph(r.papers, { clusters: 2 });
  assert.deepEqual(validateGraph(graph), []);
  assert.equal(Object.keys(details).length, graph.nodes.length);
});

const synthetic = (seed: number, papers: number, voids: number) => {
  const { papers: ps, truth } = generateCollection({ seed, papers, voids });
  return { ps, truth, ...buildGraph(ps, { seed }) };
};

test('generator is deterministic and its ground truth stays out of the papers', () => {
  const a = generateCollection({ seed: 7, papers: 120 });
  const b = generateCollection({ seed: 7, papers: 120 });
  assert.deepEqual(a.papers, b.papers);
  assert.notDeepEqual(a.papers, generateCollection({ seed: 8, papers: 120 }).papers);
  assert.ok(!JSON.stringify(a.papers).includes('bridgeVoids'));
});

test('graph build is deterministic', () => {
  const { ps } = synthetic(3, 150, 2);
  assert.deepEqual(buildGraph(ps, { seed: 3 }).graph, buildGraph(ps, { seed: 3 }).graph);
});

test('time view invariants: edges appear with their later endpoint, nodes sorted, citations point backwards', () => {
  const { graph } = synthetic(5, 300, 2);
  assert.deepEqual(validateGraph(graph), []);
  assert.equal(graph.meta.stats.citationsToLaterPapers, 0);
  for (const e of graph.edges) {
    // source is the newer paper by construction, so a link can never exist before both ends do
    assert.ok(graph.nodes[e.source].t >= graph.nodes[e.target].t, `edge ${e.type} points forward in time`);
    assert.equal(e.t, graph.nodes[e.source].t);
  }
});

test('year-only dates are flagged', () => {
  const papers: PaperInput[] = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: `Paper ${i} on topic ${i % 2 ? 'alpha' : 'beta'}`, date: `${2015 + i}` }));
  const { graph } = buildGraph(papers, { clusters: 2 });
  assert.equal(graph.meta.stats.yearOnlyDates, 6);
  assert.ok(graph.meta.warnings.some((w) => /year-only/.test(w)));
});

test('no citation data: no voids are invented, and the warning says why', () => {
  const { ps } = synthetic(2, 300, 3);
  const stripped = ps.map(({ references: _refs, ...rest }) => rest);
  const { graph } = buildGraph(stripped, { seed: 2 });
  assert.deepEqual(graph.regions, []);
  assert.ok(graph.meta.warnings.some((w) => /no voids can be detected/.test(w)));
});

/** Map each cluster to the planted topic most of its papers belong to. */
function dominantTopics(graph: GraphData, paperTopics: Record<string, number[]>): number[] {
  const votes = graph.clusters.map(() => new Map<number, number>());
  for (const nd of graph.nodes) {
    const t = paperTopics[nd.id][0];
    votes[nd.cluster].set(t, (votes[nd.cluster].get(t) ?? 0) + 1);
  }
  return votes.map((m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

test('void detection recovers planted bridge gaps well above chance (800 papers, 3 planted, 6 seeds)', () => {
  const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  let reported = 0;
  let correct = 0;
  let planted = 0;
  let recovered = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { graph, truth } = synthetic(seed, 800, 3);
    assert.deepEqual(validateGraph(graph), []);
    const dom = dominantTopics(graph, truth.paperTopics);
    const truthSet = new Set(truth.bridgeVoids.map((v) => key(v.a, v.b)));
    const found = new Set(graph.regions.map((r) => key(dom[r.between![0]], dom[r.between![1]])));
    reported += found.size;
    correct += [...found].filter((f) => truthSet.has(f)).length;
    planted += truthSet.size;
    recovered += [...truthSet].filter((t) => found.has(t)).length;
  }
  // Chance level: 3 planted pairs among ~90 cluster pairs, i.e. ~3% precision. Measured: ~0.7 / ~0.6.
  assert.ok(correct / reported >= 0.5, `precision ${(correct / reported).toFixed(2)} (${correct}/${reported})`);
  assert.ok(recovered / planted >= 0.4, `recall ${(recovered / planted).toFixed(2)} (${recovered}/${planted})`);
});

test('a collection with no planted voids reports far fewer than one with several', () => {
  const none = synthetic(4, 800, 0).graph.regions.length;
  const some = synthetic(4, 800, 3).graph.regions.length;
  assert.ok(none <= some + 2, `no-void run reported ${none}, 3-void run reported ${some}`);
});
