import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildGraph } from '../src/core/build/build.ts';
import { generateCollection } from '../src/core/generate.ts';
import { importCollection } from '../src/core/import/index.ts';
import { detectConflicts } from '../src/core/build/conflicts.ts';
import type { Finding, GraphData, PaperInput } from '../src/core/types.ts';
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
  assert.deepEqual(graph.regions.filter((r) => r.kind === 'void'), []);
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
    const found = new Set(graph.regions.filter((r) => r.kind === 'void').map((r) => key(dom[r.between![0]], dom[r.between![1]])));
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
  const voidsIn = (g: GraphData) => g.regions.filter((r) => r.kind === 'void').length;
  const none = voidsIn(synthetic(4, 800, 0).graph);
  const some = voidsIn(synthetic(4, 800, 3).graph);
  assert.ok(none <= some + 2, `no-void run reported ${none}, 3-void run reported ${some}`);
});

// ---------------------------------------------------------------------------------------- conflicts

test('importer reads findings, accepts stance synonyms, and skips malformed entries with a warning', () => {
  const r = importCollection(
    JSON.stringify([
      {
        id: 'a', title: 'A', date: '2020-01',
        findings: [
          { claim: 'X improves Y', stance: 'supports', quote: 'We confirm it.' },
          { claim: 'Z hurts W', stance: 'refutes' },
          { claim: 'no stance here' },
          { stance: 'for' },
        ],
      },
    ]),
  );
  assert.deepEqual(r.papers[0].findings, [
    { claim: 'X improves Y', stance: 'for', quote: 'We confirm it.' },
    { claim: 'Z hurts W', stance: 'against' },
  ]);
  assert.ok(r.warnings.some((w) => /2 finding\(s\) skipped/.test(w)));
});

test('detectConflicts: needs both sides, merges phrasing variants, ignores tiny claims, flags a lone dissenter', () => {
  const f = (claim: string, stance: Finding['stance']): Finding[] => [{ claim, stance }];
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const findings: (Finding[] | undefined)[] = [
    f('Dropout helps small models', 'for'),
    f('  dropout  helps small models. ', 'for'), // same claim, different case/spacing/period
    f('DROPOUT HELPS SMALL MODELS', 'against'),
    f('Unanimous claim', 'for'),
    f('Unanimous claim', 'for'),
    f('Unanimous claim', 'for'),
    f('Two paper claim', 'for'),
    f('Two paper claim', 'against'), // both sides but below minPapers
  ];
  const regions = detectConflicts({ ids, findings, t: [10, 20, 30, 5, 6, 7, 8, 9], positions: ids.map((_, i) => [i * 10, 0, 0] as [number, number, number]) });
  assert.equal(regions.length, 1);
  const r = regions[0];
  assert.deepEqual(r.sides, { for: ['a', 'b'], against: ['c'] });
  assert.equal(r.claim, 'Dropout helps small models');
  assert.equal(r.t0, 30, 'dispute exists once the second side has appeared (max of the two first-appearance months)');
  assert.match(r.evidence ?? '', /single dissenting paper/);
  assert.deepEqual(r.center, [10, 0, 0]);
  // a paper that states the same claim twice still counts once
  const dup = detectConflicts({ ids: ['a', 'b', 'c'], findings: [[...f('P', 'for'), ...f('p', 'for')], f('P', 'against'), f('P', 'against')], t: [1, 2, 3], positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] });
  assert.deepEqual(dup[0].sides, { for: ['a'], against: ['b', 'c'] });
});

test('graph build: planted disputes are found, unanimous look-alikes are not, and regions validate', () => {
  for (const seed of [1, 2, 3]) {
    const { graph, details, truth } = synthetic(seed, 600, 2);
    assert.deepEqual(validateGraph(graph), []);
    const found = graph.regions.filter((r) => r.kind === 'conflict');
    assert.deepEqual(new Set(found.map((r) => r.claim)), new Set(truth.conflicts.map((c) => c.claim)));
    for (const c of truth.consensus) assert.ok(!found.some((r) => r.claim === c.claim), 'a unanimous claim was reported as a conflict');
    for (const c of truth.conflicts) {
      const r = found.find((x) => x.claim === c.claim)!;
      assert.deepEqual([...r.sides!.for].sort(), [...c.forIds].sort());
      assert.deepEqual([...r.sides!.against].sort(), [...c.againstIds].sort());
      const tOf = (id: string) => graph.nodes.find((n) => n.id === id)!.t;
      assert.equal(r.t0, Math.max(Math.min(...c.forIds.map(tOf)), Math.min(...c.againstIds.map(tOf))));
    }
    const someId = found[0].sides!.for[0];
    assert.ok(details[someId].findings?.some((x) => x.claim === found[0].claim), 'findings reach details.json');
  }
});

test('with no findings there are no conflicts; planting does not disturb the rest of the generated data', () => {
  const plain = generateCollection({ seed: 9, papers: 200, conflicts: 0, consensus: 0 });
  assert.ok(plain.papers.every((p) => !p.findings));
  assert.equal(buildGraph(plain.papers, { seed: 9 }).graph.regions.filter((r) => r.kind === 'conflict').length, 0);
  const planted = generateCollection({ seed: 9, papers: 200 });
  planted.papers.forEach((p, i) => {
    const q = plain.papers[i];
    assert.equal(p.id, q.id); assert.equal(p.title, q.title); assert.equal(p.date, q.date);
    assert.deepEqual(p.references, q.references);
    assert.ok((p.abstract ?? '').startsWith(q.abstract ?? ''), 'only appends to abstracts');
  });
});
