import { Cell, cellText, toNum } from './model';

export type ColType = 'number' | 'date' | 'boolean' | 'text' | 'empty';

const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

export function inferType(values: Cell[]): ColType {
  let n = 0,
    num = 0,
    date = 0,
    bool = 0;
  for (let i = 0; i < values.length && n < 500; i++) {
    const v = values[i];
    if (v === null || (typeof v === 'string' && v.trim() === '')) continue;
    n++;
    if (typeof v === 'boolean' || /^(true|false|yes|no)$/i.test(String(v))) bool++;
    else if (toNum(v) !== null) num++;
    else if (typeof v === 'string' && DATE_RE.test(v.trim())) date++;
  }
  if (!n) return 'empty';
  if (num / n >= 0.9) return 'number';
  if (date / n >= 0.9) return 'date';
  if (bool / n >= 0.9) return 'boolean';
  return 'text';
}

export interface Profile {
  type: ColType;
  count: number;
  empty: number;
  unique: number;
  top: Array<[string, number]>;
  sum?: number;
  mean?: number;
  median?: number;
  min?: number | string;
  max?: number | string;
  std?: number;
  p25?: number;
  p75?: number;
  histogram?: Array<{ lo: number; hi: number; n: number }>;
  minLen?: number;
  maxLen?: number;
}

export function profile(values: Cell[]): Profile {
  const type = inferType(values);
  const freq = new Map<string, number>();
  let empty = 0;
  const nums: number[] = [];
  let minLen = Infinity,
    maxLen = 0;
  let minS: string | undefined, maxS: string | undefined;
  for (const v of values) {
    const s = cellText(v);
    if (s.trim() === '') {
      empty++;
      continue;
    }
    freq.set(s, (freq.get(s) || 0) + 1);
    if (type === 'number') {
      const n = toNum(v);
      if (n !== null) nums.push(n);
    } else {
      minLen = Math.min(minLen, s.length);
      maxLen = Math.max(maxLen, s.length);
      if (minS === undefined || s < minS) minS = s;
      if (maxS === undefined || s > maxS) maxS = s;
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const p: Profile = { type, count: values.length, empty, unique: freq.size, top };
  if (type === 'number' && nums.length) {
    nums.sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    const mean = sum / nums.length;
    const q = (f: number) => {
      const pos = (nums.length - 1) * f;
      const lo = Math.floor(pos);
      return nums[lo] + (nums[Math.min(lo + 1, nums.length - 1)] - nums[lo]) * (pos - lo);
    };
    Object.assign(p, {
      sum,
      mean,
      median: q(0.5),
      p25: q(0.25),
      p75: q(0.75),
      min: nums[0],
      max: nums[nums.length - 1],
      std: Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length),
      histogram: histogram(nums),
    });
  } else {
    Object.assign(p, { min: minS, max: maxS, minLen: minLen === Infinity ? 0 : minLen, maxLen });
  }
  return p;
}

function histogram(sorted: number[], bins = 20) {
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  if (lo === hi) return [{ lo, hi, n: sorted.length }];
  const k = Math.min(bins, Math.max(5, Math.ceil(Math.sqrt(sorted.length))));
  const w = (hi - lo) / k;
  const out = Array.from({ length: k }, (_, i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, n: 0 }));
  for (const v of sorted) out[Math.min(k - 1, Math.floor((v - lo) / w))].n++;
  return out;
}

export type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'distinct' | 'first';

export function aggregate(values: Cell[], agg: Agg): number | string | null {
  if (agg === 'count') return values.filter((v) => v !== null && cellText(v) !== '').length;
  if (agg === 'distinct') return new Set(values.map(cellText).filter(Boolean)).size;
  if (agg === 'first') return values.length ? cellText(values[0]) : null;
  const nums = values.map(toNum).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  switch (agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    case 'median': {
      nums.sort((a, b) => a - b);
      const m = nums.length >> 1;
      return nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2;
    }
  }
}

export function groupBy(rows: Cell[][], keyCols: number[], valueCol: number, aggs: Agg[]) {
  const groups = new Map<string, { key: Cell[]; vals: Cell[] }>();
  for (const r of rows) {
    const key = keyCols.map((c) => r[c] ?? null);
    const k = JSON.stringify(key.map(cellText));
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key, vals: [] }));
    g.vals.push(valueCol >= 0 ? r[valueCol] ?? null : 1);
  }
  return [...groups.values()].map((g) => [...g.key, ...aggs.map((a) => aggregate(g.vals, a))] as Cell[]);
}

export function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6 || (Math.abs(n) < 1e-3 && n !== 0)) return n.toExponential(3);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
