import type { Finding, MonthIndex, Region, Vec3 } from '../types.ts';

/**
 * Conflict detection: claims on which papers in the collection take opposite stances.
 *
 * This is aggregation, not language understanding: it needs each paper's `findings` (claim + stance)
 * already extracted and phrased consistently. Getting those from full text is the hard, model-driven
 * step that lives upstream. Given them, a conflict is a claim with at least one paper on each side.
 */
export interface ConflictOptions {
  /** Report at most this many conflicts (highest score first). */
  maxConflicts: number;
  /** A claim needs at least this many papers in total (both sides) to be reported. */
  minPapers: number;
  /** Cap on the drawn radius, in layout units. */
  maxRadius: number;
}

export const DEFAULT_CONFLICT_OPTIONS: ConflictOptions = {
  maxConflicts: 6,
  minPapers: 3,
  maxRadius: 140,
};

export interface ConflictInput {
  ids: string[];
  /** Per node, in the same order as `ids`. */
  findings: (Finding[] | undefined)[];
  t: MonthIndex[];
  positions: Vec3[];
}

export const normalizeClaim = (c: string) => c.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');

const round1 = (x: number) => Math.round(x * 10) / 10;

export function detectConflicts(input: ConflictInput, overrides: Partial<ConflictOptions> = {}): Region[] {
  const o = { ...DEFAULT_CONFLICT_OPTIONS, ...overrides };
  const { ids, findings, t, positions } = input;

  interface Group {
    claim: string;
    forIdx: number[];
    againstIdx: number[];
  }
  const groups = new Map<string, Group>();
  findings.forEach((fs, i) => {
    if (!fs) return;
    const seen = new Set<string>(); // a paper counts once per claim
    for (const f of fs) {
      const key = normalizeClaim(f.claim);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { claim: f.claim.trim(), forIdx: [], againstIdx: [] }));
      (f.stance === 'for' ? g.forIdx : g.againstIdx).push(i);
    }
  });

  const found = [...groups.values()]
    .filter((g) => g.forIdx.length > 0 && g.againstIdx.length > 0 && g.forIdx.length + g.againstIdx.length >= o.minPapers)
    .map((g) => {
      const n = g.forIdx.length + g.againstIdx.length;
      const balance = (2 * Math.min(g.forIdx.length, g.againstIdx.length)) / n; // 1 = even split, ->0 = lone dissenter
      return { g, n, balance, score: balance * Math.log2(1 + n) };
    })
    .sort((a, b) => b.score - a.score || (a.g.claim < b.g.claim ? -1 : 1))
    .slice(0, o.maxConflicts);

  return found.map(({ g, n, balance, score }, rank) => {
    const all = [...g.forIdx, ...g.againstIdx];
    const c: Vec3 = [0, 0, 0];
    for (const i of all) for (let a = 0; a < 3; a++) c[a] += positions[i][a] / n;
    const dists = all.map((i) => Math.hypot(positions[i][0] - c[0], positions[i][1] - c[1], positions[i][2] - c[2])).sort((x, y) => x - y);
    const p90 = dists[Math.min(dists.length - 1, Math.floor(0.9 * dists.length))] ?? 0;
    const firstFor = Math.min(...g.forIdx.map((i) => t[i]));
    const firstAgainst = Math.min(...g.againstIdx.map((i) => t[i]));
    const lone = Math.min(g.forIdx.length, g.againstIdx.length);
    return {
      id: `conflict-${rank + 1}`,
      kind: 'conflict' as const,
      center: [round1(c[0]), round1(c[1]), round1(c[2])] as Vec3,
      radius: round1(Math.min(o.maxRadius, Math.max(40, p90 * 1.15))),
      // the dispute exists from the month both sides have been heard
      t0: Math.max(firstFor, firstAgainst),
      label: g.claim,
      score: Math.round(score * 1000) / 1000,
      claim: g.claim,
      sides: { for: g.forIdx.map((i) => ids[i]), against: g.againstIdx.map((i) => ids[i]) },
      evidence:
        `${g.forIdx.length} paper(s) support this claim and ${g.againstIdx.length} argue against it` +
        (lone === 1 ? ' (a single dissenting paper, so this may be an outlier rather than a live dispute)' : '') +
        `; split balance ${balance.toFixed(2)}.`,
    };
  });
}
