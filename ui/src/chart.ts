import { Chart, registerables, ChartConfiguration } from 'chart.js';
import { Cell, cellText, toNum } from './model';
import { aggregate, Agg, fmtNum } from './stats';

Chart.register(...registerables);

/** Validated categorical palette (fixed order, never cycled). Light / dark steps. */
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER = { light: '#a3a29c', dark: '#6b6a64' };

export function isDark() {
  const root = document.documentElement;
  if (root.dataset.theme) return root.dataset.theme === 'dark';
  if (document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light')) return false;
  if (document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')) return true;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export const palette = () => (isDark() ? DARK : LIGHT);

export type ChartKind = 'bar' | 'hbar' | 'line' | 'area' | 'scatter' | 'pie' | 'histogram';

export interface ChartSpec {
  kind: ChartKind;
  x: number; // column index
  ys: number[]; // column indices (empty → count)
  agg: Agg | 'none';
  sort: 'x' | 'value' | 'none';
  limit: number;
}

export interface ChartData {
  labels: string[];
  series: Array<{ name: string; data: Array<number | null> | Array<{ x: number; y: number }> }>;
  note?: string;
}

export function buildData(spec: ChartSpec, headers: string[], rows: Cell[][]): ChartData {
  const { kind, x } = spec;
  const ys = spec.ys.length ? spec.ys : [-1];
  if (kind === 'histogram') {
    const nums = rows.map((r) => toNum(r[x] ?? null)).filter((n): n is number => n !== null).sort((a, b) => a - b);
    if (!nums.length) return { labels: [], series: [], note: 'Column has no numeric values' };
    const lo = nums[0],
      hi = nums[nums.length - 1];
    const k = Math.min(40, Math.max(5, Math.ceil(Math.sqrt(nums.length))));
    const w = (hi - lo) / k || 1;
    const bins = new Array(k).fill(0);
    for (const n of nums) bins[Math.min(k - 1, Math.floor((n - lo) / w))]++;
    return { labels: bins.map((_, i) => `${fmtNum(lo + i * w)} – ${fmtNum(lo + (i + 1) * w)}`), series: [{ name: `${headers[x]} (count)`, data: bins }] };
  }
  if (kind === 'scatter') {
    const series = ys
      .filter((y) => y >= 0)
      .slice(0, 3)
      .map((y) => ({
        name: headers[y],
        data: rows
          .map((r) => ({ x: toNum(r[x] ?? null)!, y: toNum(r[y] ?? null)! }))
          .filter((p) => p.x !== null && p.y !== null)
          .slice(0, 20000),
      }));
    return { labels: [], series, note: spec.ys.length > 3 ? 'Scatter shows the first 3 series for legibility' : undefined };
  }

  let labels: string[];
  let series: ChartData['series'];
  if (spec.agg === 'none') {
    const rs = rows.slice(0, spec.limit || 500);
    labels = rs.map((r) => cellText(r[x] ?? null));
    series = ys.map((y) => ({ name: y < 0 ? 'row' : headers[y], data: rs.map((r) => (y < 0 ? 1 : toNum(r[y] ?? null))) }));
  } else {
    const groups = new Map<string, Cell[][]>();
    for (const r of rows) {
      const k = cellText(r[x] ?? null) || '(empty)';
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(r);
    }
    let keys = [...groups.keys()];
    const val = (k: string, y: number) => {
      const g = groups.get(k)!;
      return y < 0 ? g.length : (aggregate(g.map((r) => r[y] ?? null), spec.agg as Agg) as number | null);
    };
    const nameFor = (y: number) => (y < 0 ? 'count' : `${spec.agg}(${headers[y]})`);
    if (spec.sort === 'value') keys.sort((a, b) => (val(b, ys[0]) ?? 0) - (val(a, ys[0]) ?? 0));
    else if (spec.sort === 'x') {
      const allNum = keys.every((k) => toNum(k) !== null || k === '(empty)');
      keys.sort((a, b) => (allNum ? (toNum(a) ?? Infinity) - (toNum(b) ?? Infinity) : a.localeCompare(b, undefined, { numeric: true })));
    }
    let note: string | undefined;
    const limit = kind === 'pie' ? Math.min(spec.limit || 8, 8) : spec.limit || 50;
    let other: string[] = [];
    if (keys.length > limit) {
      other = keys.slice(limit - (kind === 'pie' ? 1 : 0));
      keys = keys.slice(0, limit - (kind === 'pie' ? 1 : 0));
      note = kind === 'pie' ? `${other.length} smaller categories folded into “Other”` : `Showing ${limit} of ${keys.length + other.length} categories`;
    }
    labels = keys;
    series = ys.map((y) => ({ name: nameFor(y), data: keys.map((k) => val(k, y)) }));
    if (kind === 'pie' && other.length) {
      labels.push('Other');
      const y = ys[0];
      const otherRows = other.flatMap((k) => groups.get(k)!);
      (series[0].data as Array<number | null>).push((y < 0 ? otherRows.length : aggregate(otherRows.map((r) => r[y] ?? null), spec.agg as Agg)) as number);
    }
    return { labels, series, note };
  }
  return { labels, series };
}

export function renderChart(canvas: HTMLCanvasElement, spec: ChartSpec, data: ChartData, prev?: Chart | null): Chart {
  prev?.destroy();
  const css = getComputedStyle(document.body);
  const fg = css.getPropertyValue('--fg').trim() || '#ccc';
  const muted = css.getPropertyValue('--muted').trim() || '#888';
  const grid = css.getPropertyValue('--grid').trim() || 'rgba(128,128,128,.18)';
  const surface = css.getPropertyValue('--bg').trim() || '#1e1e1e';
  const pal = palette();
  const kind = spec.kind;
  const multi = data.series.length > 1;

  Chart.defaults.color = muted;
  Chart.defaults.font.family = css.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
  Chart.defaults.font.size = 11;

  const type = kind === 'hbar' || kind === 'histogram' ? 'bar' : kind === 'area' ? 'line' : kind === 'pie' ? 'doughnut' : kind;
  const datasets = data.series.map((s, i) => {
    const color = pal[i % pal.length];
    if (kind === 'pie') {
      const colors = data.labels.map((l, j) => (l === 'Other' ? (isDark() ? OTHER.dark : OTHER.light) : pal[j]));
      return { label: s.name, data: s.data, backgroundColor: colors, borderColor: surface, borderWidth: 2, hoverOffset: 6 };
    }
    if (kind === 'line' || kind === 'area')
      return {
        label: s.name,
        data: s.data,
        borderColor: color,
        backgroundColor: kind === 'area' ? color + '33' : color,
        fill: kind === 'area' ? (multi ? false : 'origin') : false,
        borderWidth: 2,
        pointRadius: s.data.length > 60 ? 0 : 3,
        pointHoverRadius: 5,
        tension: 0.25,
        spanGaps: true,
      };
    if (kind === 'scatter')
      return { label: s.name, data: s.data, backgroundColor: color + 'cc', borderColor: surface, borderWidth: 1, pointRadius: 4, pointHoverRadius: 6 };
    return {
      label: s.name,
      data: s.data,
      backgroundColor: color,
      hoverBackgroundColor: color + 'dd',
      borderRadius: 4,
      borderSkipped: 'start' as const,
      borderColor: surface,
      borderWidth: kind === 'histogram' ? { right: 1 } : 0,
      categoryPercentage: kind === 'histogram' ? 1 : 0.8,
      barPercentage: kind === 'histogram' ? 1 : 0.9,
      maxBarThickness: 48,
    };
  });

  const axis = (title?: string) => ({
    grid: { color: grid, drawTicks: false },
    border: { display: false },
    ticks: { color: muted, padding: 6, maxRotation: 45, autoSkip: true, callback(this: any, v: any) {
      const l = this.getLabelForValue ? this.getLabelForValue(v) : v;
      return typeof l === 'string' && l.length > 18 ? l.slice(0, 17) + '…' : typeof l === 'number' ? fmtNum(l) : l;
    } },
    title: title ? { display: true, text: title, color: muted } : undefined,
  });

  const cfg: ChartConfiguration = {
    type: type as any,
    data: { labels: kind === 'scatter' ? undefined : data.labels, datasets: datasets as any },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      indexAxis: kind === 'hbar' ? 'y' : 'x',
      interaction: kind === 'pie' ? { mode: 'nearest', intersect: true } : kind === 'scatter' ? { mode: 'nearest', intersect: false } : { mode: 'index', intersect: false },
      plugins: {
        legend: { display: multi || kind === 'pie', position: 'bottom', labels: { color: fg, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded' } },
        tooltip: {
          backgroundColor: css.getPropertyValue('--panel').trim() || '#252526',
          titleColor: fg,
          bodyColor: fg,
          borderColor: css.getPropertyValue('--border').trim() || '#444',
          borderWidth: 1,
          padding: 8,
          boxPadding: 4,
          callbacks: {
            label: (ctx: any) => {
              const v = ctx.raw;
              if (v && typeof v === 'object') return ` ${ctx.dataset.label}: (${fmtNum(v.x)}, ${fmtNum(v.y)})`;
              if (kind === 'pie') {
                const total = (ctx.dataset.data as number[]).reduce((a, b) => a + (b || 0), 0);
                return ` ${ctx.label}: ${fmtNum(v)} (${((v / total) * 100).toFixed(1)}%)`;
              }
              return ` ${ctx.dataset.label}: ${fmtNum(v)}`;
            },
          },
        },
      },
      scales:
        kind === 'pie'
          ? {}
          : kind === 'scatter'
            ? { x: { ...axis(), type: 'linear' }, y: axis() }
            : { x: { ...axis(), grid: { display: kind === 'hbar', color: grid } }, y: { ...axis(), beginAtZero: kind !== 'line', grid: { display: kind !== 'hbar', color: grid } } },
      ...(kind === 'pie' ? { cutout: '55%' } : {}),
    } as any,
  };
  return new Chart(canvas, cfg);
}
