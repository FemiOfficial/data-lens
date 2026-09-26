import { Cell, cellText, colName, parseInput, setCell, Sheet, TableDoc, toNum, uniqueHeader } from '../model';
import { compileFilter, compile } from '../expr';
import { inferType, ColType, fmtNum } from '../stats';
import { h, icon, btn, showMenu, MenuEntry, dialog, toast, debounce, escapeHtml, confirmDialog } from '../dom';
import { parseCsv, ExportFormat, toMarkdown, sheetToObjects } from '../io';
import { host } from '../host';
import { Drawer, DrawerTab } from './Drawer';

const RH = 26; // row height
const GUTTER_MIN = 44;
const OVERSCAN = 8;

export interface TableViewOptions {
  readonly?: boolean;
  /** Called after every user mutation (host marks document dirty). */
  onEdit?: (label: string) => void;
  onSave?: () => void;
  onExport?: (fmt: ExportFormat, rows: 'all' | 'view') => void;
  /** Extra toolbar content on the left (e.g. JSON view switcher). */
  toolbarPrefix?: HTMLElement;
  typedInput?: boolean;
  allowSheets?: boolean;
  title?: string;
}

interface Pos {
  r: number;
  c: number;
}
interface SortKey {
  c: number;
  dir: 1 | -1;
}
interface ViewState {
  sort: SortKey[];
  filters: string[];
  widths: number[];
  hidden: Set<number>;
  scrollTop: number;
  scrollLeft: number;
}

export class TableView {
  el: HTMLElement;
  /** visible data-row indices in display order */
  viewIdx: number[] = [];
  /** visible data-column indices in display order */
  cols: number[] = [];
  types: ColType[] = [];
  quick = '';
  showFilters = false;
  formulaFilterSrc = '';
  private formulaFilter: ((row: Cell[], i: number) => Cell) | null = null;
  anchor: Pos = { r: 0, c: 0 };
  focus: Pos = { r: 0, c: 0 };
  drawer: Drawer;

  private states = new Map<Sheet, ViewState>();
  private viewport!: HTMLDivElement;
  private headerRow!: HTMLDivElement;
  private filterRow!: HTMLDivElement;
  private canvas!: HTMLDivElement;
  private rowsEl!: HTMLDivElement;
  private status!: HTMLDivElement;
  private tabs!: HTMLDivElement;
  private searchInput!: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private editor: HTMLTextAreaElement | null = null;
  private editing: { r: number; c: number } | null = null;
  private dragging = false;
  private lastPress: { r: number; c: number; t: number } | null = null;
  private gutter = GUTTER_MIN;
  private collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  constructor(public doc: TableDoc, public opts: TableViewOptions = {}) {
    this.el = h('div', { class: 'tv' });
    this.drawer = new Drawer(this);
    this.build();
    doc.onChange((label) => {
      if (label) opts.onEdit?.(label);
      this.refresh();
    });
    this.autosize();
    this.refresh();
  }

  /* ============================================================ state */

  get sheet() {
    return this.doc.sheet;
  }

  get state(): ViewState {
    let s = this.states.get(this.sheet);
    if (!s) {
      // Undo snapshots create new Sheet objects; carry view state across by name.
      const prev = [...this.states.entries()].find(([k]) => k.name === this.sheet.name)?.[1];
      s = prev ? { ...prev } : { sort: [], filters: [], widths: [], hidden: new Set(), scrollTop: 0, scrollLeft: 0 };
      this.states.set(this.sheet, s);
    }
    return s;
  }

  get readonly() {
    return !!this.opts.readonly;
  }

  /** Recompute types, visible columns, filters and sort after any change. */
  refresh() {
    const s = this.sheet;
    const st = this.state;
    const ncol = s.headers.length;
    st.filters.length = ncol;
    this.types = s.headers.map((_, c) => inferType(sample(s.rows, c)));
    this.cols = s.headers.map((_, i) => i).filter((i) => !st.hidden.has(i));
    if (!this.cols.length && ncol) this.cols = [0];

    const tests = st.filters.map((f, c) => (f ? [c, compileFilter(f)] : null)).filter(Boolean) as Array<[number, (v: Cell) => boolean]>;
    const q = this.quick.toLowerCase();
    let idx: number[] = [];
    for (let i = 0; i < s.rows.length; i++) {
      const row = s.rows[i];
      let ok = true;
      for (const [c, t] of tests)
        if (!t(row[c] ?? null)) {
          ok = false;
          break;
        }
      if (ok && this.formulaFilter) {
        const v = this.formulaFilter(row, i);
        ok = !!v && v !== 'false' && v !== '0';
      }
      if (ok && q) ok = row.some((v) => v !== null && cellText(v).toLowerCase().includes(q));
      if (ok) idx.push(i);
    }
    if (st.sort.length) {
      const keys = st.sort.map((k) => ({ ...k, num: this.types[k.c] === 'number' }));
      idx.sort((a, b) => {
        for (const k of keys) {
          const va = s.rows[a][k.c] ?? null;
          const vb = s.rows[b][k.c] ?? null;
          const ea = va === null || va === '';
          const eb = vb === null || vb === '';
          if (ea || eb) {
            if (ea && eb) continue;
            return ea ? 1 : -1; // empties last regardless of direction
          }
          let d: number;
          if (k.num) {
            const na = toNum(va);
            const nb = toNum(vb);
            d = na === null || nb === null ? (na === null ? 1 : -1) : na - nb;
          } else d = this.collator.compare(cellText(va), cellText(vb));
          if (d) return d * k.dir;
        }
        return a - b;
      });
    }
    this.viewIdx = idx;
    this.clampSelection();
    this.gutter = Math.max(GUTTER_MIN, String(s.rows.length).length * 8 + 20);
    this.renderHeader();
    this.renderFilters();
    this.renderTabs();
    this.render();
    this.drawer.refresh();
    this.undoBtn.disabled = !this.doc.canUndo();
    this.redoBtn.disabled = !this.doc.canRedo();
  }

  private clampSelection() {
    const maxR = Math.max(0, this.viewIdx.length - 1);
    const maxC = Math.max(0, this.cols.length - 1);
    for (const p of [this.anchor, this.focus]) {
      p.r = Math.max(0, Math.min(p.r, maxR));
      p.c = Math.max(0, Math.min(p.c, maxC));
    }
  }

  autosize(onlyCol?: number) {
    const s = this.sheet;
    const st = this.state;
    const ctx = document.createElement('canvas').getContext('2d')!;
    const cs = getComputedStyle(document.body);
    const base = `${cs.fontSize || '13px'} ${cs.fontFamily || 'sans-serif'}`;
    const measure = (t: string, bold = false) => {
      ctx.font = (bold ? '600 ' : '') + base;
      return ctx.measureText(t).width;
    };
    s.headers.forEach((hd, c) => {
      if (onlyCol !== undefined && c !== onlyCol) return;
      if (onlyCol === undefined && st.widths[c]) return;
      let w = measure(hd, true) + 64;
      for (let r = 0; r < Math.min(s.rows.length, 300); r++) w = Math.max(w, measure(cellText(s.rows[r][c] ?? null).slice(0, 80)) + 20);
      st.widths[c] = Math.round(Math.min(360, Math.max(64, w)));
    });
  }

  width(c: number) {
    return this.state.widths[c] || 120;
  }

  /* ============================================================ layout */

  private build() {
    const o = this.opts;
    this.searchInput = h('input', {
      class: 'search',
      type: 'search',
      placeholder: 'Search all cells…',
      spellcheck: false,
      oninput: debounce(() => {
        this.quick = this.searchInput.value;
        this.refresh();
      }, 120),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          this.searchInput.value = '';
          this.quick = '';
          this.refresh();
          this.viewport.focus();
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          this.viewport.focus();
        }
      },
    });
    this.undoBtn = btn(null, 'undo', () => this.undo(), { title: 'Undo (⌘Z)' });
    this.redoBtn = btn(null, 'redo', () => this.redo(), { title: 'Redo (⇧⌘Z)' });

    const drawerBtn = (tab: DrawerTab, ic: string, label: string, key: string) =>
      btn(label, ic, () => this.drawer.toggle(tab), { title: `${label} (${key})`, cls: `drawer-btn drawer-btn-${tab}` });

    const toolbar = h(
      'div',
      { class: 'toolbar' },
      o.toolbarPrefix || null,
      h('div', { class: 'search-wrap' }, icon('search', 14), this.searchInput),
      btn(null, 'filter', () => this.toggleFilters(), { title: 'Column filters (⌘⇧F)', cls: 'filter-toggle' }),
      btn(null, 'columns', (e) => this.columnsMenu(e), { title: 'Show / hide columns' }),
      h('div', { class: 'sep' }),
      o.readonly ? null : [this.undoBtn, this.redoBtn, btn(null, 'plus', (e) => this.addMenu(e), { title: 'Add rows / columns' }), h('div', { class: 'sep' })],
      drawerBtn('stats', 'stats', 'Profile', '⌘1'),
      drawerBtn('chart', 'chart', 'Chart', '⌘2'),
      o.readonly ? null : drawerBtn('transform', 'wand', 'Transform', '⌘3'),
      h('div', { class: 'spacer' }),
      btn('Export', 'export', (e) => this.exportMenu(e), { title: 'Export / copy as…' }),
      !o.readonly && o.onSave && !host.hostHandlesUndo ? btn('Save', 'save', () => o.onSave!(), { title: 'Save (⌘S)', primary: true }) : null,
    );

    this.headerRow = h('div', { class: 'hrow' });
    this.filterRow = h('div', { class: 'frow' });
    this.rowsEl = h('div', { class: 'rows' });
    this.canvas = h('div', { class: 'canvas' }, this.rowsEl);
    this.viewport = h('div', { class: 'viewport', tabindex: 0, role: 'grid', 'aria-label': 'Data grid' }, this.headerRow, this.filterRow, this.canvas);
    this.status = h('div', { class: 'status' });
    this.tabs = h('div', { class: 'sheet-tabs' });

    this.viewport.addEventListener('scroll', () => {
      this.state.scrollTop = this.viewport.scrollTop;
      this.state.scrollLeft = this.viewport.scrollLeft;
      this.renderRows();
      if (this.editing) this.positionEditor();
    });
    this.viewport.addEventListener('keydown', (e) => this.onKey(e));
    this.viewport.addEventListener('paste', (e) => this.onPaste(e));
    this.viewport.addEventListener('copy', (e) => {
      if (this.editing) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', this.selectionTsv());
    });
    this.rowsEl.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.rowsEl.addEventListener('contextmenu', (e) => this.onContext(e));
    window.addEventListener('mouseup', () => (this.dragging = false));
    new ResizeObserver(() => this.renderRows()).observe(this.viewport);

    const gridWrap = h('div', { class: 'grid-wrap' }, this.viewport);
    this.el.append(toolbar, h('div', { class: 'tv-body' }, gridWrap, this.drawer.el), h('div', { class: 'footer' }, this.tabs, this.status));
    this.el.addEventListener('keydown', (e) => this.onGlobalKey(e));
  }

  /* ============================================================ render */

  private renderHeader() {
    const s = this.sheet;
    const st = this.state;
    const typeIcon: Record<ColType, string> = { number: '#', date: '◷', boolean: '◐', text: 'Aa', empty: '∅' };
    const cells: HTMLElement[] = [h('div', { class: 'hc corner', style: { width: this.gutter + 'px' }, title: 'Select all', onclick: () => this.selectAll() })];
    this.cols.forEach((c, vc) => {
      const sk = st.sort.findIndex((k) => k.c === c);
      const sortInfo = sk >= 0 ? st.sort[sk] : null;
      const cell = h(
        'div',
        {
          class: `hc ${this.inSelCol(vc) ? 'sel' : ''} ${st.filters[c] ? 'filtered' : ''}`,
          style: { width: this.width(c) + 'px' },
          'data-c': vc,
          title: `${s.headers[c]} · ${this.types[c]} · column ${colName(c)}\nClick: sort · Shift+click: add sort · Right-click: menu`,
        },
        h('span', { class: `type t-${this.types[c]}` }, typeIcon[this.types[c]]),
        h('span', { class: 'hname' }, s.headers[c]),
        sortInfo ? h('span', { class: 'sort' }, icon(sortInfo.dir === 1 ? 'sortAsc' : 'sortDesc', 12), st.sort.length > 1 ? String(sk + 1) : '') : null,
        h('button', {
          class: 'hmenu',
          title: 'Column menu',
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            this.columnMenu(c, r.left, r.bottom);
          },
        }, icon('menu', 12)),
        h('div', { class: 'resize', onmousedown: (e: MouseEvent) => this.startResize(e, c), ondblclick: () => this.autoFit(c) }),
      );
      cell.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.hmenu,.resize')) return;
        if (e.altKey || e.metaKey || e.ctrlKey) return this.selectColumn(vc, e.shiftKey);
        this.cycleSort(c, e.shiftKey);
      });
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.columnMenu(c, e.clientX, e.clientY);
      });
      this.makeDraggable(cell, c);
      cells.push(cell);
    });
    this.headerRow.replaceChildren(...cells);
    this.syncWidth();
  }

  private renderFilters() {
    this.filterRow.style.display = this.showFilters ? '' : 'none';
    this.el.querySelector('.filter-toggle')?.classList.toggle('active', this.showFilters || this.state.filters.some(Boolean));
    if (!this.showFilters) return;
    const st = this.state;
    const cells: HTMLElement[] = [h('div', { class: 'fc corner', style: { width: this.gutter + 'px' } }, icon('filter', 12))];
    for (const c of this.cols) {
      const inp = h('input', {
        type: 'text',
        placeholder: this.types[c] === 'number' ? '>0, 1..9' : 'contains…',
        title: 'text · =exact · !=x · !text · >10 · <=5 · 1..9 · /regex/ · empty · !empty',
        spellcheck: false,
        value: st.filters[c] || '',
      });
      inp.addEventListener(
        'input',
        debounce(() => {
          st.filters[c] = inp.value;
          const pos = inp.selectionStart;
          this.refresh();
          const again = this.filterRow.querySelector<HTMLInputElement>(`input[data-c="${c}"]`);
          again?.focus();
          if (pos !== null) again?.setSelectionRange(pos, pos);
        }, 200),
      );
      inp.dataset.c = String(c);
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          inp.value = '';
          st.filters[c] = '';
          this.refresh();
        }
        if (e.key === 'Enter') this.viewport.focus();
      });
      cells.push(h('div', { class: `fc ${st.filters[c] ? 'active' : ''}`, style: { width: this.width(c) + 'px' } }, inp));
    }
    this.filterRow.replaceChildren(...cells);
  }

  private syncWidth() {
    const total = this.gutter + this.cols.reduce((a, c) => a + this.width(c), 0);
    this.canvas.style.width = total + 'px';
    this.headerRow.style.width = total + 'px';
    this.filterRow.style.width = total + 'px';
  }

  render() {
    this.canvas.style.height = this.viewIdx.length * RH + 'px';
    this.syncWidth();
    this.renderRows();
    this.renderStatus();
  }

  private renderRows() {
    const vp = this.viewport;
    const headH = this.headerRow.offsetHeight + (this.showFilters ? this.filterRow.offsetHeight : 0);
    const top = Math.max(0, vp.scrollTop);
    const first = Math.max(0, Math.floor(top / RH) - OVERSCAN);
    const last = Math.min(this.viewIdx.length, Math.ceil((top + vp.clientHeight - headH) / RH) + OVERSCAN);
    const s = this.sheet;
    const sel = this.selRect();
    const q = this.quick.toLowerCase();
    const widths = this.cols.map((c) => this.width(c));
    const numCols = this.cols.map((c) => this.types[c] === 'number');
    let html = '';
    for (let vr = first; vr < last; vr++) {
      const di = this.viewIdx[vr];
      const row = s.rows[di] || [];
      const rowSel = vr >= sel.r0 && vr <= sel.r1;
      html += `<div class="r${rowSel ? ' rsel' : ''}${vr % 2 ? ' odd' : ''}" style="top:${vr * RH}px" data-r="${vr}"><div class="g" style="width:${this.gutter}px">${di + 1}</div>`;
      for (let vc = 0; vc < this.cols.length; vc++) {
        const v = row[this.cols[vc]] ?? null;
        let text = escapeHtml(cellText(v));
        if (text.length > 500) text = text.slice(0, 500) + '…';
        if (q && text) text = highlight(text, q);
        const inSel = rowSel && vc >= sel.c0 && vc <= sel.c1;
        const isFocus = vr === this.focus.r && vc === this.focus.c;
        const cls = `c${numCols[vc] && toNum(v) !== null ? ' num' : ''}${v === null ? ' empty' : ''}${inSel ? ' sel' : ''}${isFocus ? ' focus' : ''}${typeof v === 'boolean' ? ' bool' : ''}`;
        html += `<div class="${cls}" style="width:${widths[vc]}px" data-c="${vc}">${text}</div>`;
      }
      html += '</div>';
    }
    this.rowsEl.innerHTML = html;
    if (!this.viewIdx.length) {
      this.rowsEl.innerHTML = `<div class="empty-state">${s.rows.length ? 'No rows match the current search / filters.' : 'This sheet is empty.'}${
        this.readonly ? '' : s.rows.length ? '' : ' <a href="#" data-act="addrow">Add a row</a>'
      }</div>`;
      this.rowsEl.querySelector('[data-act=addrow]')?.addEventListener('click', (e) => {
        e.preventDefault();
        this.insertRows(0, 1);
      });
    }
  }

  private renderStatus() {
    const s = this.sheet;
    const sel = this.selRect();
    const parts: Array<HTMLElement | string> = [];
    const total = s.rows.length;
    const shown = this.viewIdx.length;
    parts.push(h('span', null, `${shown.toLocaleString()}${shown !== total ? ` of ${total.toLocaleString()}` : ''} rows × ${s.headers.length} cols`));
    const st = this.state;
    const nf = st.filters.filter(Boolean).length + (this.formulaFilter ? 1 : 0);
    if (nf || this.quick) parts.push(h('a', { href: '#', class: 'clear-filters', onclick: (e: Event) => (e.preventDefault(), this.clearFilters()) }, `clear ${nf + (this.quick ? 1 : 0)} filter${nf + (this.quick ? 1 : 0) > 1 ? 's' : ''}`));
    if (st.sort.length) parts.push(h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), (st.sort = []), this.refresh()) }, 'clear sort'));
    if (shown) {
      const c = this.cols[this.focus.c];
      parts.push(h('span', { class: 'cellref' }, `${colName(c ?? 0)}${this.viewIdx[this.focus.r] + 1}`));
      const cells = (sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1);
      if (cells > 1 && cells < 2_000_000) {
        let sum = 0,
          n = 0,
          cnt = 0;
        for (let r = sel.r0; r <= sel.r1; r++) {
          const row = s.rows[this.viewIdx[r]];
          for (let vc = sel.c0; vc <= sel.c1; vc++) {
            const v = row?.[this.cols[vc]] ?? null;
            if (v !== null && v !== '') cnt++;
            const x = toNum(v);
            if (x !== null) {
              sum += x;
              n++;
            }
          }
        }
        parts.push(h('span', null, `${sel.r1 - sel.r0 + 1}×${sel.c1 - sel.c0 + 1} · count ${cnt.toLocaleString()}`));
        if (n) parts.push(h('span', null, `sum ${fmtNum(sum)} · avg ${fmtNum(sum / n)}`));
      }
    }
    if (this.doc.hasFormulas && !this.readonly) parts.push(h('span', { class: 'warn', title: 'Edited sheets are saved as values. Untouched sheets keep their formulas.' }, 'ƒ formulas → values on edited sheets'));
    this.status.replaceChildren(...parts.flatMap((p, i) => (i ? [h('span', { class: 'dot' }, '·'), p] : [p])));
  }

  private renderTabs() {
    const d = this.doc;
    const show = d.sheets.length > 1 || (this.opts.allowSheets && !this.readonly && d.format !== 'csv' && d.format !== 'tsv');
    this.tabs.style.display = show ? '' : 'none';
    if (!show) return;
    const items = d.sheets.map((s, i) =>
      h(
        'button',
        {
          class: `tab ${i === d.active ? 'active' : ''} ${s.derived ? 'derived' : ''}`,
          title: s.derived && (d.format === 'csv' || d.format === 'tsv') ? 'Derived sheet — not written to the CSV. Use Export to save it.' : s.name,
          onclick: () => this.switchSheet(i),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            this.sheetMenu(i, e.clientX, e.clientY);
          },
        },
        icon('sheet', 12),
        s.name,
      ),
    );
    this.tabs.replaceChildren(
      ...items,
      !this.readonly && d.format !== 'csv' && d.format !== 'tsv' ? btn(null, 'plus', () => this.addSheet(), { title: 'Add sheet', cls: 'tab-add' }) : '',
    );
  }

  switchSheet(i: number) {
    if (i === this.doc.active) return;
    this.commitEdit();
    this.doc.active = i;
    this.anchor = { r: 0, c: 0 };
    this.focus = { r: 0, c: 0 };
    this.autosize();
    this.refresh();
    this.viewport.scrollTop = this.state.scrollTop;
    this.viewport.scrollLeft = this.state.scrollLeft;
  }

  /* ============================================================ selection */

  selRect() {
    return {
      r0: Math.min(this.anchor.r, this.focus.r),
      r1: Math.max(this.anchor.r, this.focus.r),
      c0: Math.min(this.anchor.c, this.focus.c),
      c1: Math.max(this.anchor.c, this.focus.c),
    };
  }

  private inSelCol(vc: number) {
    const s = this.selRect();
    return vc >= s.c0 && vc <= s.c1;
  }

  /** Data column index of the focused cell. */
  get focusCol() {
    return this.cols[this.focus.c] ?? 0;
  }

  selectedDataRows(): number[] {
    const s = this.selRect();
    return this.viewIdx.slice(s.r0, s.r1 + 1);
  }

  selectedDataCols(): number[] {
    const s = this.selRect();
    return this.cols.slice(s.c0, s.c1 + 1);
  }

  /** Rows currently visible (after search/filter/sort), in display order. */
  viewRows(): Cell[][] {
    const rows = this.sheet.rows;
    return this.viewIdx.map((i) => rows[i]);
  }

  setFocus(r: number, c: number, extend = false) {
    this.focus = { r: Math.max(0, Math.min(r, this.viewIdx.length - 1)), c: Math.max(0, Math.min(c, this.cols.length - 1)) };
    if (!extend) this.anchor = { ...this.focus };
    this.scrollIntoView();
    this.renderRows();
    this.renderStatus();
    this.headerRow.querySelectorAll('.hc[data-c]').forEach((el) => el.classList.toggle('sel', this.inSelCol(+(el as HTMLElement).dataset.c!)));
    this.drawer.onSelection();
  }

  selectAll() {
    this.anchor = { r: 0, c: 0 };
    this.focus = { r: this.viewIdx.length - 1, c: this.cols.length - 1 };
    this.renderRows();
    this.renderStatus();
    this.viewport.focus();
  }

  selectColumn(vc: number, extend = false) {
    if (!extend) this.anchor = { r: 0, c: vc };
    else this.anchor.r = 0;
    this.focus = { r: this.viewIdx.length - 1, c: vc };
    this.renderRows();
    this.renderHeader();
    this.renderStatus();
    this.drawer.onSelection();
    this.viewport.focus();
  }

  private colLeft(vc: number) {
    let x = this.gutter;
    for (let i = 0; i < vc; i++) x += this.width(this.cols[i]);
    return x;
  }

  private scrollIntoView() {
    const vp = this.viewport;
    const headH = this.headerRow.offsetHeight + (this.showFilters ? this.filterRow.offsetHeight : 0);
    const y = this.focus.r * RH;
    const viewH = vp.clientHeight - headH;
    if (y < vp.scrollTop) vp.scrollTop = y;
    else if (y + RH > vp.scrollTop + viewH) vp.scrollTop = y + RH - viewH;
    const x = this.colLeft(this.focus.c);
    const w = this.width(this.cols[this.focus.c]);
    if (x - this.gutter < vp.scrollLeft) vp.scrollLeft = x - this.gutter;
    else if (x + w > vp.scrollLeft + vp.clientWidth) vp.scrollLeft = x + w - vp.clientWidth;
  }

  private hit(e: MouseEvent): Pos | null {
    const cell = (e.target as HTMLElement).closest('.c, .g') as HTMLElement | null;
    const row = (e.target as HTMLElement).closest('.r') as HTMLElement | null;
    if (!row) return null;
    return { r: +row.dataset.r!, c: cell?.classList.contains('c') ? +cell.dataset.c! : -1 };
  }

  private onMouseDown(e: MouseEvent) {
    const p = this.hit(e);
    if (!p) return;
    e.preventDefault(); // we manage focus ourselves (default would steal it from the cell editor)
    this.commitEdit();
    if (e.button === 2) {
      const s = this.selRect();
      if (p.r >= s.r0 && p.r <= s.r1 && (p.c < 0 || (p.c >= s.c0 && p.c <= s.c1))) return; // keep selection for context menu
    }
    if (p.c < 0) {
      // gutter → select row(s)
      if (!e.shiftKey) this.anchor = { r: p.r, c: 0 };
      this.focus = { r: p.r, c: this.cols.length - 1 };
      this.anchor.c = 0;
      this.renderRows();
      this.renderStatus();
      this.viewport.focus();
      return;
    }
    // Rows re-render on mousedown, so the browser never fires click/dblclick — detect double-press here.
    const now = Date.now();
    const last = this.lastPress;
    this.lastPress = { r: p.r, c: p.c, t: now };
    if (last && last.r === p.r && last.c === p.c && now - last.t < 450 && !e.shiftKey && e.button === 0) {
      this.lastPress = null;
      return this.startEdit();
    }
    this.setFocus(p.r, p.c, e.shiftKey);
    this.viewport.focus({ preventScroll: true });
    this.dragging = true;
    const move = (ev: MouseEvent) => {
      if (!this.dragging) return window.removeEventListener('mousemove', move);
      const q = this.hit(ev);
      if (q && q.c >= 0 && (q.r !== this.focus.r || q.c !== this.focus.c)) this.setFocus(q.r, q.c, true);
    };
    window.addEventListener('mousemove', move);
  }

  /* ============================================================ keyboard */

  private onGlobalKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && e.shiftKey) {
      e.preventDefault();
      this.toggleFilters();
    } else if (k === 'f') {
      e.preventDefault();
      this.searchInput.focus();
      this.searchInput.select();
    } else if (k === 's' && !host.hostHandlesUndo) {
      e.preventDefault();
      this.commitEdit();
      this.opts.onSave?.();
    } else if (['1', '2', '3'].includes(k)) {
      e.preventDefault();
      this.drawer.toggle((['stats', 'chart', 'transform'] as DrawerTab[])[+k - 1]);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (this.editing || e.target !== this.viewport) return;
    const mod = e.metaKey || e.ctrlKey;
    const { r, c } = this.focus;
    const pageRows = Math.max(1, Math.floor(this.viewport.clientHeight / RH) - 2);
    const k = e.key;
    const move = (nr: number, nc: number) => {
      e.preventDefault();
      this.setFocus(nr, nc, e.shiftKey);
    };
    switch (k) {
      case 'ArrowDown':
        return move(mod ? this.viewIdx.length - 1 : r + 1, c);
      case 'ArrowUp':
        return move(mod ? 0 : r - 1, c);
      case 'ArrowRight':
        return move(r, mod ? this.cols.length - 1 : c + 1);
      case 'ArrowLeft':
        return move(r, mod ? 0 : c - 1);
      case 'PageDown':
        return move(r + pageRows, c);
      case 'PageUp':
        return move(r - pageRows, c);
      case 'Home':
        return move(mod ? 0 : r, 0);
      case 'End':
        return move(mod ? this.viewIdx.length - 1 : r, this.cols.length - 1);
      case 'Tab':
        e.preventDefault();
        return this.setFocus(r, e.shiftKey ? c - 1 : c + 1);
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (k === 'Enter' && e.shiftKey) return this.setFocus(r - 1, c);
        return this.startEdit();
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (mod) return this.deleteRows(this.selectedDataRows());
        return this.clearSelection();
      case 'Escape':
        return this.setFocus(r, c);
    }
    if (mod) {
      const lk = k.toLowerCase();
      if (lk === 'a') {
        e.preventDefault();
        return this.selectAll();
      }
      if (lk === 'x') {
        e.preventDefault();
        host.copy(this.selectionTsv());
        return this.clearSelection();
      }
      if (lk === 'd') {
        e.preventDefault();
        return this.fillDown();
      }
      if ((lk === 'z' || lk === 'y') && !host.hostHandlesUndo) {
        e.preventDefault();
        return lk === 'y' || e.shiftKey ? this.redo() : this.undo();
      }
      return;
    }
    if (k.length === 1 && !e.altKey && !this.readonly) {
      e.preventDefault();
      this.startEdit(k);
    }
  }

  /* ============================================================ editing */

  startEdit(initial?: string) {
    if (this.readonly || !this.viewIdx.length || !this.cols.length) return;
    const { r, c } = this.focus;
    this.editing = { r, c };
    const v = this.sheet.rows[this.viewIdx[r]]?.[this.cols[c]] ?? null;
    const ed = h('textarea', { class: 'cell-editor', spellcheck: false, rows: 1 });
    ed.value = initial ?? cellText(v);
    ed.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        this.commitEdit();
        this.setFocus(r + 1, c);
        this.viewport.focus();
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        this.commitEdit();
        this.setFocus(r - 1, c);
        this.viewport.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commitEdit();
        this.setFocus(r, e.shiftKey ? c - 1 : c + 1);
        this.viewport.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEdit();
      }
    });
    ed.addEventListener('blur', () => setTimeout(() => this.editor === ed && this.commitEdit(), 0));
    this.editor = ed;
    this.viewport.appendChild(ed);
    this.positionEditor();
    ed.focus();
    if (initial === undefined) ed.select();
    else ed.setSelectionRange(ed.value.length, ed.value.length);
  }

  private positionEditor() {
    if (!this.editor || !this.editing) return;
    const headH = this.headerRow.offsetHeight + (this.showFilters ? this.filterRow.offsetHeight : 0);
    const { r, c } = this.editing;
    Object.assign(this.editor.style, {
      left: this.colLeft(c) + 'px',
      top: headH + r * RH + 'px',
      width: Math.max(this.width(this.cols[c]), 160) + 'px',
      minHeight: RH + 'px',
    });
  }

  commitEdit() {
    if (!this.editor || !this.editing) return;
    const { r, c } = this.editing;
    const text = this.editor.value;
    this.editor.remove();
    this.editor = null;
    this.editing = null;
    const di = this.viewIdx[r];
    const dc = this.cols[c];
    const old = this.sheet.rows[di]?.[dc] ?? null;
    if (cellText(old) === text) return;
    const typed = this.opts.typedInput || typeof old === 'number' || typeof old === 'boolean';
    this.doc.mutate('Edit cell', (s) => setCell(s, di, dc, parseInput(text, typed)));
  }

  cancelEdit() {
    this.editor?.remove();
    this.editor = null;
    this.editing = null;
    this.viewport.focus();
  }

  clearSelection() {
    if (this.readonly) return;
    const rows = this.selectedDataRows();
    const cols = this.selectedDataCols();
    this.doc.mutate('Clear cells', (s) => {
      for (const r of rows) for (const c of cols) if ((s.rows[r][c] ?? null) !== null) setCell(s, r, c, null);
    });
  }

  fillDown() {
    if (this.readonly) return;
    const rows = this.selectedDataRows();
    const cols = this.selectedDataCols();
    if (rows.length < 2) return toast('Select a range of at least two rows to fill down');
    this.doc.mutate('Fill down', (s) => {
      for (const c of cols) {
        const v = s.rows[rows[0]][c] ?? null;
        for (const r of rows.slice(1)) setCell(s, r, c, v);
      }
    });
  }

  selectionTsv(): string {
    const s = this.selRect();
    const lines: string[] = [];
    const quote = (t: string) => (/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    if (s.r0 === 0 && s.r1 === this.viewIdx.length - 1 && this.viewIdx.length > 1) lines.push(this.cols.slice(s.c0, s.c1 + 1).map((c) => quote(this.sheet.headers[c])).join('\t'));
    for (let r = s.r0; r <= s.r1; r++) {
      const row = this.sheet.rows[this.viewIdx[r]];
      lines.push(this.cols.slice(s.c0, s.c1 + 1).map((c) => quote(cellText(row?.[c] ?? null))).join('\t'));
    }
    return lines.join('\n');
  }

  private onPaste(e: ClipboardEvent) {
    if (this.editing || this.readonly) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    this.pasteText(text);
  }

  async pasteFromClipboard() {
    try {
      this.pasteText(await navigator.clipboard.readText());
    } catch {
      toast('Clipboard access blocked — use ⌘V / Ctrl+V instead');
    }
  }

  pasteText(text: string) {
    const grid = parseCsv(text.replace(/\r?\n$/, ''), text.includes('\t') ? '\t' : ',');
    const { r, c } = this.focus;
    const typed = !!this.opts.typedInput;
    const sel = this.selRect();
    // Single value pasted into a multi-cell selection → fill the selection.
    const fill = grid.length === 1 && grid[0].length === 1 && (sel.r1 > sel.r0 || sel.c1 > sel.c0);
    this.doc.mutate('Paste', (s) => {
      if (fill) {
        for (let vr = sel.r0; vr <= sel.r1; vr++) for (let vc = sel.c0; vc <= sel.c1; vc++) setCell(s, this.viewIdx[vr], this.cols[vc], parseInput(grid[0][0], typed));
        return;
      }
      grid.forEach((line, i) => {
        let di = this.viewIdx[r + i];
        if (di === undefined) {
          s.rows.push(new Array(s.headers.length).fill(null));
          di = s.rows.length - 1;
        }
        line.forEach((val, j) => {
          let dc = this.cols[c + j];
          if (dc === undefined) {
            s.headers.push(uniqueHeader(s.headers, colName(s.headers.length)));
            dc = s.headers.length - 1;
          }
          setCell(s, di, dc, parseInput(val, typed));
        });
      });
    });
    this.anchor = { r, c };
    this.focus = { r: Math.min(this.viewIdx.length - 1, r + grid.length - 1), c: Math.min(this.cols.length - 1, c + (grid[0]?.length || 1) - 1) };
    this.renderRows();
    toast(fill ? 'Filled selection' : `Pasted ${grid.length}×${grid[0]?.length ?? 0}`, 'ok', 1400);
  }

  /* ============================================================ structure ops */

  insertRows(at: number, n = 1) {
    if (this.readonly) return;
    this.doc.mutate(n > 1 ? `Insert ${n} rows` : 'Insert row', (s) => s.rows.splice(at, 0, ...Array.from({ length: n }, () => new Array(s.headers.length).fill(null))));
    const vr = this.viewIdx.indexOf(at);
    if (vr >= 0) this.setFocus(vr, this.focus.c);
    else if (this.state.filters.some(Boolean) || this.quick) toast('Row added — hidden by current filters');
  }

  deleteRows(rows: number[]) {
    if (this.readonly || !rows.length) return;
    const del = new Set(rows);
    this.doc.mutate(rows.length > 1 ? `Delete ${rows.length} rows` : 'Delete row', (s) => {
      s.rows = s.rows.filter((_, i) => !del.has(i));
    });
    toast(`Deleted ${rows.length.toLocaleString()} row${rows.length > 1 ? 's' : ''}`, 'info', 1600);
  }

  insertColumn(at: number, name?: string, values?: Cell[]) {
    if (this.readonly) return;
    this.doc.mutate('Insert column', (s) => {
      const nm = uniqueHeader(s.headers, name || `Column ${s.headers.length + 1}`);
      s.headers.splice(at, 0, nm);
      s.rows = s.rows.map((r, i) => {
        const nr = r.slice();
        nr.splice(at, 0, values ? values[i] ?? null : null);
        return nr;
      });
      this.shiftColumnState(at, 1);
    });
  }

  deleteColumns(cols: number[]) {
    if (this.readonly || !cols.length) return;
    const del = new Set(cols);
    this.doc.mutate(cols.length > 1 ? `Delete ${cols.length} columns` : 'Delete column', (s) => {
      s.headers = s.headers.filter((_, i) => !del.has(i));
      s.rows = s.rows.map((r) => r.filter((_, i) => !del.has(i)));
      const st = this.state;
      st.widths = st.widths.filter((_, i) => !del.has(i));
      st.filters = st.filters.filter((_, i) => !del.has(i));
      st.sort = st.sort.filter((k) => !del.has(k.c)).map((k) => ({ ...k, c: k.c - cols.filter((d) => d < k.c).length }));
      st.hidden = new Set([...st.hidden].filter((h) => !del.has(h)).map((h) => h - cols.filter((d) => d < h).length));
    });
  }

  moveColumn(from: number, to: number) {
    if (from === to || this.readonly) return;
    this.doc.mutate('Move column', (s) => {
      const mv = <T>(a: T[]) => {
        const x = a.splice(from, 1)[0];
        a.splice(to, 0, x);
      };
      mv(s.headers);
      s.rows = s.rows.map((r) => {
        const nr = r.slice();
        mv(nr);
        return nr;
      });
      const st = this.state;
      mv(st.widths);
      mv(st.filters);
      const map = (c: number) => (c === from ? to : from < to ? (c > from && c <= to ? c - 1 : c) : c >= to && c < from ? c + 1 : c);
      st.sort = st.sort.map((k) => ({ ...k, c: map(k.c) }));
      st.hidden = new Set([...st.hidden].map(map));
    });
  }

  private shiftColumnState(at: number, n: number) {
    const st = this.state;
    st.widths.splice(at, 0, ...new Array(n).fill(0));
    st.filters.splice(at, 0, ...new Array(n).fill(''));
    st.sort = st.sort.map((k) => (k.c >= at ? { ...k, c: k.c + n } : k));
    st.hidden = new Set([...st.hidden].map((h) => (h >= at ? h + n : h)));
    this.autosize();
  }

  async renameColumn(c: number) {
    const r = await dialog('Rename column', [{ key: 'name', label: 'Column name', value: this.sheet.headers[c] }], 'Rename', (v) =>
      !v.name.trim() ? 'Name is required' : this.sheet.headers.some((h, i) => i !== c && h === v.name.trim()) ? 'A column with that name exists' : null,
    );
    if (!r) return;
    this.doc.mutate('Rename column', (s) => (s.headers[c] = r.name.trim()));
  }

  cycleSort(c: number, add: boolean) {
    const st = this.state;
    const i = st.sort.findIndex((k) => k.c === c);
    const cur = i >= 0 ? st.sort[i] : null;
    const next: SortKey | null = !cur ? { c, dir: 1 } : cur.dir === 1 ? { c, dir: -1 } : null;
    if (add) {
      if (i >= 0) st.sort.splice(i, 1, ...(next ? [next] : []));
      else if (next) st.sort.push(next);
    } else st.sort = next ? [next] : [];
    this.refresh();
  }

  sortBy(c: number, dir: 1 | -1) {
    this.state.sort = [{ c, dir }];
    this.refresh();
  }

  /** Make the current sort order permanent in the data. */
  applySort() {
    if (!this.state.sort.length) return toast('No active sort');
    const order = this.viewIdx.slice();
    const inView = new Set(order);
    this.doc.mutate('Apply sort', (s) => {
      const rest = s.rows.filter((_, i) => !inView.has(i));
      s.rows = [...order.map((i) => s.rows[i]), ...rest];
    });
    this.state.sort = [];
    this.refresh();
  }

  /** Permanently delete rows hidden by the current filters. */
  async keepFiltered() {
    const drop = this.sheet.rows.length - this.viewIdx.length;
    if (!drop) return toast('Nothing is filtered out');
    if (!(await confirmDialog('Keep only matching rows', `Delete ${drop.toLocaleString()} rows that don't match the current search & filters?`, 'Delete rows'))) return;
    const keep = new Set(this.viewIdx);
    this.doc.mutate('Keep filtered rows', (s) => (s.rows = s.rows.filter((_, i) => keep.has(i))));
    this.clearFilters();
  }

  /** Throws on syntax errors so the caller can show them. */
  setFormulaFilter(src: string) {
    this.formulaFilter = src.trim() ? compile(src, this.sheet.headers) : null;
    this.formulaFilterSrc = src;
    this.refresh();
  }

  clearFilters() {
    this.formulaFilter = null;
    this.formulaFilterSrc = '';
    this.state.filters = [];
    this.quick = '';
    this.searchInput.value = '';
    this.refresh();
  }

  setFilter(c: number, f: string) {
    this.state.filters[c] = f;
    this.showFilters = true;
    this.refresh();
  }

  toggleFilters() {
    this.showFilters = !this.showFilters;
    this.refresh();
    if (this.showFilters) setTimeout(() => this.filterRow.querySelector<HTMLInputElement>(`input[data-c="${this.focusCol}"]`)?.focus());
  }

  toggleHeader() {
    this.doc.mutate(
      this.doc.csv.hasHeader ? 'Use first row as data' : 'Use first row as header',
      (_s, d) => {
        const on = !d.csv.hasHeader;
        for (const s of d.sheets) {
          if (on) {
            const first = s.rows.shift() || [];
            s.headers = s.headers.map((_, i) => cellText(first[i] ?? null) || colName(i));
            const seen = new Set<string>();
            s.headers = s.headers.map((h) => {
              const u = seen.has(h) ? uniqueHeader([...seen], h) : h;
              seen.add(u);
              return u;
            });
          } else {
            s.rows.unshift(s.headers.slice());
            s.headers = s.headers.map((_, i) => colName(i));
          }
          s.dirty = true;
        }
        d.csv.hasHeader = on;
      },
    );
    this.states.clear();
    this.autosize();
    this.refresh();
  }

  undo() {
    this.commitEdit();
    if (host.hostHandlesUndo) host.post({ type: 'command', id: 'undo' });
    else this.doc.undo();
  }

  redo() {
    this.commitEdit();
    if (host.hostHandlesUndo) host.post({ type: 'command', id: 'redo' });
    else this.doc.redo();
  }

  /* ============================================================ sheets */

  async addSheet(sheet?: Sheet) {
    const s: Sheet = sheet || { name: uniqueHeader(this.doc.sheets.map((x) => x.name), 'Sheet'), headers: ['A', 'B', 'C'], rows: [[null, null, null]], dirty: true };
    this.doc.mutate('Add sheet', (_s, d) => {
      d.sheets.push({ ...s, dirty: true });
      d.active = d.sheets.length - 1;
    });
    this.autosize();
    this.refresh();
  }

  private async sheetMenu(i: number, x: number, y: number) {
    const d = this.doc;
    const s = d.sheets[i];
    const items: MenuEntry[] = [
      {
        label: 'Rename…',
        icon: 'edit',
        disabled: this.readonly,
        action: async () => {
          const r = await dialog('Rename sheet', [{ key: 'name', label: 'Sheet name', value: s.name }], 'Rename', (v) =>
            !v.name.trim() ? 'Required' : d.sheets.some((o, j) => j !== i && o.name === v.name.trim()) ? 'Name in use' : null,
          );
          if (r) d.mutate('Rename sheet', (_s, dd) => (dd.sheets[i] = { ...dd.sheets[i], name: r.name.trim(), dirty: true }));
        },
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        disabled: this.readonly,
        action: () => this.addSheet({ ...s, name: uniqueHeader(d.sheets.map((x) => x.name), s.name + ' copy'), origin: undefined }),
      },
      { label: 'Export sheet…', icon: 'export', action: () => (this.switchSheet(i), this.exportMenuAt(x, y)) },
      '-',
      {
        label: 'Delete sheet',
        icon: 'trash',
        danger: true,
        disabled: this.readonly || d.sheets.length < 2,
        action: () =>
          d.mutate('Delete sheet', (_s, dd) => {
            dd.sheets.splice(i, 1);
            dd.active = Math.min(dd.active, dd.sheets.length - 1);
          }),
      },
    ];
    showMenu(x, y, items);
  }

  /* ============================================================ menus */

  columnMenu(c: number, x: number, y: number) {
    const s = this.sheet;
    const ro = this.readonly;
    const cur = cellText(s.rows[this.viewIdx[this.focus.r]]?.[c] ?? null);
    const items: MenuEntry[] = [
      { label: 'Sort ascending', icon: 'sortAsc', action: () => this.sortBy(c, 1) },
      { label: 'Sort descending', icon: 'sortDesc', action: () => this.sortBy(c, -1) },
      { label: 'Filter this column…', icon: 'filter', action: () => (this.showFilters = true, this.refresh(), setTimeout(() => this.filterRow.querySelector<HTMLInputElement>(`input[data-c="${c}"]`)?.focus())) },
      {
        label: 'Profile column',
        icon: 'stats',
        action: () => {
          const vc = this.cols.indexOf(c);
          if (vc >= 0) this.setFocus(this.focus.r, vc);
          this.drawer.open('stats');
        },
      },
      { label: 'Chart this column', icon: 'chart', action: () => this.drawer.chartColumn(c) },
      '-',
      { label: 'Rename…', icon: 'edit', disabled: ro, action: () => this.renameColumn(c) },
      { label: 'Insert column left', disabled: ro, action: () => this.insertColumn(c) },
      { label: 'Insert column right', disabled: ro, action: () => this.insertColumn(c + 1) },
      { label: 'Duplicate column', icon: 'copy', disabled: ro, action: () => this.insertColumn(c + 1, s.headers[c] + ' copy', s.rows.map((r) => r[c] ?? null)) },
      { label: 'Move left', disabled: ro || c === 0, action: () => this.moveColumn(c, c - 1) },
      { label: 'Move right', disabled: ro || c === s.headers.length - 1, action: () => this.moveColumn(c, c + 1) },
      {
        label: 'Transform',
        icon: 'wand',
        disabled: ro,
        submenu: [
          { label: 'Trim whitespace', action: () => this.drawer.transformColumn(c, 'trim') },
          { label: 'UPPER CASE', action: () => this.drawer.transformColumn(c, 'upper') },
          { label: 'lower case', action: () => this.drawer.transformColumn(c, 'lower') },
          { label: 'Title Case', action: () => this.drawer.transformColumn(c, 'title') },
          { label: 'Convert to number', action: () => this.drawer.transformColumn(c, 'number') },
          { label: 'Convert to text', action: () => this.drawer.transformColumn(c, 'text') },
          { label: 'Fill empty cells down', action: () => this.drawer.transformColumn(c, 'filldown') },
          { label: 'Split column…', action: () => this.drawer.splitColumn(c) },
          { label: 'Find & replace…', action: () => this.drawer.open('transform', 'replace', c) },
        ],
      },
      '-',
      { label: 'Auto-fit width', action: () => this.autoFit(c) },
      { label: 'Hide column', icon: 'eye', action: () => (this.state.hidden.add(c), this.refresh()) },
      { label: 'Copy column values', icon: 'copy', action: () => host.copy(this.viewIdx.map((i) => cellText(s.rows[i][c] ?? null)).join('\n')) },
      cur ? { label: `Filter: = "${cur.length > 24 ? cur.slice(0, 24) + '…' : cur}"`, action: () => this.setFilter(c, '=' + cur) } : null,
      '-',
      { label: 'Delete column', icon: 'trash', danger: true, disabled: ro, action: () => this.deleteColumns([c]) },
    ].filter(Boolean) as MenuEntry[];
    showMenu(x, y, items);
  }

  private onContext(e: MouseEvent) {
    e.preventDefault();
    const p = this.hit(e);
    if (!p) return;
    const s = this.sheet;
    const sel = this.selRect();
    if (!(p.r >= sel.r0 && p.r <= sel.r1 && (p.c < 0 || (p.c >= sel.c0 && p.c <= sel.c1)))) this.setFocus(p.r, Math.max(0, p.c));
    const rows = this.selectedDataRows();
    const c = this.focusCol;
    const v = s.rows[this.viewIdx[this.focus.r]]?.[c] ?? null;
    const txt = cellText(v);
    const short = txt.length > 24 ? txt.slice(0, 24) + '…' : txt;
    const ro = this.readonly;
    const di = this.viewIdx[this.focus.r];
    const items: MenuEntry[] = [
      { label: 'Copy', icon: 'copy', hint: '⌘C', action: () => host.copy(this.selectionTsv()) },
      { label: 'Cut', hint: '⌘X', disabled: ro, action: () => (host.copy(this.selectionTsv()), this.clearSelection()) },
      { label: 'Paste', hint: '⌘V', disabled: ro, action: () => this.pasteFromClipboard() },
      {
        label: 'Copy as',
        submenu: [
          { label: 'Markdown table', action: () => host.copy(toMarkdown(this.selectedDataCols().map((c) => s.headers[c]), rows.map((r) => this.selectedDataCols().map((c) => s.rows[r][c] ?? null)))) },
          { label: 'JSON', action: () => host.copy(JSON.stringify(sheetToObjects({ ...s, headers: this.selectedDataCols().map((c) => s.headers[c]) }, rows.map((r) => this.selectedDataCols().map((c) => s.rows[r][c] ?? null))), null, 2)) },
          { label: 'SQL IN (…) list', action: () => host.copy(`(${[...new Set(rows.map((r) => cellText(s.rows[r][c] ?? null)))].map((x) => (toNum(x) !== null ? x : `'${x.replace(/'/g, "''")}'`)).join(', ')})`) },
        ],
      },
      '-',
      { label: 'Edit cell', icon: 'edit', hint: 'Enter', disabled: ro, action: () => this.startEdit() },
      { label: 'Clear', hint: '⌫', disabled: ro, action: () => this.clearSelection() },
      { label: 'Fill down', hint: '⌘D', disabled: ro || rows.length < 2, action: () => this.fillDown() },
      '-',
      { label: 'Insert row above', disabled: ro, action: () => this.insertRows(di) },
      { label: 'Insert row below', disabled: ro, action: () => this.insertRows(di + 1) },
      { label: rows.length > 1 ? `Delete ${rows.length} rows` : 'Delete row', icon: 'trash', hint: '⌘⌫', danger: true, disabled: ro, action: () => this.deleteRows(rows) },
      '-',
      { label: `Filter = "${short}"`, icon: 'filter', action: () => this.setFilter(c, v === null ? 'empty' : '=' + txt) },
      { label: `Exclude "${short}"`, action: () => this.setFilter(c, v === null ? '!empty' : '!=' + txt) },
      { label: 'Column', submenu: [] },
    ];
    // Column submenu mirrors the header menu
    (items[items.length - 1] as any).submenu = [
      { label: 'Sort ascending', icon: 'sortAsc', action: () => this.sortBy(c, 1) },
      { label: 'Sort descending', icon: 'sortDesc', action: () => this.sortBy(c, -1) },
      { label: 'Profile', icon: 'stats', action: () => this.drawer.open('stats') },
      { label: 'Rename…', disabled: ro, action: () => this.renameColumn(c) },
      { label: 'Insert left', disabled: ro, action: () => this.insertColumn(c) },
      { label: 'Insert right', disabled: ro, action: () => this.insertColumn(c + 1) },
      { label: 'Delete', danger: true, disabled: ro, action: () => this.deleteColumns(this.selectedDataCols()) },
    ];
    showMenu(e.clientX, e.clientY, items);
  }

  private addMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const di = this.viewIdx[this.focus.r] ?? -1;
    showMenu(r.left, r.bottom + 2, [
      { label: 'Row below selection', action: () => this.insertRows(di + 1) },
      { label: 'Row at end', action: () => this.insertRows(this.sheet.rows.length) },
      {
        label: 'Multiple rows…',
        action: async () => {
          const v = await dialog('Insert rows', [{ key: 'n', label: 'How many rows?', value: '10' }], 'Insert', (v) => (+v.n > 0 && +v.n <= 100000 ? null : 'Enter 1 – 100000'));
          if (v) this.insertRows(di + 1, +v.n);
        },
      },
      '-',
      { label: 'Column right of selection', action: () => this.insertColumn(this.focusCol + 1) },
      { label: 'Computed column (formula)…', icon: 'wand', action: () => this.drawer.open('transform', 'formula') },
      '-',
      { label: this.doc.csv.hasHeader ? 'Treat header as data row' : 'Use first row as header', icon: 'header', action: () => this.toggleHeader() },
    ]);
  }

  private columnsMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const st = this.state;
    const s = this.sheet;
    const list = h('div', { class: 'col-picker' });
    const filterInput = h('input', { type: 'search', placeholder: 'Find column…' });
    const draw = () => {
      const q = filterInput.value.toLowerCase();
      list.replaceChildren(
        ...s.headers
          .map((name, c) => ({ name, c }))
          .filter((x) => x.name.toLowerCase().includes(q))
          .map(({ name, c }) => {
            const cb = h('input', { type: 'checkbox' });
            cb.checked = !st.hidden.has(c);
            cb.onchange = () => {
              if (cb.checked) st.hidden.delete(c);
              else st.hidden.add(c);
              this.refresh();
            };
            return h('label', null, cb, h('span', { class: `type t-${this.types[c]}` }), name);
          }),
      );
    };
    filterInput.oninput = draw;
    draw();
    const pop = h(
      'div',
      { class: 'menu popover', style: { left: r.left + 'px', top: r.bottom + 2 + 'px' } },
      filterInput,
      h(
        'div',
        { class: 'row-btns' },
        h('button', { class: 'btn', onclick: () => (st.hidden.clear(), this.refresh(), draw()) }, 'Show all'),
        h('button', { class: 'btn', onclick: () => ((st.hidden = new Set(s.headers.map((_, i) => i).filter((i) => i !== this.focusCol))), this.refresh(), draw()) }, 'Only selected'),
      ),
      list,
    );
    const close = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) {
        pop.remove();
        document.removeEventListener('mousedown', close, true);
      }
    };
    document.addEventListener('mousedown', close, true);
    document.body.appendChild(pop);
    filterInput.focus();
  }

  private exportMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.exportMenuAt(r.right - 220, r.bottom + 2);
  }

  exportMenuAt(x: number, y: number) {
    const ex = (fmt: ExportFormat) => () => this.opts.onExport?.(fmt, 'all');
    const filtered = this.viewIdx.length !== this.sheet.rows.length || this.state.sort.length > 0;
    const exv = (fmt: ExportFormat) => () => this.opts.onExport?.(fmt, 'view');
    const s = this.sheet;
    showMenu(x, y, [
      { label: 'CSV…', action: ex('csv') },
      { label: 'TSV…', action: ex('tsv') },
      { label: 'Excel (.xlsx)…', action: ex('xlsx') },
      { label: 'JSON…', action: ex('json') },
      { label: 'JSON Lines…', action: ex('jsonl') },
      { label: 'SQL INSERTs…', action: ex('sql') },
      { label: 'HTML table…', action: ex('html') },
      { label: 'Markdown…', action: ex('md') },
      '-',
      {
        label: `Export visible rows only (${this.viewIdx.length.toLocaleString()})`,
        disabled: !filtered,
        submenu: [
          { label: 'CSV…', action: exv('csv') },
          { label: 'Excel (.xlsx)…', action: exv('xlsx') },
          { label: 'JSON…', action: exv('json') },
        ],
      },
      '-',
      { label: 'Copy visible rows as Markdown', icon: 'copy', action: () => (host.copy(toMarkdown(s.headers, this.viewRows())), toast('Copied Markdown', 'ok')) },
      { label: 'Copy visible rows as JSON', icon: 'copy', action: () => (host.copy(JSON.stringify(sheetToObjects(s, this.viewRows()), null, 2)), toast('Copied JSON', 'ok')) },
      { label: 'Copy visible rows as TSV', icon: 'copy', action: () => (host.copy([s.headers.join('\t'), ...this.viewRows().map((r) => r.map(cellText).join('\t'))].join('\n')), toast('Copied TSV', 'ok')) },
    ]);
  }

  /* ============================================================ resizing & dragging */

  private startResize(e: MouseEvent, c: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = this.width(c);
    const move = (ev: MouseEvent) => {
      this.state.widths[c] = Math.max(40, startW + ev.clientX - startX);
      const hc = this.headerRow.querySelector<HTMLElement>(`.hc[data-c="${this.cols.indexOf(c)}"]`);
      if (hc) hc.style.width = this.state.widths[c] + 'px';
      this.render();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.renderHeader();
      this.renderFilters();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private autoFit(c: number) {
    this.autosize(c);
    this.renderHeader();
    this.renderFilters();
    this.render();
  }

  private makeDraggable(cell: HTMLElement, c: number) {
    if (this.readonly) return;
    cell.draggable = true;
    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('text/x-datalens-col', String(c));
      e.dataTransfer!.effectAllowed = 'move';
      cell.classList.add('dragging');
    });
    cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
    cell.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/x-datalens-col')) return;
      e.preventDefault();
      cell.classList.add('drop');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drop');
      const from = +e.dataTransfer!.getData('text/x-datalens-col');
      if (!Number.isNaN(from)) this.moveColumn(from, c);
    });
  }

  focusGrid() {
    this.viewport.focus();
  }
}

function sample(rows: Cell[][], c: number): Cell[] {
  const out: Cell[] = [];
  const step = Math.max(1, Math.floor(rows.length / 500));
  for (let i = 0; i < rows.length && out.length < 500; i += step) out.push(rows[i][c] ?? null);
  return out;
}

function highlight(escaped: string, q: string): string {
  const eq = escapeHtml(q);
  const lower = escaped.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const j = lower.indexOf(eq, i);
    if (j < 0) break;
    out += escaped.slice(i, j) + '<mark>' + escaped.slice(j, j + eq.length) + '</mark>';
    i = j + eq.length;
  }
  return out + escaped.slice(i);
}
