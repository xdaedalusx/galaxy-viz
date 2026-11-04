import { monthFromName } from '../util/dates.ts';
import { normalizeRecords, type ImportResult } from './normalize.ts';

const COMBINING: Record<string, string> = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃' };

/** Best-effort LaTeX cleanup: accents, escaped symbols, braces. */
function cleanLatex(s: string): string {
  return s
    .replace(/\\([`'^"~])\s*\{?([A-Za-z])\}?/g, (_, mark: string, ch: string) => (ch + COMBINING[mark]).normalize('NFC'))
    .replace(/\\c\s*\{?([A-Za-z])\}?/g, (_, ch: string) => (ch + '̧').normalize('NFC'))
    .replace(/\\ss\b/g, 'ß')
    .replace(/\\([&%_#$])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `i` is just inside an entry's opening delimiter. Returns the index after its closing delimiter. */
function skipEntry(text: string, i: number, close: string): number {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0 && close === '}') return i + 1;
      depth--;
    } else if (c === ')' && depth === 0 && close === ')') return i + 1;
  }
  return i;
}

/** Reads one field value starting at `i`: {braced}, "quoted", bare token, joined by `#`. */
function readValue(text: string, start: number): [string, number] {
  let i = start;
  const parts: string[] = [];
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  for (;;) {
    skipWs();
    const c = text[i];
    if (c === '{') {
      let depth = 1;
      const from = ++i;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      parts.push(text.slice(from, i - 1));
    } else if (c === '"') {
      const from = ++i;
      let depth = 0;
      while (i < text.length && !(text[i] === '"' && depth === 0)) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      parts.push(text.slice(from, i));
      i++;
    } else {
      const m = /[^\s,#{}"()]+/y;
      m.lastIndex = i;
      const tok = m.exec(text);
      if (!tok) break;
      i = m.lastIndex;
      const month = monthFromName(tok[0]);
      parts.push(month && /^[a-z]+$/i.test(tok[0]) ? String(month) : tok[0]);
    }
    skipWs();
    if (text[i] === '#') i++;
    else break;
  }
  return [parts.join(''), i];
}

function bibAuthors(raw: string): string[] {
  return cleanLatex(raw)
    .split(/\s+and\s+/i)
    .map((a) => {
      const comma = a.indexOf(',');
      return comma > 0 ? `${a.slice(comma + 1).trim()} ${a.slice(0, comma).trim()}`.trim() : a.trim();
    })
    .filter(Boolean);
}

export function parseBibtex(text: string): ImportResult {
  const records: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;

    const head = /([A-Za-z]+)\s*([{(])/y;
    head.lastIndex = i;
    const hm = head.exec(text);
    if (!hm) continue;
    const type = hm[1].toLowerCase();
    const close = hm[2] === '{' ? '}' : ')';
    i = head.lastIndex;

    if (type === 'comment' || type === 'preamble' || type === 'string') {
      i = skipEntry(text, i, close);
      continue;
    }

    const keyRe = /\s*([^,\s{}]+)\s*,/y;
    keyRe.lastIndex = i;
    const km = keyRe.exec(text);
    if (!km) {
      warnings.push(`bibtex: @${type} entry without a citation key, skipped`);
      i = skipEntry(text, i, close);
      continue;
    }
    const key = km[1];
    i = keyRe.lastIndex;

    const fields: Record<string, string> = {};
    while (i < n) {
      while (i < n && /[\s,]/.test(text[i])) i++;
      if (i >= n) break;
      if (text[i] === close) {
        i++;
        break;
      }
      const nameRe = /([A-Za-z][\w:.-]*)\s*=\s*/y;
      nameRe.lastIndex = i;
      const nm = nameRe.exec(text);
      if (!nm) {
        warnings.push(`bibtex: malformed field in entry "${key}", rest of entry skipped`);
        i = skipEntry(text, i, close);
        break;
      }
      const [value, next] = readValue(text, nameRe.lastIndex);
      fields[nm[1].toLowerCase()] = value;
      i = next;
    }

    const rec: Record<string, unknown> = { id: key };
    if (fields.title) rec.title = cleanLatex(fields.title);
    if (fields.author) rec.authors = bibAuthors(fields.author);
    else if (fields.editor) rec.authors = bibAuthors(fields.editor);
    if (fields.abstract) rec.abstract = cleanLatex(fields.abstract);
    const venue = fields.journal ?? fields.booktitle ?? fields.publisher;
    if (venue) rec.venue = cleanLatex(venue);
    if (fields.doi) rec.doi = cleanLatex(fields.doi);
    if (fields.url) rec.url = fields.url.replace(/[{}\s]/g, '');
    if (fields.keywords) rec.keywords = cleanLatex(fields.keywords).split(/\s*[;,]\s*/).filter(Boolean);

    const year = fields.year ? cleanLatex(fields.year) : '';
    const month = fields.month ? monthFromName(cleanLatex(fields.month)) : null;
    if (fields.date) rec.date = cleanLatex(fields.date);
    else if (year) rec.date = month ? `${year}-${String(month).padStart(2, '0')}` : year;

    records.push(rec);
  }

  if (records.length === 0) throw new Error('No BibTeX entries found');
  const result = normalizeRecords(records, 'bibtex');
  result.warnings.unshift(...warnings);
  return result;
}
