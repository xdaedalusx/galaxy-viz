import { normalizeRecords, type ImportResult } from './normalize.ts';

const ARRAY_KEYS = ['papers', 'data', 'items', 'results', 'records', 'works'];

/** Accepts a JSON array, an object wrapping one (`{ papers: [...] }`), or JSON Lines. */
export function parseJson(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const rows: unknown[] = [];
    const bad: number[] = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        rows.push(JSON.parse(line));
      } catch {
        bad.push(i + 1);
      }
    });
    if (rows.length === 0) throw new Error('Input is neither valid JSON nor JSON Lines');
    const result = normalizeRecords(rows, 'jsonl');
    if (bad.length) result.warnings.push(`jsonl: ${bad.length} unparseable line(s) skipped (first: line ${bad[0]})`);
    return result;
  }

  if (Array.isArray(data)) return normalizeRecords(data, 'json');
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ARRAY_KEYS) {
      if (Array.isArray(o[k])) return normalizeRecords(o[k] as unknown[], 'json');
    }
  }
  throw new Error(`Could not find an array of papers in the JSON (looked for a top-level array or one of: ${ARRAY_KEYS.join(', ')})`);
}
