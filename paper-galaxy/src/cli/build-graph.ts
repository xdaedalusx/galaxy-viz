import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildGraph } from '../core/build/build.ts';
import { importCollection } from '../core/import/index.ts';
import type { BuildOptions } from '../core/types.ts';
import { kb, num, summarizeGraph, writeJson } from './io.ts';

const HELP = `Build the graph files from a paper collection.

Usage: node src/cli/build-graph.ts --in <file.json|.csv|.bib> [options]

  -i, --in <file>        paper collection (JSON / JSON Lines, CSV e.g. a Zotero export, or BibTeX)
  -o, --out <dir>        output directory (default: public/data)
      --seed <n>         seed for clustering and layout (default: 42)
      --k <n>            similar earlier papers each paper links back to (default: 4)
      --min-sim <x>      minimum cosine similarity for a similarity edge (default: 0.1)
      --clusters <n|auto>  number of clusters (default: auto)
      --layout <force|pca> 3D layout method (default: force)
      --radius <x>       layout radius in scene units (default: 300)
      --pretty           indent the JSON output
  -h, --help
`;

try {
  const { values } = parseArgs({
    options: {
      in: { type: 'string', short: 'i' },
      out: { type: 'string', short: 'o', default: 'public/data' },
      seed: { type: 'string' },
      k: { type: 'string' },
      'min-sim': { type: 'string' },
      clusters: { type: 'string' },
      layout: { type: 'string' },
      radius: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || !values.in) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const imported = importCollection(readFileSync(values.in, 'utf8'), values.in);
  console.log(`Read ${imported.papers.length} papers from ${values.in} (${imported.format})`);
  for (const w of imported.warnings) console.warn(`  import: ${w}`);

  const overrides: Partial<BuildOptions> = {};
  const seed = num(values.seed, 'seed');
  if (seed !== undefined) overrides.seed = seed;
  const k = num(values.k, 'k');
  if (k !== undefined) overrides.similarityK = k;
  const minSim = num(values['min-sim'], 'min-sim');
  if (minSim !== undefined) overrides.minSimilarity = minSim;
  const radius = num(values.radius, 'radius');
  if (radius !== undefined) overrides.radius = radius;
  if (values.clusters !== undefined) overrides.clusters = values.clusters === 'auto' ? 'auto' : (num(values.clusters, 'clusters') as number);
  if (values.layout !== undefined) {
    if (values.layout !== 'force' && values.layout !== 'pca') throw new Error('--layout must be "force" or "pca"');
    overrides.layout = values.layout;
  }

  const started = Date.now();
  const { graph, details } = buildGraph(imported.papers, overrides);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const graphPath = join(values.out, 'graph.json');
  const detailsPath = join(values.out, 'details.json');
  const graphBytes = writeJson(graphPath, graph, values.pretty);
  const detailsBytes = writeJson(detailsPath, details, values.pretty);

  console.log('\n' + summarizeGraph(graph));
  console.log(`\nBuilt in ${seconds}s. Wrote ${graphPath} (${kb(graphBytes)}) and ${detailsPath} (${kb(detailsBytes)})`);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
