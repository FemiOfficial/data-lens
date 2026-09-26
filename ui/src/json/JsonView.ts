import { JsonDoc, Path, pathId, isObj, typeOf, getAt, toJsonPath, toJsPath, toJqPath, parseLiteral, docStats, findArrays } from './JsonDoc';
import { evaluate, Match } from './jsonpath';
import { JsonGraph } from './JsonGraph';
import { h, icon, btn, showMenu, MenuEntry, dialog, toast, debounce, escapeHtml } from '../dom';
import { host } from '../host';
import { TableView } from '../table/TableView';
import { TableDoc } from '../model';
import { jsonToSheet, exportSheet, ExportFormat, encodeText } from '../io';

const RH = 22;
const OVERSCAN = 10;
type Mode = 'tree' | 'graph' | 'table';

interface Row {
  path: Path;
  key: string | number | null;
  value: unknown;
  depth: number;
  open: boolean;
  container: boolean;
}

export interface JsonViewOptions {
  readonly?: boolean;
  onEdit?: (label: string) => void;
  onSave?: () => void;
  onExport?: (fileName: string, data: Uint8Array) => void;
  fileName: string;
}

export class JsonView {
  el: HTMLElement;
  mode: Mode = 'tree';
  private expanded = new Set<string>([pathId([])]);
  private rows: Row[] = [];
  private selected: Path = [];
  private viewport!: HTMLDivElement;
  private canvas!: HTMLDivElement;
  private list!: HTMLDivElement;
  private crumbs!: HTMLDivElement;
  private status!: HTMLDivElement;
  private search!: HTMLInputElement;
  private searchInfo!: HTMLSpanElement;
  private query!: HTMLInputElement;
  private results!: HTMLDivElement;
  private treePane!: HTMLDivElement;
  private tablePane!: HTMLDivElement;
  private graph: JsonGraph;
  private matches: Path[] = [];
  private matchIds = new Set<string>();
  private matchIdx = -1;
  private searchText = '';
  private editing = false;
  private tableView: TableView | null = null;
  private tablePath: Path | null = null;
  private segBtns: Record<Mode, HTMLButtonElement> = {} as any;

  constructor(public doc: JsonDoc, public opts: JsonViewOptions) {
    this.graph = new JsonGraph(() => this.doc.value, (p) => {
      this.setMode('tree');
      this.reveal(p);
    });
    this.el = h('div', { class: 'jv' });
    this.build();
    this.expandToDepth(this.doc.value, [], 2);
    doc.onChange((label) => {
      if (label) opts.onEdit?.(label);
      this.tableView = null;
      this.refresh();
    });
    this.refresh();
  }

  /* ======================================================== layout */

  private build() {
    const seg = h('div', { class: 'seg' });
    for (const [m, label, ic] of [
      ['tree', 'Tree', 'tree'],
      ['graph', 'Graph', 'graph'],
      ['table', 'Table', 'table'],
    ] as Array<[Mode, string, string]>) {
      const b = h('button', { class: 'seg-btn', onclick: () => this.setMode(m), title: `${label} view` }, icon(ic, 14), label);
      this.segBtns[m] = b;
      seg.appendChild(b);
    }

    this.search = h('input', { type: 'search', class: 'search', placeholder: 'Search keys & values…', spellcheck: false });
    this.searchInfo = h('span', { class: 'search-info' });
    this.search.addEventListener('input', debounce(() => this.runSearch(), 150));
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.nextMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        this.search.value = '';
        this.runSearch();
        this.viewport.focus();
      }
    });

    this.query = h('input', { type: 'text', class: 'query', placeholder: '$.path, ..key, [*], [?(@.age > 30)]', spellcheck: false, title: 'JSONPath query — Enter to run' });
    this.results = h('div', { class: 'results', style: { display: 'none' } });
    this.query.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.runQuery();
      if (e.key === 'Escape') {
        this.query.value = '';
        this.results.style.display = 'none';
      }
    });

    const toolbar = h(
      'div',
      { class: 'toolbar' },
      seg,
      h('div', { class: 'sep' }),
      h('div', { class: 'search-wrap' }, icon('search', 14), this.search, this.searchInfo),
      h('div', { class: 'search-wrap query-wrap' }, h('span', { class: 'q-label' }, '$'), this.query),
      h('div', { class: 'sep' }),
      btn(null, 'expand', () => this.expandAll(), { title: 'Expand all (to depth 6)' }),
      btn(null, 'collapse', () => this.collapseAll(), { title: 'Collapse all' }),
      this.opts.readonly ? null : [btn(null, 'undo', () => this.undo(), { title: 'Undo' }), btn(null, 'redo', () => this.redo(), { title: 'Redo' })],
      h('div', { class: 'spacer' }),
      btn('Export', 'export', (e) => this.exportMenu(e)),
      !this.opts.readonly && this.opts.onSave && !host.hostHandlesUndo ? btn('Save', 'save', () => this.opts.onSave!(), { primary: true, title: 'Save (⌘S)' }) : null,
    );

    this.list = h('div', { class: 'jrows' });
    this.canvas = h('div', { class: 'canvas' }, this.list);
    this.viewport = h('div', { class: 'viewport jtree', tabindex: 0, role: 'tree', 'aria-label': 'JSON tree' }, this.canvas);
    this.viewport.addEventListener('scroll', () => this.renderRows());
    this.viewport.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('mousedown', (e) => this.onClick(e));
    this.list.addEventListener('dblclick', (e) => this.onDbl(e));
    this.list.addEventListener('contextmenu', (e) => this.onContext(e));
    new ResizeObserver(() => this.renderRows()).observe(this.viewport);

    this.crumbs = h('div', { class: 'crumbs' });
    this.treePane = h('div', { class: 'pane' }, this.results, this.viewport);
    this.tablePane = h('div', { class: 'pane', style: { display: 'none' } });
    this.graph.el.style.display = 'none';
    this.status = h('div', { class: 'status' });

    this.el.append(toolbar, h('div', { class: 'jv-body' }, this.treePane, this.graph.el, this.tablePane), h('div', { class: 'footer' }, this.crumbs, this.status));
    this.el.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'f' && this.mode !== 'table') {
        e.preventDefault();
        this.search.focus();
        this.search.select();
      } else if (k === 's' && !host.hostHandlesUndo) {
        e.preventDefault();
        this.opts.onSave?.();
      } else if ((k === 'z' || k === 'y') && !host.hostHandlesUndo && !this.editing && this.mode !== 'table') {
        e.preventDefault();
        k === 'y' || e.shiftKey ? this.redo() : this.undo();
      }
    });
    this.setMode('tree');
  }

  setMode(m: Mode) {
    this.mode = m;
    for (const [k, b] of Object.entries(this.segBtns)) b.classList.toggle('active', k === m);
    this.treePane.style.display = m === 'tree' ? '' : 'none';
    this.graph.el.style.display = m === 'graph' ? '' : 'none';
    this.tablePane.style.display = m === 'table' ? '' : 'none';
    if (m === 'graph') {
      this.graph.render(true);
      if (this.selected.length) setTimeout(() => this.graph.reveal(this.selected), 30);
    } else if (m === 'table') this.showTable();
    else {
      this.renderRows();
      this.viewport.focus();
    }
  }

  undo() {
    if (host.hostHandlesUndo) host.post({ type: 'command', id: 'undo' });
    else this.doc.undo();
  }
  redo() {
    if (host.hostHandlesUndo) host.post({ type: 'command', id: 'redo' });
    else this.doc.redo();
  }

  /* ======================================================== tree model */

  refresh() {
    this.flatten();
    if (this.search.value) this.runSearch(true);
    if (getAt(this.doc.value, this.selected) === undefined) this.selected = [];
    this.canvas.style.height = this.rows.length * RH + 'px';
    this.renderRows();
    this.renderCrumbs();
    const s = docStats(this.doc.value);
    this.status.textContent = `${s.nodes.toLocaleString()} nodes · depth ${s.depth} · ${s.objects.toLocaleString()} objects · ${s.arrays.toLocaleString()} arrays`;
    if (this.mode === 'graph') this.graph.render();
    if (this.mode === 'table') this.showTable();
  }

  private flatten() {
    const out: Row[] = [];
    const walk = (v: unknown, path: Path, key: string | number | null, depth: number) => {
      const container = !!v && typeof v === 'object';
      const open = container && this.expanded.has(pathId(path));
      out.push({ path, key, value: v, depth, open, container });
      if (!open) return;
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i], i, depth + 1));
      else for (const [k, x] of Object.entries(v as object)) walk(x, [...path, k], k, depth + 1);
    };
    walk(this.doc.value, [], null, 0);
    this.rows = out;
  }

  private expandToDepth(v: unknown, path: Path, depth: number, max = 2000) {
    let budget = max;
    const walk = (x: unknown, p: Path, d: number) => {
      if (!x || typeof x !== 'object' || d > depth || budget <= 0) return;
      this.expanded.add(pathId(p));
      const entries = Array.isArray(x) ? x.map((y, i) => [i, y] as const) : Object.entries(x);
      budget -= entries.length;
      if (entries.length > 200) return; // don't auto-expand children of huge containers
      for (const [k, y] of entries) walk(y, [...p, k], d + 1);
    };
    walk(v, path, 0);
  }

  expandAll() {
    this.expandToDepth(getAt(this.doc.value, this.mode === 'tree' && this.selected.length ? this.selected : []), this.selected, 6, 20000);
    this.refresh();
  }

  collapseAll() {
    this.expanded = new Set([pathId([])]);
    this.selected = this.selected.slice(0, 1);
    this.refresh();
  }

  private toggle(path: Path, open?: boolean) {
    const id = pathId(path);
    const willOpen = open ?? !this.expanded.has(id);
    if (willOpen) this.expanded.add(id);
    else this.expanded.delete(id);
    this.refresh();
  }

  reveal(path: Path) {
    for (let i = 0; i < path.length; i++) this.expanded.add(pathId(path.slice(0, i)));
    this.selected = path;
    this.refresh();
    const i = this.rows.findIndex((r) => pathId(r.path) === pathId(path));
    if (i >= 0) {
      const vp = this.viewport;
      if (i * RH < vp.scrollTop || i * RH > vp.scrollTop + vp.clientHeight - RH * 2) vp.scrollTop = Math.max(0, i * RH - vp.clientHeight / 3);
      this.renderRows();
    }
  }

  /* ======================================================== render */

  private renderRows() {
    if (this.mode !== 'tree') return;
    const vp = this.viewport;
    const first = Math.max(0, Math.floor(vp.scrollTop / RH) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((vp.scrollTop + vp.clientHeight) / RH) + OVERSCAN);
    const sel = pathId(this.selected);
    const current = this.matchIdx >= 0 ? pathId(this.matches[this.matchIdx]) : '';
    const q = this.searchText;
    let html = '';
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      const id = pathId(r.path);
      const t = typeOf(r.value);
      const keyHtml =
        r.key === null
          ? '<span class="j-root">root</span>'
          : typeof r.key === 'number'
            ? `<span class="j-index">${r.key}</span>`
            : `<span class="j-key">${hl(escapeHtml(r.key), q)}</span>`;
      let val: string;
      if (r.container) {
        const n = Array.isArray(r.value) ? r.value.length : Object.keys(r.value as object).length;
        const br = Array.isArray(r.value) ? ['[', ']'] : ['{', '}'];
        const preview = r.open ? '' : ` <span class="j-preview">${escapeHtml(preview1(r.value))}</span>`;
        val = `<span class="j-brace">${br[0]}</span><span class="j-count">${n} ${Array.isArray(r.value) ? (n === 1 ? 'item' : 'items') : n === 1 ? 'key' : 'keys'}</span><span class="j-brace">${br[1]}</span>${preview}`;
      } else {
        const s = t === 'string' ? JSON.stringify(r.value) : String(r.value);
        val = `<span class="j-${t}">${hl(escapeHtml(s.length > 400 ? s.slice(0, 400) + '…' : s), q)}</span>`;
        if (t === 'string' && /^#[0-9a-f]{3,8}$/i.test(r.value as string)) val = `<span class="swatch" style="background:${r.value}"></span>` + val;
        if (t === 'string' && /^https?:\/\//.test(r.value as string)) val += ' <span class="j-link" title="URL">↗</span>';
      }
      const tw = r.container ? `<span class="tw">${r.open ? '▾' : '▸'}</span>` : '<span class="tw"></span>';
      html += `<div class="jr${id === sel ? ' sel' : ''}${this.matchIds.has(id) ? ' match' : ''}${id === current ? ' current' : ''}" style="top:${i * RH}px;padding-left:${8 + r.depth * 16}px" data-i="${i}" role="treeitem" aria-expanded="${r.container ? r.open : ''}">${tw}${keyHtml}<span class="j-colon">:</span>${val}<span class="j-actions"><button data-act="copy" title="Copy value">⧉</button><button data-act="path" title="Copy path">$</button></span></div>`;
    }
    this.list.innerHTML = html;
  }

  private renderCrumbs() {
    const p = this.selected;
    const items: HTMLElement[] = [h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), this.reveal([])) }, '$')];
    p.forEach((k, i) => {
      items.push(h('span', { class: 'crumb-sep' }, typeof k === 'number' ? '' : '.'));
      items.push(h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), this.reveal(p.slice(0, i + 1))) }, typeof k === 'number' ? `[${k}]` : k));
    });
    const v = getAt(this.doc.value, p);
    this.crumbs.replaceChildren(
      ...items,
      h('span', { class: 'crumb-type' }, typeOf(v)),
      h('button', { class: 'btn icon-only small', title: 'Copy JSONPath', onclick: () => (host.copy(toJsonPath(p)), toast('Path copied', 'ok', 1200)) }, icon('copy', 12)),
    );
  }

  /* ======================================================== interaction */

  private rowAt(e: MouseEvent): Row | null {
    const el = (e.target as HTMLElement).closest('.jr') as HTMLElement | null;
    return el ? this.rows[+el.dataset.i!] : null;
  }

  private onClick(e: MouseEvent) {
    const r = this.rowAt(e);
    if (!r) return;
    const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
    if (act === 'copy') {
      e.preventDefault();
      host.copy(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
      return toast('Value copied', 'ok', 1200);
    }
    if (act === 'path') {
      e.preventDefault();
      host.copy(toJsonPath(r.path));
      return toast(toJsonPath(r.path), 'ok', 1500);
    }
    this.selected = r.path;
    if ((e.target as HTMLElement).classList.contains('tw') && r.container) {
      if (e.altKey) {
        if (r.open) this.expanded.forEach((id) => id.startsWith(pathId(r.path).slice(0, -1)) && this.expanded.delete(id));
        else this.expandToDepth(r.value, r.path, 10, 20000);
        this.refresh();
      } else this.toggle(r.path);
    } else {
      this.renderRows();
      this.renderCrumbs();
    }
    setTimeout(() => this.viewport.focus({ preventScroll: true }));
  }

  private onDbl(e: MouseEvent) {
    const r = this.rowAt(e);
    if (!r || this.opts.readonly) return;
    if ((e.target as HTMLElement).classList.contains('j-key')) return this.renameKey(r);
    if (!r.container) this.editValue(r);
    else this.toggle(r.path);
  }

  private onKey(e: KeyboardEvent) {
    if (this.editing) return;
    const i = this.rows.findIndex((r) => pathId(r.path) === pathId(this.selected));
    const r = this.rows[i];
    const go = (j: number) => {
      e.preventDefault();
      const t = this.rows[Math.max(0, Math.min(this.rows.length - 1, j))];
      if (t) this.reveal(t.path);
    };
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case 'ArrowDown':
        return go(i + 1);
      case 'ArrowUp':
        return go(i - 1);
      case 'PageDown':
        return go(i + Math.floor(this.viewport.clientHeight / RH));
      case 'PageUp':
        return go(i - Math.floor(this.viewport.clientHeight / RH));
      case 'Home':
        return go(0);
      case 'End':
        return go(this.rows.length - 1);
      case 'ArrowRight':
        e.preventDefault();
        if (r?.container && !r.open) this.toggle(r.path, true);
        else go(i + 1);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (r?.container && r.open) this.toggle(r.path, false);
        else if (this.selected.length) this.reveal(this.selected.slice(0, -1));
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (r && !this.opts.readonly) r.container ? this.toggle(r.path) : this.editValue(r);
        return;
      case 'Delete':
      case 'Backspace':
        if (r && r.path.length && !this.opts.readonly) {
          e.preventDefault();
          this.doc.remove(r.path);
        }
        return;
      case ' ':
        if (r?.container) {
          e.preventDefault();
          this.toggle(r.path);
        }
        return;
    }
    if (mod && e.key.toLowerCase() === 'c' && r) {
      e.preventDefault();
      host.copy(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
      toast('Value copied', 'ok', 1200);
    }
  }

  private inlineInput(r: Row, initial: string, target: 'key' | 'value', commit: (v: string) => void) {
    const i = this.rows.indexOf(r);
    const rowEl = this.list.querySelector(`.jr[data-i="${i}"]`) as HTMLElement | null;
    const anchor = rowEl?.querySelector(target === 'key' ? '.j-key' : '.j-colon') as HTMLElement | null;
    if (!rowEl || !anchor) return;
    this.editing = true;
    const inp = h('input', { class: 'j-edit', value: initial, spellcheck: false });
    const left = target === 'key' ? anchor.offsetLeft : anchor.offsetLeft + anchor.offsetWidth + 4;
    inp.style.left = left + 'px';
    inp.style.width = Math.max(160, rowEl.clientWidth - left - 16) + 'px';
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      inp.remove();
      if (ok && inp.value !== initial) commit(inp.value);
      else this.renderRows();
      this.viewport.focus({ preventScroll: true });
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
    rowEl.appendChild(inp);
    inp.focus();
    inp.select();
  }

  private editValue(r: Row) {
    const t = typeOf(r.value);
    this.inlineInput(r, t === 'string' ? (r.value as string) : JSON.stringify(r.value), 'value', (text) => this.doc.setValue(r.path, parseLiteral(text, t)));
  }

  private renameKey(r: Row) {
    if (typeof r.key !== 'string') return;
    this.inlineInput(r, r.key, 'key', (to) => {
      const parent = getAt(this.doc.value, r.path.slice(0, -1)) as Record<string, unknown>;
      if (to in parent) return toast(`Key "${to}" already exists`, 'error');
      this.doc.renameKey(r.path, to);
      this.selected = [...r.path.slice(0, -1), to];
    });
  }

  private async addChild(r: Row) {
    const isArr = Array.isArray(r.value);
    const f = await dialog(
      isArr ? 'Append item' : 'Add property',
      [
        ...(isArr ? [] : [{ key: 'key', label: 'Key', value: '' }]),
        { key: 'value', label: 'Value (JSON or text)', value: '""', type: 'textarea' as const, hint: 'e.g. 42, true, null, "text", {"a":1}, [1,2]' },
      ],
      'Add',
      (v) => (!isArr && !v.key ? 'Key is required' : !isArr && v.key in (r.value as object) ? 'Key already exists' : null),
    );
    if (!f) return;
    this.doc.insert(r.path, isArr ? null : f.key, parseLiteral(f.value));
    this.expanded.add(pathId(r.path));
    this.refresh();
  }

  private onContext(e: MouseEvent) {
    e.preventDefault();
    const r = this.rowAt(e);
    if (!r) return;
    this.selected = r.path;
    this.renderRows();
    this.renderCrumbs();
    const ro = !!this.opts.readonly;
    const parentPath = r.path.slice(0, -1);
    const parent = getAt(this.doc.value, parentPath);
    const tableable = r.container && jsonToSheet(r.value) !== null;
    const items: MenuEntry[] = [
      { label: 'Copy value', icon: 'copy', hint: '⌘C', action: () => host.copy(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2)) },
      { label: 'Copy minified', disabled: !r.container, action: () => host.copy(JSON.stringify(r.value)) },
      {
        label: 'Copy path',
        icon: 'link',
        submenu: [
          { label: `JSONPath  ${trunc(toJsonPath(r.path), 30)}`, action: () => host.copy(toJsonPath(r.path)) },
          { label: `JavaScript  ${trunc(toJsPath(r.path), 30)}`, action: () => host.copy(toJsPath(r.path)) },
          { label: `jq  ${trunc(toJqPath(r.path), 30)}`, action: () => host.copy(toJqPath(r.path)) },
        ],
      },
      '-',
      { label: 'Edit value', icon: 'edit', hint: 'Enter', disabled: ro || r.container, action: () => this.editValue(r) },
      { label: 'Rename key', disabled: ro || typeof r.key !== 'string', action: () => this.renameKey(r) },
      { label: Array.isArray(r.value) ? 'Append item…' : 'Add property…', icon: 'plus', disabled: ro || !r.container, action: () => this.addChild(r) },
      {
        label: 'Duplicate',
        icon: 'copy',
        disabled: ro || !r.path.length,
        action: () => {
          const k = r.path[r.path.length - 1];
          if (Array.isArray(parent)) this.doc.insert(parentPath, null, structuredClone(r.value), (k as number) + 1);
          else {
            let nk = `${k}_copy`;
            let i = 2;
            while (nk in (parent as object)) nk = `${k}_copy${i++}`;
            this.doc.insert(parentPath, nk, structuredClone(r.value), Object.keys(parent as object).indexOf(k as string) + 1);
          }
        },
      },
      {
        label: 'Change type',
        disabled: ro,
        submenu: [
          { label: 'String', action: () => this.doc.setValue(r.path, typeof r.value === 'string' ? r.value : JSON.stringify(r.value)) },
          { label: 'Number', action: () => this.doc.setValue(r.path, Number(r.value) || 0) },
          { label: 'Boolean', action: () => this.doc.setValue(r.path, !!r.value && r.value !== 'false') },
          { label: 'Null', action: () => this.doc.setValue(r.path, null) },
          { label: 'Object {}', action: () => this.doc.setValue(r.path, isObj(r.value) ? r.value : {}) },
          { label: 'Array []', action: () => this.doc.setValue(r.path, Array.isArray(r.value) ? r.value : r.value === null ? [] : [r.value]) },
          {
            label: 'Parse JSON string',
            disabled: typeof r.value !== 'string',
            action: () => {
              try {
                this.doc.setValue(r.path, JSON.parse(r.value as string));
              } catch {
                toast('Not valid JSON', 'error');
              }
            },
          },
        ],
      },
      { label: 'Sort keys A→Z', disabled: ro || !isObj(r.value), action: () => this.doc.sortKeys(r.path) },
      '-',
      { label: 'Expand all below', icon: 'expand', disabled: !r.container, action: () => (this.expandToDepth(r.value, r.path, 10, 20000), this.refresh()) },
      { label: 'Show in graph', icon: 'graph', action: () => (this.setMode('graph'), setTimeout(() => this.graph.reveal(r.path), 40)) },
      { label: 'Open as table', icon: 'table', disabled: !tableable, action: () => ((this.tablePath = r.path), this.setMode('table')) },
      { label: 'Export this node…', icon: 'export', action: () => this.exportValue(r.value, (typeof r.key === 'string' ? r.key : 'node') + '.json') },
      '-',
      { label: 'Delete', icon: 'trash', hint: '⌫', danger: true, disabled: ro || !r.path.length, action: () => this.doc.remove(r.path) },
    ];
    showMenu(e.clientX, e.clientY, items);
  }

  /* ======================================================== search & query */

  private runSearch(keepIndex = false) {
    const q = this.search.value.trim().toLowerCase();
    this.searchText = q;
    this.matches = [];
    this.matchIds.clear();
    if (q) {
      const walk = (v: unknown, p: Path, key: string | number | null) => {
        if (this.matches.length >= 5000) return;
        const keyHit = typeof key === 'string' && key.toLowerCase().includes(q);
        const valHit = (!v || typeof v !== 'object') && String(v).toLowerCase().includes(q);
        if (keyHit || valHit) this.matches.push(p);
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i], i));
        else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, [...p, k], k);
      };
      walk(this.doc.value, [], null);
      for (const m of this.matches) this.matchIds.add(pathId(m));
      // expand ancestors of the first 300 matches so they're visible
      for (const m of this.matches.slice(0, 300)) for (let i = 0; i < m.length; i++) this.expanded.add(pathId(m.slice(0, i)));
    }
    this.matchIdx = keepIndex ? Math.min(this.matchIdx, this.matches.length - 1) : this.matches.length ? 0 : -1;
    this.searchInfo.textContent = q ? (this.matches.length ? `${this.matchIdx + 1}/${this.matches.length >= 5000 ? '5000+' : this.matches.length}` : 'no match') : '';
    if (keepIndex) return;
    this.flatten();
    this.canvas.style.height = this.rows.length * RH + 'px';
    if (this.matchIdx >= 0) this.reveal(this.matches[0]);
    else this.renderRows();
  }

  private nextMatch(d: number) {
    if (!this.matches.length) return;
    this.matchIdx = (this.matchIdx + d + this.matches.length) % this.matches.length;
    this.searchInfo.textContent = `${this.matchIdx + 1}/${this.matches.length}`;
    this.reveal(this.matches[this.matchIdx]);
  }

  private runQuery() {
    const q = this.query.value.trim();
    if (!q) {
      this.results.style.display = 'none';
      return;
    }
    let res: Match[];
    try {
      res = evaluate(this.doc.value, q, 2000);
    } catch (e) {
      this.results.style.display = '';
      this.results.replaceChildren(h('div', { class: 'res-head err' }, (e as Error).message));
      return;
    }
    if (this.mode !== 'tree') this.setMode('tree');
    const close = btn(null, 'close', () => (this.results.style.display = 'none'), { title: 'Close results' });
    const values = res.map((m) => m.value);
    this.results.style.display = '';
    this.results.replaceChildren(
      h(
        'div',
        { class: 'res-head' },
        h('b', null, `${res.length.toLocaleString()} result${res.length === 1 ? '' : 's'}`),
        h('span', { class: 'muted' }, ` for ${q}`),
        h('div', { class: 'spacer' }),
        btn('Copy JSON', 'copy', () => (host.copy(JSON.stringify(values, null, 2)), toast('Results copied', 'ok'))),
        jsonToSheet(values) ? btn('As table', 'table', () => this.showTable(values, `query: ${q}`)) : null,
        close,
      ),
      h(
        'div',
        { class: 'res-list' },
        ...res.slice(0, 300).map((m) =>
          h(
            'div',
            { class: 'res-item', onclick: () => this.reveal(m.path), title: 'Reveal in tree' },
            h('span', { class: 'res-path' }, toJsonPath(m.path)),
            h('span', { class: `j-${typeOf(m.value)}` }, trunc(m.value && typeof m.value === 'object' ? preview1(m.value) : JSON.stringify(m.value) ?? '', 80)),
          ),
        ),
        res.length > 300 ? h('div', { class: 'muted small' }, `…and ${res.length - 300} more`) : null,
      ),
    );
  }

  /* ======================================================== table mode */

  private showTable(values?: unknown, label?: string) {
    if (values !== undefined) {
      this.tablePath = null;
      this.mode = 'table';
      for (const [k, b] of Object.entries(this.segBtns)) b.classList.toggle('active', k === 'table');
      this.treePane.style.display = 'none';
      this.graph.el.style.display = 'none';
      this.tablePane.style.display = '';
    }
    const candidates = findArrays(this.doc.value);
    let path = this.tablePath;
    if (values === undefined) {
      const selV = getAt(this.doc.value, this.selected);
      if (!path && this.selected.length && selV && typeof selV === 'object' && jsonToSheet(selV)) path = this.selected;
      if (!path) path = jsonToSheet(this.doc.value) ? [] : candidates[0]?.path ?? [];
      this.tablePath = path;
    }
    const v = values !== undefined ? values : getAt(this.doc.value, path!);
    const sheet = jsonToSheet(v, label || toJsonPath(path || []));

    const picker = h(
      'select',
      {
        class: 'table-picker',
        title: 'Which array to show as a table',
        onchange: () => {
          this.tablePath = JSON.parse(picker.value);
          this.tableView = null;
          this.showTable();
        },
      },
      ...(values !== undefined ? [h('option', { value: 'null', selected: true }, label || 'query result')] : []),
      ...(jsonToSheet(this.doc.value) && !candidates.some((c) => !c.path.length) ? [h('option', { value: '[]', selected: path?.length === 0 }, `$ (root)`)] : []),
      ...candidates.map((c) => h('option', { value: JSON.stringify(c.path), selected: values === undefined && pathId(c.path) === pathId(path || []) }, `${toJsonPath(c.path)}  (${c.length.toLocaleString()})`)),
    );

    if (!sheet) {
      this.tablePane.replaceChildren(
        h('div', { class: 'empty-state big' }, icon('table', 28), h('p', null, 'No array of objects found here.'), h('p', { class: 'muted' }, 'Select an array in the tree, then choose Table — or pick one below.'), picker),
      );
      return;
    }
    const tdoc = new TableDoc([sheet], 'csv', { delimiter: ',', eol: '\n', bom: false, hasHeader: true });
    const prefix = h('div', { class: 'tbl-prefix' }, icon('table', 14), picker);
    this.tableView = new TableView(tdoc, {
      readonly: true,
      toolbarPrefix: prefix,
      onExport: (fmt: ExportFormat, which) => {
        const rows = which === 'view' ? this.tableView!.viewRows() : sheet.rows;
        const base = this.opts.fileName.replace(/\.[^.]+$/, '');
        this.opts.onExport?.(`${base}.${fmt === 'md' ? 'md' : fmt}`, exportSheet(tdoc, fmt, sheet, rows));
      },
    });
    this.tablePane.replaceChildren(this.tableView.el);
  }

  /* ======================================================== export */

  private exportMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const v = this.doc.value;
    const base = this.opts.fileName.replace(/\.[^.]+$/, '');
    const sheet = jsonToSheet(v);
    showMenu(r.right - 220, r.bottom + 2, [
      { label: 'Pretty JSON (2 spaces)…', action: () => this.opts.onExport?.(`${base}.pretty.json`, encodeText(JSON.stringify(v, null, 2) + '\n')) },
      { label: 'Minified JSON…', action: () => this.opts.onExport?.(`${base}.min.json`, encodeText(JSON.stringify(v))) },
      { label: 'JSON Lines…', disabled: !Array.isArray(v), action: () => this.opts.onExport?.(`${base}.jsonl`, encodeText((v as unknown[]).map((x) => JSON.stringify(x)).join('\n') + '\n')) },
      '-',
      { label: 'CSV (flattened)…', disabled: !sheet, action: () => this.exportTable('csv') },
      { label: 'Excel (.xlsx)…', disabled: !sheet, action: () => this.exportTable('xlsx') },
      '-',
      { label: 'Copy pretty JSON', icon: 'copy', action: () => (host.copy(JSON.stringify(v, null, 2)), toast('Copied', 'ok')) },
      { label: 'Copy minified JSON', icon: 'copy', action: () => (host.copy(JSON.stringify(v)), toast('Copied', 'ok')) },
      { label: 'Copy TypeScript types', icon: 'copy', action: () => (host.copy(toTypeScript(v)), toast('Types copied', 'ok')) },
    ]);
  }

  private exportTable(fmt: ExportFormat) {
    const sheet = jsonToSheet(this.doc.value)!;
    const tdoc = new TableDoc([sheet], 'csv', { delimiter: ',', eol: '\n', bom: false, hasHeader: true });
    this.opts.onExport?.(this.opts.fileName.replace(/\.[^.]+$/, '') + '.' + fmt, exportSheet(tdoc, fmt, sheet));
  }

  private exportValue(v: unknown, name: string) {
    this.opts.onExport?.(name, encodeText(JSON.stringify(v, null, 2) + '\n'));
  }
}

function preview1(v: unknown): string {
  if (Array.isArray(v)) {
    const s = v.slice(0, 5).map((x) => (x && typeof x === 'object' ? (Array.isArray(x) ? '[…]' : '{…}') : JSON.stringify(x))).join(', ');
    return `[${s}${v.length > 5 ? ', …' : ''}]`;
  }
  if (isObj(v)) {
    const ks = Object.keys(v);
    const s = ks
      .slice(0, 4)
      .map((k) => {
        const x = v[k];
        return `${k}: ${x && typeof x === 'object' ? (Array.isArray(x) ? '[…]' : '{…}') : trunc(JSON.stringify(x) ?? '', 20)}`;
      })
      .join(', ');
    return `{${s}${ks.length > 4 ? ', …' : ''}}`;
  }
  return JSON.stringify(v) ?? '';
}

function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function hl(escaped: string, q: string) {
  if (!q) return escaped;
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

/** Infer TypeScript interfaces from a JSON sample. */
function toTypeScript(v: unknown): string {
  const decls: string[] = [];
  const names = new Set<string>();
  const pascal = (s: string) => {
    let n = s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase()) || 'Item';
    if (/^\d/.test(n)) n = 'T' + n;
    let u = n;
    let i = 2;
    while (names.has(u)) u = n + i++;
    names.add(u);
    return u;
  };
  const typeOfV = (x: unknown, name: string): string => {
    if (x === null) return 'null';
    if (Array.isArray(x)) {
      if (!x.length) return 'unknown[]';
      if (x.every(isObj)) {
        const merged: Record<string, unknown[]> = {};
        for (const o of x as Record<string, unknown>[]) for (const [k, y] of Object.entries(o)) (merged[k] ||= []).push(y);
        const n = pascal(name.replace(/s$/, ''));
        emit(n, merged, x.length);
        return `${n}[]`;
      }
      const ts = [...new Set(x.map((y) => typeOfV(y, name)))];
      return ts.length === 1 ? `${ts[0]}[]` : `(${ts.join(' | ')})[]`;
    }
    if (isObj(x)) {
      const n = pascal(name);
      emit(n, Object.fromEntries(Object.entries(x).map(([k, y]) => [k, [y]])), 1);
      return n;
    }
    return typeof x;
  };
  const emit = (n: string, fields: Record<string, unknown[]>, total: number) => {
    const lines = Object.entries(fields).map(([k, vals]) => {
      const ts = [...new Set(vals.map((y) => typeOfV(y, k)))];
      const opt = vals.length < total ? '?' : '';
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      return `  ${key}${opt}: ${ts.join(' | ')};`;
    });
    decls.push(`export interface ${n} {\n${lines.join('\n')}\n}`);
  };
  const root = typeOfV(v, 'Root');
  if (!isObj(v)) decls.push(`export type Root = ${root};`);
  return decls.reverse().join('\n\n') + '\n';
}
