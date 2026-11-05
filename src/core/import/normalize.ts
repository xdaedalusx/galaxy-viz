import type { Finding, PaperInput } from '../types.ts';
import { parseDate, type ParsedDate } from '../util/dates.ts';
import { fnv1a } from '../util/rng.ts';

export interface ImportResult {
  papers: PaperInput[];
  warnings: string[];
}

/**
 * Accepted column / key names per canonical field, compared after lowercasing and stripping
 * non-alphanumerics. Covers plain JSON, Zotero CSV exports, Semantic Scholar and OpenAlex records.
 */
const FIELDS = {
  id: ['id', 'key', 'paperid', 'citationkey', 'citekey', 'bibtexkey', 'itemid'],
  title: ['title', 'papertitle', 'displayname'],
  abstract: ['abstract', 'abstractnote', 'summary'],
  authors: ['authors', 'author', 'authorships', 'creators'],
  date: ['date', 'publicationdate', 'publicationyear', 'year', 'published', 'pubdate', 'issued'],
  venue: ['venue', 'journal', 'publicationtitle', 'booktitle', 'source'],
  keywords: ['keywords', 'tags', 'manualtags', 'automatictags', 'fieldsofstudy'],
  category: ['category', 'topic', 'group'],
  references: ['references', 'refs', 'referencedworks', 'bibliography'],
  citationCount: ['citationcount', 'citedbycount', 'numcitations', 'timescited', 'citedby'],
  doi: ['doi'],
  url: ['url', 'link'],
  embedding: ['embedding'],
  findings: ['findings', 'claims'],
} as const;

const isEmpty = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s || undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

const STANCE_FOR = new Set(['for', 'support', 'supports', 'supported', 'confirms', 'confirmed', 'positive', 'agree', 'agrees', 'yes', '+', '1']);
const STANCE_AGAINST = new Set(['against', 'refute', 'refutes', 'refuted', 'contradicts', 'contradicted', 'negative', 'disagree', 'disagrees', 'no', '-', '-1']);

/** Parses `findings`: an array of { claim, stance, quote? }. Bad entries are skipped with a warning. */
function parseFindings(v: unknown, where: string, warnings: string[]): Finding[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Finding[] = [];
  let bad = 0;
  for (const f of v) {
    const o = obj(f);
    const claim = asString(o?.claim ?? o?.proposition);
    const st = String(o?.stance ?? o?.verdict ?? '').trim().toLowerCase();
    const stance = STANCE_FOR.has(st) ? 'for' : STANCE_AGAINST.has(st) ? 'against' : undefined;
    if (!claim || !stance) {
      bad++;
      continue;
    }
    const quote = asString(o?.quote);
    out.push(quote ? { claim, stance, quote } : { claim, stance });
  }
  if (bad) warnings.push(`${where}: ${bad} finding(s) skipped (need a claim and a stance of for/against)`);
  return out.length ? out : undefined;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function normalizeDoi(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
  return d || undefined;
}

function nameOf(v: unknown): string | undefined {
  const s = asString(v);
  if (s) return s;
  const o = obj(v);
  if (!o) return undefined;
  const direct = asString(o.name) ?? asString(o.display_name) ?? asString(obj(o.author)?.display_name);
  if (direct) return direct;
  const given = asString(o.given) ?? asString(o.firstName);
  const family = asString(o.family) ?? asString(o.lastName);
  return given || family ? [given, family].filter(Boolean).join(' ') : undefined;
}

function parseAuthors(v: unknown): string[] | undefined {
  let out: string[];
  if (Array.isArray(v)) {
    out = v.map(nameOf).filter((x): x is string => !!x);
  } else if (typeof v === 'string') {
    // "A; B" / "A and B" / "A|B" are unambiguous. A bare comma list is read as one author per comma
    // only when there are several commas ("A Smith, B Jones, C Lee"), since "Smith, Anna" is one name.
    const s = v.trim();
    let parts: string[];
    if (/[;|]/.test(s)) parts = s.split(/\s*[;|]\s*/);
    else if (/\s+and\s+/i.test(s)) parts = s.split(/\s+and\s+/i);
    else if ((s.match(/,/g) ?? []).length > 1) parts = s.split(/\s*,\s*/);
    else parts = [s];
    out = parts.map((x) => x.trim()).filter(Boolean);
  } else return undefined;
  return out.length ? out : undefined;
}

function parseStringList(v: unknown, splitter: RegExp, objectKeys: string[] = []): string[] | undefined {
  let out: string[];
  if (Array.isArray(v)) {
    out = v
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        const o = obj(item);
        if (!o) return undefined;
        for (const k of objectKeys) {
          const s = asString(o[k]);
          if (s) return s;
        }
        return undefined;
      })
      .filter((x): x is string => !!x);
  } else if (typeof v === 'string') {
    out = v.split(splitter).map((x) => x.trim());
  } else return undefined;
  out = out.filter(Boolean);
  return out.length ? out : undefined;
}

function doiFromExternalIds(v: unknown): string | undefined {
  const o = obj(v);
  return o ? asString(o.DOI) ?? asString(o.doi) : undefined;
}

const truncate = (s: string, n = 50) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function capWarnings(warnings: string[], max = 25): string[] {
  if (warnings.length <= max) return warnings;
  return [...warnings.slice(0, max), `…and ${warnings.length - max} more warnings`];
}

/** Turns loosely-keyed records (from JSON, CSV or BibTeX) into validated PaperInput objects. */
export function normalizeRecords(records: unknown[], source: string): ImportResult {
  const papers: PaperInput[] = [];
  const warnings: string[] = [];

  records.forEach((rec, i) => {
    const where = `${source} record ${i + 1}`;
    const raw = obj(rec);
    if (!raw) {
      warnings.push(`${where}: not an object, skipped`);
      return;
    }

    const norm = new Map<string, unknown>();
    for (const [k, v] of Object.entries(raw)) {
      const nk = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!norm.has(nk) || isEmpty(norm.get(nk))) norm.set(nk, v);
    }
    const first = (names: readonly string[]): unknown => {
      for (const n of names) {
        const v = norm.get(n);
        if (!isEmpty(v)) return v;
      }
      return undefined;
    };

    const title = asString(first(FIELDS.title));
    if (!title) {
      warnings.push(`${where}: missing title, skipped`);
      return;
    }

    // Several date columns can coexist (Zotero has "Publication Year" and "Date"); keep the most precise.
    let date: ParsedDate | null = null;
    for (const n of FIELDS.date) {
      const d = parseDate(norm.get(n));
      if (d && (!date || (d.precision === 'month' && date.precision === 'year'))) date = d;
    }
    if (!date) {
      warnings.push(`${where} ("${truncate(title)}"): no usable date, skipped`);
      return;
    }

    const doi = normalizeDoi(asString(first(FIELDS.doi)) ?? doiFromExternalIds(norm.get('externalids')));
    const id = asString(first(FIELDS.id)) ?? (doi ? `doi:${doi}` : `p-${fnv1a(title + date.iso).toString(36)}`);

    const paper: PaperInput = { id, title, date: date.iso };

    const abstract = asString(first(FIELDS.abstract));
    if (abstract) paper.abstract = abstract;

    const authors = parseAuthors(first(FIELDS.authors));
    if (authors) paper.authors = authors;

    const venue = asString(first(FIELDS.venue));
    if (venue) paper.venue = venue;

    const keywordSets = FIELDS.keywords
      .map((n) => parseStringList(norm.get(n), /[;|,]/))
      .filter((x): x is string[] => !!x);
    const keywords = [...new Set(keywordSets.flat())];
    if (keywords.length) paper.keywords = keywords;

    const category = asString(first(FIELDS.category));
    if (category) paper.category = category;

    const references = parseStringList(first(FIELDS.references), /[;|,\n]+/, ['paperId', 'id', 'doi']);
    if (references) paper.references = references;

    const cc = first(FIELDS.citationCount);
    const ccNum = typeof cc === 'number' ? cc : typeof cc === 'string' ? Number(cc) : NaN;
    if (Number.isFinite(ccNum) && ccNum >= 0) paper.citationCount = Math.round(ccNum);

    if (doi) paper.doi = doi;
    const url = asString(first(FIELDS.url));
    if (url) paper.url = url;

    const findings = parseFindings(first(FIELDS.findings), where, warnings);
    if (findings) paper.findings = findings;

    const emb = first(FIELDS.embedding);
    if (Array.isArray(emb) && emb.length > 0 && emb.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      paper.embedding = emb as number[];
    }

    papers.push(paper);
  });

  return { papers, warnings };
}
