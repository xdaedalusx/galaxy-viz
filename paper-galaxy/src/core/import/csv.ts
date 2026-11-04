import { normalizeRecords, type ImportResult } from './normalize.ts';

function detectDelimiter(text: string): string {
  const nl = text.search(/\r?\n/);
  const header = nl < 0 ? text : text.slice(0, nl);
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const count = header.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180 style parser: quoted fields, doubled quotes, embedded newlines. */
export function parseCsvRows(input: string, delimiter?: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export function parseCsv(text: string): ImportResult {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, j) => {
      if (h && r[j] !== undefined) rec[h] = r[j];
    });
    return rec;
  });
  return normalizeRecords(records, 'csv');
}
