import { parseBibtex } from './bibtex.ts';
import { parseCsv } from './csv.ts';
import { parseJson } from './json.ts';
import { capWarnings, type ImportResult } from './normalize.ts';

export type ImportFormat = 'json' | 'csv' | 'bibtex';

function sniff(text: string): ImportFormat {
  const head = text.replace(/^﻿/, '').trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  if (/^@\w+\s*[{(]/m.test(head)) return 'bibtex';
  return 'csv';
}

function fromFilename(name: string): ImportFormat | undefined {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'bib' || ext === 'bibtex') return 'bibtex';
  return undefined;
}

/**
 * Parse the text of a user's paper collection. Pure (no file access), so it runs the same in
 * Node and in the browser: read the file there, pass the text here.
 */
export function importCollection(text: string, filename?: string, format?: ImportFormat): ImportResult & { format: ImportFormat } {
  const fmt = format ?? (filename ? fromFilename(filename) : undefined) ?? sniff(text);
  const result = fmt === 'json' ? parseJson(text) : fmt === 'bibtex' ? parseBibtex(text) : parseCsv(text);
  return { ...result, warnings: capWarnings(result.warnings), format: fmt };
}

export { parseBibtex, parseCsv, parseJson };
export type { ImportResult };
