import type { TableView } from './TableView';
import type { Chart } from 'chart.js';
import { h, icon, btn, toast, debounce, dialog } from '../dom';
import { profile, fmtNum, groupBy, Agg } from '../stats';
import { compile, FUNCTION_NAMES } from '../expr';
import { Cell, cellText, setCell, toNum, uniqueHeader, parseInput } from '../model';
import { buildData, renderChart, ChartKind, ChartSpec } from '../chart';
import { host } from '../host';

export type DrawerTab = 'stats' | 'chart' | 'transform';

export class Drawer {
  el: HTMLElement;
  tab: DrawerTab | null = null;
  private body: HTMLElement;
  private chart: Chart | null = null;
  private chartSpec: ChartSpec | null = null;
  private section: string | null = null;
  private sectionCol: number | null = null;
  private width = 380;

  constructor(private tv: TableView) {
    this.body = h('div', { class: 'drawer-body' });
    const tabs = (['stats', 'chart', 'transform'] as DrawerTab[]).map((t) =>
      h('button', { class: 'dtab', 'data-tab': t, onclick: () => this.open(t) }, icon(t === 'stats' ? 'stats' : t === 'chart' ? 'chart' : 'wand', 14), t === 'stats' ? 'Profile' : t === 'chart' ? 'Chart' : 'Transform'),
    );
    const handle = h('div', { class: 'drawer-resize', onmousedown: (e: MouseEvent) => this.startResize(e) });
    this.el = h(
      'aside',
      { class: 'drawer', style: { display: 'none' } },
      handle,
      h('div', { class: 'drawer-head' }, ...tabs, h('div', { class: 'spacer' }), btn(null, 'close', () => this.close(), { title: 'Close panel' })),
      this.body,
    );
  }

  private startResize(e: MouseEvent) {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = this.width;
    const move = (ev: MouseEvent) => {
      this.width = Math.max(260, Math.min(window.innerWidth - 240, w0 + x0 - ev.clientX));
      this.el.style.width = this.width + 'px';
      this.chart?.resize();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  toggle(tab: DrawerTab) {
    if (this.tab === tab) this.close();
    else this.open(tab);
  }

  open(tab: DrawerTab, section?: string, col?: number) {
    if (tab === 'transform' && this.tv.readonly) tab = 'stats';
    this.tab = tab;
    this.section = section ?? null;
    this.sectionCol = col ?? null;
    this.el.style.display = '';
    this.el.style.width = this.width + 'px';
    this.el.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab));
    this.tv.el.querySelectorAll('.drawer-btn').forEach((b) => b.classList.toggle('active', b.classList.contains(`drawer-btn-${tab}`)));
    this.render();
  }

  close() {
    this.tab = null;
    this.el.style.display = 'none';
    this.chart?.destroy();
    this.chart = null;
    this.tv.el.querySelectorAll('.drawer-btn').forEach((b) => b.classList.remove('active'));
    this.tv.focusGrid();
  }

  refresh = debounce(() => {
    if (!this.tab) return;
    if (this.tab === 'transform') return; // keep user's half-typed inputs
    this.render();
  }, 150);

  onSelection = debounce(() => {
    if (this.tab === 'stats') this.render();
  }, 120);

  private render() {
    this.chart?.destroy();
    this.chart = null;
    if (this.tab === 'stats') this.renderStats();
    else if (this.tab === 'chart') this.renderChartTab();
    else if (this.tab === 'transform') this.renderTransform();
  }

  /* ================================================================ profile */

  private renderStats() {
    const tv = this.tv;
    const s = tv.sheet;
    const c = tv.focusCol;
    const rows = tv.viewRows();
    const values = rows.map((r) => r[c] ?? null);
    const p = profile(values);
    const pct = (n: number) => (p.count ? ` (${((n / p.count) * 100).toFixed(1)}%)` : '');
    const metric = (label: string, value: string, title?: string) => h('div', { class: 'metric', title: title || '' }, h('div', { class: 'm-label' }, label), h('div', { class: 'm-value' }, value));

    const metrics =
      p.type === 'number'
        ? [
            metric('Mean', fmtNum(p.mean)),
            metric('Median', fmtNum(p.median)),
            metric('Sum', fmtNum(p.sum)),
            metric('Min', fmtNum(p.min as number)),
            metric('Max', fmtNum(p.max as number)),
            metric('Std dev', fmtNum(p.std)),
            metric('P25', fmtNum(p.p25)),
            metric('P75', fmtNum(p.p75)),
          ]
        : [metric('Min', cellText((p.min as string) ?? '—').slice(0, 20) || '—'), metric('Max', cellText((p.max as string) ?? '—').slice(0, 20) || '—'), metric('Shortest', `${p.minLen ?? 0} ch`), metric('Longest', `${p.maxLen ?? 0} ch`)];

    const hist = p.histogram
      ? h(
          'div',
          { class: 'section' },
          h('div', { class: 'sec-title' }, 'Distribution', h('small', null, ' — click a bar to filter')),
          h(
            'div',
            { class: 'hist' },
            ...p.histogram.map((b) => {
              const max = Math.max(...p.histogram!.map((x) => x.n));
              return h(
                'div',
                {
                  class: 'hbar',
                  title: `${fmtNum(b.lo)} – ${fmtNum(b.hi)}: ${b.n.toLocaleString()} rows`,
                  onclick: () => tv.setFilter(c, `${+b.lo.toPrecision(6)}..${+b.hi.toPrecision(6)}`),
                },
                h('div', { class: 'hfill', style: { height: `${Math.max(2, (b.n / max) * 100)}%` } }),
              );
            }),
          ),
          h('div', { class: 'hist-axis' }, h('span', null, fmtNum(p.min as number)), h('span', null, fmtNum(p.max as number))),
        )
      : null;

    const topMax = p.top[0]?.[1] || 1;
    const top = h(
      'div',
      { class: 'section' },
      h('div', { class: 'sec-title' }, p.unique > 10 ? 'Top 10 values' : 'Values', h('small', null, ' — click to filter')),
      ...p.top.map(([v, n]) =>
        h(
          'div',
          { class: 'topv', title: `${v}\n${n.toLocaleString()} rows — click to filter`, onclick: () => tv.setFilter(c, '=' + v) },
          h('div', { class: 'topv-bar', style: { width: `${(n / topMax) * 100}%` } }),
          h('span', { class: 'topv-label' }, v.length > 40 ? v.slice(0, 40) + '…' : v),
          h('span', { class: 'topv-n' }, n.toLocaleString()),
        ),
      ),
      p.top.length ? null : h('div', { class: 'muted' }, 'No values'),
    );

    // All-column overview
    const overview = h(
      'div',
      { class: 'section' },
      h('div', { class: 'sec-title' }, `All columns (${s.headers.length})`),
      h(
        'div',
        { class: 'overview' },
        ...tv.cols.map((ci, vc) => {
          const vals = rows.length > 5000 ? rows.slice(0, 5000).map((r) => r[ci] ?? null) : rows.map((r) => r[ci] ?? null);
          const empty = vals.filter((v) => v === null || cellText(v) === '').length;
          const fill = vals.length ? 1 - empty / vals.length : 0;
          return h(
            'div',
            { class: `ov-row ${ci === c ? 'active' : ''}`, onclick: () => tv.setFocus(tv.focus.r, vc), title: `${s.headers[ci]} — ${(fill * 100).toFixed(0)}% filled` },
            h('span', { class: `type t-${tv.types[ci]}` }),
            h('span', { class: 'ov-name' }, s.headers[ci]),
            h('span', { class: 'ov-fill' }, h('span', { style: { width: `${fill * 100}%` } })),
            h('span', { class: 'ov-pct' }, `${(fill * 100).toFixed(0)}%`),
          );
        }),
      ),
    );

    this.body.replaceChildren(
      ...([h(
        'div',
        { class: 'col-head' },
        h('div', { class: 'col-title' }, h('span', { class: `type t-${p.type}` }), s.headers[c]),
        h('div', { class: 'col-sub' }, `${p.type} · ${p.count.toLocaleString()} rows${rows.length !== s.rows.length ? ' (filtered)' : ''}`),
      ),
      h(
        'div',
        { class: 'metrics' },
        metric('Filled', (p.count - p.empty).toLocaleString() + pct(p.count - p.empty)),
        metric('Empty', p.empty.toLocaleString() + pct(p.empty), 'Click to filter empty cells'),
        metric('Unique', p.unique.toLocaleString()),
        metric('Duplicates', Math.max(0, p.count - p.empty - p.unique).toLocaleString()),
        ...metrics,
      ),
      hist,
      top,
      h('div', { class: 'row-btns' }, btn('Chart it', 'chart', () => this.chartColumn(c)), p.empty ? btn('Show empty', 'filter', () => tv.setFilter(c, 'empty')) : null),
      overview] as Array<HTMLElement | null>).filter(Boolean) as HTMLElement[],
    );
    (this.body.querySelectorAll('.metric')[1] as HTMLElement).onclick = () => tv.setFilter(c, 'empty');
  }

  /* ================================================================ chart */

  chartColumn(c: number) {
    const t = this.tv.types[c];
    this.chartSpec =
      t === 'number' ? { kind: 'histogram', x: c, ys: [], agg: 'count', sort: 'x', limit: 50 } : { kind: 'bar', x: c, ys: [], agg: 'count', sort: 'value', limit: 25 };
    this.open('chart');
  }

  private defaultSpec(): ChartSpec {
    const tv = this.tv;
    const rows = tv.sheet.rows.slice(0, 2000);
    const uniq = (c: number) => new Set(rows.map((r) => cellText(r[c] ?? null))).size;
    const idLike = (c: number) => /(^|[\s_.-])(id|key|no|number|code|zip)$/i.test(tv.sheet.headers[c]) || uniq(c) === rows.length;
    const dates = tv.cols.filter((c) => tv.types[c] === 'date');
    // Best grouping column: low-cardinality text (e.g. region, plan, status).
    const cats = tv.cols
      .filter((c) => tv.types[c] === 'text' || tv.types[c] === 'boolean')
      .map((c) => ({ c, u: uniq(c), text: tv.types[c] === 'text' }))
      .filter((x) => x.u >= 2 && x.u <= 30)
      .sort((a, b) => Number(b.text) - Number(a.text) || a.u - b.u);
    const nums = tv.cols.filter((c) => tv.types[c] === 'number' && !idLike(c));
    const x = cats[0]?.c ?? dates[0] ?? tv.cols[0];
    const isDate = tv.types[x] === 'date';
    return { kind: isDate ? 'line' : 'bar', x, ys: nums.length ? [nums[0]] : [], agg: nums.length ? 'sum' : 'count', sort: isDate ? 'x' : 'value', limit: 25 };
  }

  private renderChartTab() {
    const tv = this.tv;
    const s = tv.sheet;
    const spec = (this.chartSpec = this.chartSpec && this.chartSpec.x < s.headers.length ? this.chartSpec : this.defaultSpec());
    spec.ys = spec.ys.filter((y) => y < s.headers.length);
    const colOpts = (sel: number, filter?: (c: number) => boolean) =>
      s.headers.map((name, c) => (filter && !filter(c) ? null : h('option', { value: c, selected: c === sel }, name))).filter(Boolean) as HTMLOptionElement[];

    const kinds: Array<[ChartKind, string]> = [
      ['bar', 'Bar'],
      ['hbar', 'Bar ↔'],
      ['line', 'Line'],
      ['area', 'Area'],
      ['scatter', 'Scatter'],
      ['pie', 'Donut'],
      ['histogram', 'Histogram'],
    ];
    const kindRow = h(
      'div',
      { class: 'seg' },
      ...kinds.map(([k, label]) =>
        h('button', { class: `seg-btn ${spec.kind === k ? 'active' : ''}`, onclick: () => ((spec.kind = k), k === 'scatter' && spec.agg !== 'none' && (spec.agg = 'none'), this.renderChartTab()) }, label),
      ),
    );

    const xSel = h('select', { onchange: () => ((spec.x = +xSel.value), this.renderChartTab()) }, ...colOpts(spec.x, spec.kind === 'scatter' || spec.kind === 'histogram' ? (c) => tv.types[c] === 'number' : undefined));
    const aggSel = h(
      'select',
      { onchange: () => ((spec.agg = aggSel.value as any), this.renderChartTab()) },
      ...(['count', 'sum', 'avg', 'min', 'max', 'median', 'distinct', 'none'] as const).map((a) => h('option', { value: a, selected: spec.agg === a }, a === 'none' ? 'none (raw rows)' : a)),
    );
    const sortSel = h(
      'select',
      { onchange: () => ((spec.sort = sortSel.value as any), this.renderChartTab()) },
      h('option', { value: 'value', selected: spec.sort === 'value' }, 'by value ↓'),
      h('option', { value: 'x', selected: spec.sort === 'x' }, 'by label'),
      h('option', { value: 'none', selected: spec.sort === 'none' }, 'original order'),
    );
    const limitInp = h('input', { type: 'number', min: 1, max: 5000, value: spec.limit, onchange: () => ((spec.limit = Math.max(1, +limitInp.value || 25)), this.renderChartTab()) });

    const numericCols = s.headers.map((_, c) => c).filter((c) => tv.types[c] === 'number' && c !== spec.x);
    const ys = h(
      'div',
      { class: 'chips' },
      ...numericCols.map((c) => {
        const on = spec.ys.includes(c);
        return h(
          'button',
          {
            class: `chip ${on ? 'on' : ''}`,
            onclick: () => {
              spec.ys = on ? spec.ys.filter((y) => y !== c) : [...spec.ys, c];
              if (spec.ys.length && spec.agg === 'count') spec.agg = 'sum';
              this.renderChartTab();
            },
          },
          s.headers[c],
        );
      }),
      numericCols.length ? null : h('span', { class: 'muted' }, 'No numeric columns — counting rows'),
    );

    const needsY = spec.kind !== 'histogram';
    const canvas = h('canvas', { role: 'img', 'aria-label': 'Chart of the current data' });
    const note = h('div', { class: 'chart-note' });
    const field = (label: string, el: HTMLElement) => h('label', { class: 'field' }, h('span', null, label), el);

    this.body.replaceChildren(
      ...([kindRow,
      h(
        'div',
        { class: 'chart-form' },
        field(spec.kind === 'histogram' ? 'Column' : spec.kind === 'scatter' ? 'X (numeric)' : 'X / group by', xSel),
        spec.kind !== 'histogram' && spec.kind !== 'scatter' ? field('Aggregate', aggSel) : null,
        spec.kind !== 'histogram' && spec.kind !== 'scatter' && spec.agg !== 'none' ? field('Sort', sortSel) : null,
        spec.kind !== 'histogram' && spec.kind !== 'scatter' ? field(spec.agg === 'none' ? 'Max rows' : 'Max groups', limitInp) : null,
      ),
      needsY ? h('div', { class: 'field' }, h('span', null, spec.kind === 'pie' ? 'Value (first selected)' : 'Y series'), ys) : null,
      h('div', { class: 'chart-box' }, canvas),
      note,
      h(
        'div',
        { class: 'row-btns' },
        btn('Save PNG', 'export', () => this.exportPng(canvas)),
        btn('Copy data', 'copy', () => {
          const d = buildData(spec, s.headers, tv.viewRows());
          const lines = [[s.headers[spec.x], ...d.series.map((x) => x.name)].join('\t'), ...d.labels.map((l, i) => [l, ...d.series.map((x) => cellText((x.data[i] as number) ?? null))].join('\t'))];
          host.copy(lines.join('\n'));
          toast('Chart data copied as TSV', 'ok');
        }),
      ),
      h('div', { class: 'muted small' }, `Uses the ${tv.viewIdx.length.toLocaleString()} visible rows — filters & search apply.`)] as Array<HTMLElement | null>).filter(Boolean) as HTMLElement[],
    );

    requestAnimationFrame(() => {
      try {
        const data = buildData(spec, s.headers, tv.viewRows());
        note.textContent = data.note || '';
        if (!data.series.length || (!data.labels.length && spec.kind !== 'scatter')) {
          note.textContent = data.note || 'Nothing to chart for this selection.';
          return;
        }
        this.chart = renderChart(canvas, spec, data, this.chart);
      } catch (e) {
        note.textContent = 'Chart error: ' + (e as Error).message;
      }
    });
  }

  private exportPng(canvas: HTMLCanvasElement) {
    // Paint an opaque background so the PNG reads outside the editor theme.
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    const b64 = out.toDataURL('image/png').split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    host.post({ type: 'export', fileName: 'chart.png', data: bytes });
  }

  /* ================================================================ transform */

  transformColumn(c: number, op: 'trim' | 'upper' | 'lower' | 'title' | 'number' | 'text' | 'filldown') {
    const tv = this.tv;
    const labels = { trim: 'Trim', upper: 'Upper case', lower: 'Lower case', title: 'Title case', number: 'Convert to number', text: 'Convert to text', filldown: 'Fill empty down' };
    let changed = 0;
    tv.doc.mutate(`${labels[op]} “${tv.sheet.headers[c]}”`, (s) => {
      let last: Cell = null;
      s.rows.forEach((r, i) => {
        const v = r[c] ?? null;
        let nv: Cell = v;
        if (op === 'filldown') {
          if (v === null || cellText(v) === '') nv = last;
          else last = v;
        } else if (v !== null) {
          const t = cellText(v);
          if (op === 'trim') nv = typeof v === 'string' ? t.trim().replace(/\s+/g, ' ') : v;
          else if (op === 'upper') nv = t.toUpperCase();
          else if (op === 'lower') nv = t.toLowerCase();
          else if (op === 'title') nv = t.toLowerCase().replace(/(^|[\s\-_'])\p{L}/gu, (m) => m.toUpperCase());
          else if (op === 'number') nv = toNum(v) ?? v;
          else if (op === 'text') nv = t;
        }
        if (nv !== v) {
          setCell(s, i, c, nv);
          changed++;
        }
      });
    });
    toast(`${labels[op]}: ${changed.toLocaleString()} cells changed`, 'ok');
  }

  async splitColumn(c: number) {
    const tv = this.tv;
    const r = await dialog(`Split “${tv.sheet.headers[c]}”`, [
      { key: 'd', label: 'Delimiter', value: ',', hint: 'Use \\t for tab, or /regex/' },
      { key: 'max', label: 'Max parts', value: '0', hint: '0 = as many as found' },
      { key: 'keep', label: 'Keep original column', type: 'checkbox', value: true },
    ], 'Split');
    if (!r) return;
    const delim = r.d === '\\t' ? '\t' : r.d;
    const re = /^\/(.+)\/$/.exec(delim);
    const splitter = re ? new RegExp(re[1]) : delim;
    const parts = tv.sheet.rows.map((row) => cellText(row[c] ?? null).split(splitter as any).map((x) => x.trim()));
    let n = Math.max(1, ...parts.map((p) => p.length));
    if (+r.max > 0) n = Math.min(n, +r.max);
    tv.doc.mutate('Split column', (s) => {
      const names: string[] = [];
      for (let i = 0; i < n; i++) names.push(uniqueHeader([...s.headers, ...names], `${s.headers[c]} ${i + 1}`));
      s.headers.splice(c + 1, 0, ...names);
      s.rows = s.rows.map((row, ri) => {
        const p = parts[ri];
        const vals: Cell[] = [];
        for (let i = 0; i < n; i++) vals.push(i === n - 1 && p.length > n ? p.slice(i).join(typeof delim === 'string' && !re ? delim : ' ') : p[i] ?? null);
        const nr = row.slice();
        nr.splice(c + 1, 0, ...vals.map((v) => (v === '' ? null : v)));
        return nr;
      });
      if (!r.keep) {
        s.headers.splice(c, 1);
        s.rows = s.rows.map((row) => row.filter((_, i) => i !== c));
      }
    });
    tv.autosize();
    tv.refresh();
  }

  private renderTransform() {
    const tv = this.tv;
    const s = tv.sheet;
    const sec = (id: string, title: string, ...children: Array<HTMLElement | null>) => {
      const d = h('details', { class: 'tsec', open: this.section ? this.section === id : id === 'formula' }, h('summary', null, title), h('div', { class: 'tsec-body' }, ...children));
      return d;
    };
    const colSelect = (sel = tv.focusCol, withAll = false) =>
      h('select', null, withAll ? h('option', { value: -1 }, 'All columns') : null, ...s.headers.map((n, c) => h('option', { value: c, selected: c === sel }, n)));

    /* ---------- computed column */
    const fName = h('input', { type: 'text', placeholder: 'New column name', value: '' });
    const fExpr = h('textarea', { rows: 3, spellcheck: false, placeholder: 'e.g.  [Unit Price] * qty   ·   upper(name)   ·   if(score >= 50, "pass", "fail")' });
    const preview = h('div', { class: 'preview' });
    const targetSel = h('select', null, h('option', { value: 'new' }, 'Add as new column'), ...s.headers.map((n, c) => h('option', { value: c }, `Overwrite “${n}”`)));
    const updatePreview = debounce(() => {
      if (!fExpr.value.trim()) {
        preview.replaceChildren();
        return;
      }
      try {
        const fn = compile(fExpr.value, s.headers);
        const rows = tv.viewRows().slice(0, 5);
        preview.className = 'preview ok';
        preview.replaceChildren(...rows.map((r, i) => h('div', null, h('span', { class: 'muted' }, `${tv.viewIdx[i] + 1}: `), cellText(fn(r, tv.viewIdx[i])) || '∅')));
      } catch (e) {
        preview.className = 'preview err';
        preview.textContent = (e as Error).message;
      }
    }, 150);
    fExpr.addEventListener('input', updatePreview);
    const insertAtCursor = (t: string) => {
      const p = fExpr.selectionStart ?? fExpr.value.length;
      fExpr.value = fExpr.value.slice(0, p) + t + fExpr.value.slice(fExpr.selectionEnd ?? p);
      fExpr.focus();
      fExpr.setSelectionRange(p + t.length, p + t.length);
      updatePreview();
    };
    const colChips = h('div', { class: 'chips small' }, ...s.headers.map((n) => h('button', { class: 'chip', title: 'Insert column reference', onclick: () => insertAtCursor(/^[A-Za-z_]\w*$/.test(n) ? n : `[${n}]`) }, n)));
    const fnChips = h('div', { class: 'chips small' }, ...FUNCTION_NAMES.map((f) => h('button', { class: 'chip fn', onclick: () => insertAtCursor(f + '(') }, f + '()')));
    const applyFormula = () => {
      try {
        const fn = compile(fExpr.value, s.headers);
        const target = targetSel.value;
        const all = s.rows.map((r, i) => fn(r, i));
        if (target === 'new') {
          const name = fName.value.trim() || 'Computed';
          tv.insertColumn(Math.max(...tv.cols) + 1, name, all);
        } else {
          const c = +target;
          tv.doc.mutate(`Formula → “${s.headers[c]}”`, (sh) => all.forEach((v, i) => setCell(sh, i, c, v)));
        }
        toast('Formula applied to ' + s.rows.length.toLocaleString() + ' rows', 'ok');
        tv.autosize();
        tv.refresh();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    };

    /* ---------- advanced filter */
    const filterExpr = h('input', { type: 'text', spellcheck: false, placeholder: 'e.g.  amount > 100 and contains(city, "lag")', value: tv.formulaFilterSrc });
    const filterErr = h('div', { class: 'preview' });
    const applyFilter = () => {
      try {
        tv.setFormulaFilter(filterExpr.value);
        filterErr.className = 'preview ok';
        filterErr.textContent = filterExpr.value.trim() ? `${tv.viewIdx.length.toLocaleString()} rows match` : '';
      } catch (e) {
        filterErr.className = 'preview err';
        filterErr.textContent = (e as Error).message;
      }
    };
    filterExpr.addEventListener('keydown', (e) => e.key === 'Enter' && applyFilter());

    /* ---------- find & replace */
    const findI = h('input', { type: 'text', placeholder: 'Find', spellcheck: false });
    const replI = h('input', { type: 'text', placeholder: 'Replace with', spellcheck: false });
    const frCol = colSelect(this.section === 'replace' && this.sectionCol !== null ? this.sectionCol : tv.focusCol, true);
    if (this.section !== 'replace') frCol.value = '-1';
    const cbCase = h('input', { type: 'checkbox' });
    const cbRe = h('input', { type: 'checkbox' });
    const cbWhole = h('input', { type: 'checkbox' });
    const cbVisible = h('input', { type: 'checkbox', checked: true });
    const frInfo = h('div', { class: 'preview' });
    const matcher = () => {
      if (!findI.value) return null;
      const src = cbRe.checked ? findI.value : findI.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(cbWhole.checked ? `^(?:${src})$` : src, cbCase.checked ? 'g' : 'gi');
    };
    const targets = () => {
      const cols = +frCol.value < 0 ? s.headers.map((_, i) => i) : [+frCol.value];
      const rows = cbVisible.checked ? tv.viewIdx : s.rows.map((_, i) => i);
      return { cols, rows };
    };
    const countMatches = debounce(() => {
      let re: RegExp | null;
      try {
        re = matcher();
      } catch (e) {
        frInfo.className = 'preview err';
        frInfo.textContent = (e as Error).message;
        return;
      }
      if (!re) return (frInfo.textContent = '');
      const { cols, rows } = targets();
      let n = 0;
      for (const r of rows) for (const c of cols) if (re.test(cellText(s.rows[r][c] ?? null))) (n++, (re.lastIndex = 0));
      frInfo.className = 'preview ok';
      frInfo.textContent = `${n.toLocaleString()} matching cells`;
    }, 150);
    [findI, cbCase, cbRe, cbWhole, cbVisible, frCol].forEach((el) => el.addEventListener('input', countMatches));
    const doReplace = () => {
      let re: RegExp | null;
      try {
        re = matcher();
      } catch (e) {
        return toast((e as Error).message, 'error');
      }
      if (!re) return;
      const { cols, rows } = targets();
      let n = 0;
      const typed = !!tv.opts.typedInput;
      tv.doc.mutate('Find & replace', (sh) => {
        for (const r of rows)
          for (const c of cols) {
            const v = sh.rows[r][c] ?? null;
            const t = cellText(v);
            re!.lastIndex = 0;
            if (!re!.test(t)) continue;
            re!.lastIndex = 0;
            const nt = t.replace(re!, replI.value);
            setCell(sh, r, c, typeof v === 'number' || typed ? parseInput(nt, true) : nt === '' ? null : nt);
            n++;
          }
      });
      toast(`Replaced in ${n.toLocaleString()} cells`, 'ok');
      countMatches();
    };

    /* ---------- clean up */
    const dedupeCol = colSelect(tv.focusCol, true);
    dedupeCol.value = '-1';
    const cleanup = h(
      'div',
      { class: 'btn-grid' },
      btn('Trim all cells', null, () => this.cleanAll('trim')),
      btn('Remove empty rows', null, () => this.cleanAll('emptyRows')),
      btn('Remove empty columns', null, () => this.cleanAll('emptyCols')),
      btn('Apply current sort', null, () => tv.applySort(), { title: 'Reorder the underlying data by the active sort' }),
      btn('Keep filtered rows only', null, () => tv.keepFiltered(), { title: 'Delete rows hidden by search / filters' }),
      btn('Transpose sheet', null, () => this.cleanAll('transpose')),
    );
    const dedupe = h('div', { class: 'inline' }, h('span', null, 'Duplicates by'), dedupeCol, btn('Remove', null, () => this.dedupe(+dedupeCol.value)));

    /* ---------- group by */
    const gKey = colSelect(this.defaultSpec().x);
    const gKey2 = h('select', null, h('option', { value: -1 }, '— none —'), ...s.headers.map((n, c) => h('option', { value: c }, n)));
    const gVal = h('select', null, h('option', { value: -1 }, '(rows)'), ...s.headers.map((n, c) => h('option', { value: c, selected: c === tv.cols.find((x) => tv.types[x] === 'number') }, n)));
    const aggs: Agg[] = ['count', 'sum', 'avg', 'min', 'max', 'median', 'distinct'];
    const aggBoxes = aggs.map((a) => {
      const cb = h('input', { type: 'checkbox', checked: a === 'count' || a === 'sum' });
      return { a, cb, el: h('label', { class: 'dlg-check' }, cb, a) };
    });
    const doGroup = () => {
      const keys = [+gKey.value, ...(+gKey2.value >= 0 ? [+gKey2.value] : [])];
      const val = +gVal.value;
      const chosen = aggBoxes.filter((x) => x.cb.checked).map((x) => x.a);
      if (!chosen.length) return toast('Pick at least one aggregation', 'error');
      const out = groupBy(tv.viewRows(), keys, val, chosen);
      const vname = val >= 0 ? s.headers[val] : 'rows';
      const headers = [...keys.map((k) => s.headers[k]), ...chosen.map((a) => (a === 'count' && val < 0 ? 'count' : `${a}(${vname})`))];
      out.sort((a, b) => (toNum(b[keys.length]) ?? 0) - (toNum(a[keys.length]) ?? 0));
      tv.addSheet({ name: uniqueHeader(tv.doc.sheets.map((x) => x.name), `by ${keys.map((k) => s.headers[k]).join(', ')}`).slice(0, 31), headers, rows: out, derived: true });
      toast(`${out.length.toLocaleString()} groups → new sheet`, 'ok');
    };

    this.body.replaceChildren(
      sec(
        'formula',
        'ƒ  Computed column',
        h('label', { class: 'field' }, h('span', null, 'Formula'), fExpr),
        preview,
        h('div', { class: 'muted small' }, 'Columns — click to insert'),
        colChips,
        h('details', { class: 'fn-ref' }, h('summary', null, 'Functions'), fnChips, h('div', { class: 'muted small' }, 'Operators: + - * / % ^  & (concat)  = != < > <= >=  and or not')),
        h('div', { class: 'inline' }, targetSel, fName),
        h('div', { class: 'row-btns' }, btn('Apply formula', 'wand', applyFormula, { primary: true })),
      ),
      sec(
        'filter',
        '⚲  Filter rows by formula',
        filterExpr,
        filterErr,
        h('div', { class: 'row-btns' }, btn('Apply filter', 'filter', applyFilter, { primary: true }), btn('Clear', null, () => ((filterExpr.value = ''), applyFilter()))),
      ),
      sec(
        'replace',
        '⇄  Find & replace',
        findI,
        replI,
        h('div', { class: 'inline' }, h('span', null, 'In'), frCol),
        h('div', { class: 'checks' }, h('label', { class: 'dlg-check' }, cbCase, 'Match case'), h('label', { class: 'dlg-check' }, cbWhole, 'Whole cell'), h('label', { class: 'dlg-check' }, cbRe, 'Regex'), h('label', { class: 'dlg-check' }, cbVisible, 'Visible rows only')),
        frInfo,
        h('div', { class: 'row-btns' }, btn('Replace all', null, doReplace, { primary: true })),
      ),
      sec('clean', '✦  Clean up', cleanup, dedupe),
      sec(
        'group',
        '▦  Group by / pivot',
        h('div', { class: 'inline' }, h('span', null, 'Group by'), gKey),
        h('div', { class: 'inline' }, h('span', null, 'then by'), gKey2),
        h('div', { class: 'inline' }, h('span', null, 'Value'), gVal),
        h('div', { class: 'checks' }, ...aggBoxes.map((x) => x.el)),
        h('div', { class: 'row-btns' }, btn('Create summary sheet', 'table', doGroup, { primary: true })),
        h('div', { class: 'muted small' }, 'Uses visible rows. Result opens as a new sheet you can chart or export.'),
      ),
    );
    if (this.section === 'replace') setTimeout(() => findI.focus());
    if (this.section === 'formula') setTimeout(() => fExpr.focus());
  }

  private cleanAll(op: 'trim' | 'emptyRows' | 'emptyCols' | 'transpose') {
    const tv = this.tv;
    const isEmpty = (v: Cell) => v === null || cellText(v).trim() === '';
    let msg = '';
    if (op === 'trim') {
      let n = 0;
      tv.doc.mutate('Trim all cells', (s) =>
        s.rows.forEach((r, i) =>
          r.forEach((v, c) => {
            if (typeof v === 'string' && v !== v.trim()) {
              setCell(s, i, c, v.trim() || null);
              n++;
            }
          }),
        ),
      );
      msg = `Trimmed ${n.toLocaleString()} cells`;
    } else if (op === 'emptyRows') {
      const before = tv.sheet.rows.length;
      tv.doc.mutate('Remove empty rows', (s) => (s.rows = s.rows.filter((r) => !r.every(isEmpty))));
      msg = `Removed ${(before - tv.sheet.rows.length).toLocaleString()} empty rows`;
    } else if (op === 'emptyCols') {
      const s0 = tv.sheet;
      const empty = s0.headers.map((_, c) => c).filter((c) => s0.rows.every((r) => isEmpty(r[c] ?? null)));
      if (!empty.length) return toast('No empty columns');
      tv.deleteColumns(empty);
      msg = `Removed ${empty.length} empty column(s)`;
    } else if (op === 'transpose') {
      tv.doc.mutate('Transpose', (s) => {
        const grid = [s.headers as Cell[], ...s.rows];
        const t: Cell[][] = s.headers.map((_, c) => grid.map((r) => r[c] ?? null));
        s.headers = t[0] ? [s.headers[0], ...s.rows.map((r, i) => cellText(r[0] ?? null) || `Row ${i + 1}`)] : [];
        s.headers = s.headers.map((hd, i, arr) => (arr.indexOf(hd) !== i ? `${hd} (${i})` : hd));
        s.rows = t.slice(1);
      });
      tv.autosize();
      tv.refresh();
      msg = 'Transposed';
    }
    toast(msg, 'ok');
  }

  private dedupe(col: number) {
    const tv = this.tv;
    const seen = new Set<string>();
    const before = tv.sheet.rows.length;
    tv.doc.mutate('Remove duplicates', (s) => {
      s.rows = s.rows.filter((r) => {
        const k = col < 0 ? JSON.stringify(r.map(cellText)) : cellText(r[col] ?? null).toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    });
    toast(`Removed ${(before - tv.sheet.rows.length).toLocaleString()} duplicate rows`, 'ok');
  }
}
