import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_GENERATE_OPTIONS, generateCollection, type GenerateOptions } from '../core/generate.ts';
import { kb, num, summarizeTruth, writeJson } from './io.ts';

const HELP = `Generate a synthetic paper collection with planted structure.

Usage: node src/cli/generate.ts [options]

  -o, --out <dir>   output directory (default: data/synthetic)
      --papers <n>  number of papers (default: ${DEFAULT_GENERATE_OPTIONS.papers})
      --topics <n>  number of research topics (default: ${DEFAULT_GENERATE_OPTIONS.topics})
      --seed <n>    random seed (default: ${DEFAULT_GENERATE_OPTIONS.seed})
      --start <y>   first year (default: ${DEFAULT_GENERATE_OPTIONS.startYear})
      --end <y>     last year (default: ${DEFAULT_GENERATE_OPTIONS.endYear})
      --voids <n>   adjacent topic pairs left deliberately unbridged (default: ${DEFAULT_GENERATE_OPTIONS.voids})
      --dormant <n> topics that go silent before the end (default: ${DEFAULT_GENERATE_OPTIONS.dormant})
      --orphans <n> topics mentioned often but rarely studied (default: ${DEFAULT_GENERATE_OPTIONS.orphans})
      --refs <n>    average references per paper (default: ${DEFAULT_GENERATE_OPTIONS.avgReferences})
      --pretty      indent the JSON output
  -h, --help

Writes papers.json (the collection; feed it to build-graph) and truth.json (what was planted).
`;

try {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', short: 'o', default: 'data/synthetic' },
      papers: { type: 'string' },
      topics: { type: 'string' },
      seed: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      voids: { type: 'string' },
      dormant: { type: 'string' },
      orphans: { type: 'string' },
      refs: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const overrides: Partial<GenerateOptions> = {};
  const map: [keyof GenerateOptions, string | undefined, string][] = [
    ['papers', values.papers, 'papers'],
    ['topics', values.topics, 'topics'],
    ['seed', values.seed, 'seed'],
    ['startYear', values.start, 'start'],
    ['endYear', values.end, 'end'],
    ['voids', values.voids, 'voids'],
    ['dormant', values.dormant, 'dormant'],
    ['orphans', values.orphans, 'orphans'],
    ['avgReferences', values.refs, 'refs'],
  ];
  for (const [key, raw, flag] of map) {
    const v = num(raw, flag);
    if (v !== undefined) overrides[key] = v;
  }

  const { papers, truth } = generateCollection(overrides);
  const papersPath = join(values.out, 'papers.json');
  const truthPath = join(values.out, 'truth.json');
  const pBytes = writeJson(papersPath, papers, values.pretty);
  const tBytes = writeJson(truthPath, truth, values.pretty);
  console.log(`Generated ${papers.length} papers`);
  console.log(summarizeTruth(truth));
  console.log(`\nWrote ${papersPath} (${kb(pBytes)}) and ${truthPath} (${kb(tBytes)})`);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
