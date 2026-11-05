import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SyntheticTruth } from '../core/generate.ts';
import type { GraphData } from '../core/types.ts';
import { monthLabel } from '../core/util/dates.ts';

export function writeJson(path: string, data: unknown, pretty = false): number {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(data, null, pretty ? 2 : undefined);
  writeFileSync(path, text);
  return Buffer.byteLength(text);
}

export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;

/** Parse a numeric CLI flag, failing loudly instead of silently producing NaN. */
export function num(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`--${name} must be a number (got "${value}")`);
  return v;
}

export function summarizeGraph(g: GraphData): string {
  const m = g.meta;
  const lines = [
    `Papers    ${m.nodeCount}   (${monthLabel(m.timeline.minT)} → ${monthLabel(m.timeline.maxT)})`,
    `Edges     ${m.edgeCounts.citation + m.edgeCounts.similarity}   (citation ${m.edgeCounts.citation} · similarity ${m.edgeCounts.similarity})`,
    `Clusters  ${g.clusters.length} via ${m.clusterMethod} · layout ${m.layout} · embedding ${m.embedding}`,
  ];
  for (const c of g.clusters) {
    lines.push(`  #${String(c.id).padEnd(2)} ${String(c.size).padStart(4)} papers  from ${monthLabel(c.firstT)}  ${c.label}`);
  }
  const voids = g.regions.filter((r) => r.kind === 'void');
  const conflicts = g.regions.filter((r) => r.kind === 'conflict');
  if (voids.length) {
    lines.push('Voids (clusters that read alike but rarely cite each other)');
    for (const r of voids) lines.push(`  ${r.id}  score ${r.score}  from ${monthLabel(r.t0)}  ${r.label}`);
  }
  if (conflicts.length) {
    lines.push('Conflicts (papers taking opposite stances on one claim)');
    for (const r of conflicts) lines.push(`  ${r.id}  score ${r.score}  from ${monthLabel(r.t0)}  ${r.sides!.for.length} for / ${r.sides!.against.length} against  ${r.claim}`);
  }
  if (m.warnings.length) {
    lines.push('Warnings');
    for (const w of m.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export function summarizeTruth(t: SyntheticTruth): string {
  const name = (id: number) => t.topics[id].name;
  const lines = [`Planted structure (${t.topics.length} topics, seed ${t.options.seed})`];
  for (const v of t.bridgeVoids) lines.push(`  void      ${name(v.a)} ⟷ ${name(v.b)}: related vocabulary, no bridge papers, no cross-citations`);
  for (const tp of t.topics) {
    if (tp.deathYear !== undefined) lines.push(`  dormant   ${tp.name}: active ${tp.birthYear}–${tp.deathYear}, silent afterwards`);
    if (tp.orphan) lines.push(`  orphan    ${tp.name}: mentioned as an open question in neighbouring papers, almost never studied`);
  }
  lines.push(`  bridged   ${t.bridged.length} adjacent topic pairs have hybrid papers and cross-citations`);
  for (const c of t.conflicts) lines.push(`  conflict  "${c.claim}" (${c.pattern}): ${c.forIds.length} for / ${c.againstIds.length} against`);
  for (const c of t.consensus) lines.push(`  consensus "${c.claim}": ${c.ids.length} papers, all agree (decoy)`);
  return lines.join('\n');
}
