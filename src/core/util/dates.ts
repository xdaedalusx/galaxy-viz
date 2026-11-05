import type { MonthIndex } from '../types.ts';

export interface ParsedDate {
  year: number;
  month: number; // 1-12 (1 when the input had only a year)
  precision: 'year' | 'month';
  /** Canonical "YYYY" or "YYYY-MM". */
  iso: string;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function monthIndex(year: number, month: number): MonthIndex {
  return year * 12 + (month - 1);
}

export function fromMonthIndex(t: MonthIndex): { year: number; month: number } {
  return { year: Math.floor(t / 12), month: (t % 12) + 1 };
}

export function monthLabel(t: MonthIndex): string {
  const { year, month } = fromMonthIndex(t);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** "jan" / "January" / "1" / "01" -> 1..12, otherwise null. */
export function monthFromName(s: string): number | null {
  const v = s.trim().toLowerCase();
  if (/^\d{1,2}$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 12 ? n : null;
  }
  const i = MONTH_NAMES.indexOf(v.slice(0, 3));
  return i >= 0 && /^[a-z]+\.?$/.test(v) ? i + 1 : null;
}

function make(year: number, month: number, precision: 'year' | 'month'): ParsedDate {
  const iso = precision === 'year' ? String(year) : `${year}-${String(month).padStart(2, '0')}`;
  return { year, month, precision, iso };
}

const validYear = (y: number) => y >= 1600 && y <= 2100;

/** Accepts "2019", "2019-05", "2019-05-17", "2019/5", "May 2019", "17 May 2019", or a bare number. */
export function parseDate(input: unknown): ParsedDate | null {
  let s: string;
  if (typeof input === 'number' && Number.isFinite(input)) s = String(Math.trunc(input));
  else if (typeof input === 'string') s = input.trim();
  else return null;
  if (!s) return null;

  const iso = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?:[T\s].*)?$/.exec(s);
  if (iso) {
    const year = Number(iso[1]);
    if (!validYear(year)) return null;
    if (!iso[2]) return make(year, 1, 'year');
    const month = Number(iso[2]);
    if (month < 1 || month > 12) return null;
    return make(year, month, 'month');
  }

  const y = /\b(1[6-9]\d\d|20\d\d|2100)\b/.exec(s);
  if (!y) return null;
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(s);
  const month = m ? MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1 : 0;
  return month ? make(Number(y[1]), month, 'month') : make(Number(y[1]), 1, 'year');
}
