import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildGraph } from '../core/build/build.ts';
import { generateCollection, type GenerateOptions } from '../core/generate.ts';
import { kb, num, summarizeGraph, summarizeTruth, writeJson } from './io.ts';

const HELP = `One-shot demo: generate a synthetic collection, then build its graph.

Usage: node src/cli/demo.ts [--papers n] [--topics n] [--seed n] [--voids n] [--pretty]

Writes data/synthetic/{papers,truth}.json and public/data/{graph,details}.json.
`;

try {
  const { values } = parseArgs({
    options: {
      papers: { type: 'string' },
      topics: { type: 'string' },
      seed: { type: 'string' },
      voids: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const gen: Partial<GenerateOptions> = {};
  for (const [key, raw, flag] of [
    ['papers', values.papers, 'papers'],
    ['topics', values.topics, 'topics'],
    ['seed', values.seed, 'seed'],
    ['voids', values.voids, 'voids'],
  ] as const) {
    const v = num(raw, flag);
    if (v !== undefined) gen[key] = v;
  }

  const { papers, truth } = generateCollection(gen);
  writeJson(join('data/synthetic', 'papers.json'), papers, values.pretty);
  writeJson(join('data/synthetic', 'truth.json'), truth, values.pretty);
  console.log(`Generated ${papers.length} papers`);
  console.log(summarizeTruth(truth));

  const started = Date.now();
  const { graph, details } = buildGraph(papers, { seed: gen.seed ?? 42 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const gBytes = writeJson(join('public/data', 'graph.json'), graph, values.pretty);
  const dBytes = writeJson(join('public/data', 'details.json'), details, values.pretty);

  console.log('\n' + summarizeGraph(graph));
  console.log(`\nBuilt in ${seconds}s. Wrote public/data/graph.json (${kb(gBytes)}) and details.json (${kb(dBytes)})`);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
