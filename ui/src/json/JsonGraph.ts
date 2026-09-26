/**
 * Node-link graph of a JSON document. Objects/arrays become cards; primitive
 * fields render inside their parent card, nested containers become child cards.
 * Pan by dragging, zoom with wheel / pinch, click a card's ▸ to expand/collapse.
 */
import { Path, pathId, isObj, typeOf, getAt, toJsonPath } from './JsonDoc';
import { h, btn, escapeHtml } from '../dom';

const CARD_W = 240;
const ROW_H = 18;
const HEAD_H = 24;
const GAP_X = 70;
const GAP_Y = 14;
const MAX_FIELDS = 12;
const PAGE = 12;
const MAX_NODES = 1500;

interface GNode {
  path: Path;
  label: string;
  value: unknown;
  fields: Array<[string, unknown]>;
  more: number;
  kids: GNode[];
  hiddenKids: number;
  collapsed: boolean;
  x: number;
  y: number;
  h: number;
  subtreeH: number;
}

export class JsonGraph {
  el: HTMLElement;
  private svg: SVGSVGElement;
  private g: SVGGElement;
  private collapsed = new Set<string>();
  private expanded = new Set<string>();
  private tx = 20;
  private ty = 20;
  private k = 1;
  private root: GNode | null = null;
  private count = 0;
  private info: HTMLElement;
  selected: string | null = null;
  private defaultDepth = 2;
  private limits = new Map<string, number>();

  constructor(private getValue: () => unknown, private onReveal: (p: Path) => void) {
    const ns = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(ns, 'svg') as SVGSVGElement;
    this.svg.setAttribute('class', 'graph-svg');
    this.g = document.createElementNS(ns, 'g') as SVGGElement;
    this.svg.appendChild(this.g);
    this.info = h('span', { class: 'muted small' });
    this.el = h(
      'div',
      { class: 'graph' },
      h(
        'div',
        { class: 'graph-tools' },
        btn(null, 'plus', () => this.zoomBy(1.2), { title: 'Zoom in' }),
        btn(null, 'minus', () => this.zoomBy(1 / 1.2), { title: 'Zoom out' }),
        btn('Fit', 'target', () => this.fit(), { title: 'Fit to view' }),
        btn('Expand level', 'expand', () => this.expandLevel(), { title: 'Expand one more level' }),
        btn('Collapse all', 'collapse', () => this.collapseAll()),
        this.info,
      ),
      this.svg,
    );
    this.bindPanZoom();
  }

  render(reset = false) {
    this.count = 0;
    this.root = this.build(this.getValue(), [], '$', 0);
    this.layout(this.root, 0, 0);
    this.draw();
    this.info.textContent = `${this.count.toLocaleString()} nodes${this.count >= MAX_NODES ? ' (limit reached — collapse branches)' : ''}`;
    if (reset) requestAnimationFrame(() => this.fit());
  }

  reveal(path: Path) {
    for (let i = 0; i <= path.length; i++) {
      const id = pathId(path.slice(0, i));
      this.collapsed.delete(id);
      this.expanded.add(id);
    }
    this.selected = pathId(nearestContainer(this.getValue(), path));
    this.render();
    const node = this.find(this.root, this.selected);
    if (node) this.centerOn(node);
  }

  private isCollapsed(p: Path, depth: number) {
    const id = pathId(p);
    if (this.collapsed.has(id)) return true;
    if (this.expanded.has(id)) return false;
    return depth >= this.defaultDepth;
  }

  private build(v: unknown, path: Path, label: string, depth: number): GNode {
    this.count++;
    const node: GNode = { path, label, value: v, fields: [], more: 0, kids: [], hiddenKids: 0, collapsed: this.isCollapsed(path, depth), x: 0, y: 0, h: 0, subtreeH: 0 };
    const entries: Array<[string, unknown, string | number]> = Array.isArray(v) ? v.map((x, i) => [`[${i}]`, x, i]) : isObj(v) ? Object.entries(v).map(([k, x]) => [k, x, k]) : [];
    const prims = entries.filter(([, x]) => !x || typeof x !== 'object');
    const conts = entries.filter(([, x]) => x && typeof x === 'object');
    node.fields = prims.slice(0, MAX_FIELDS).map(([k, x]) => [k, x]);
    node.more = Math.max(0, prims.length - MAX_FIELDS);
    // containers show as lines in the card too (with summary) when collapsed
    if (node.collapsed || this.count >= MAX_NODES) {
      node.hiddenKids = conts.length;
      node.collapsed = conts.length > 0;
    } else {
      const limit = this.limits.get(pathId(path)) ?? PAGE;
      for (const [k, x, key] of conts.slice(0, limit)) {
        if (this.count >= MAX_NODES) {
          node.hiddenKids++;
          continue;
        }
        node.kids.push(this.build(x, [...path, key], k, depth + 1));
      }
      node.hiddenKids += Math.max(0, conts.length - limit);
    }
    const lines = node.fields.length + (node.more ? 1 : 0) + (node.hiddenKids ? 1 : 0) + (!node.fields.length && !node.kids.length && !node.hiddenKids ? 1 : 0);
    node.h = HEAD_H + Math.max(1, lines) * ROW_H + 8;
    return node;
  }

  private layout(n: GNode, depth: number, top: number): number {
    n.x = depth * (CARD_W + GAP_X);
    if (!n.kids.length) {
      n.y = top;
      n.subtreeH = n.h;
      return n.h;
    }
    let y = top;
    for (const c of n.kids) y += this.layout(c, depth + 1, y) + GAP_Y;
    const kidsH = y - top - GAP_Y;
    n.subtreeH = Math.max(n.h, kidsH);
    // center the parent against its children
    const first = n.kids[0];
    const last = n.kids[n.kids.length - 1];
    n.y = Math.max(top, (first.y + last.y + last.h) / 2 - n.h / 2);
    return n.subtreeH;
  }

  private draw() {
    const edges: string[] = [];
    const cards: string[] = [];
    const walk = (n: GNode) => {
      for (const c of n.kids) {
        const x1 = n.x + CARD_W;
        const y1 = n.y + HEAD_H / 2 + 2;
        const x2 = c.x;
        const y2 = c.y + HEAD_H / 2 + 2;
        const mx = (x1 + x2) / 2;
        edges.push(`<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`);
        walk(c);
      }
      cards.push(this.card(n));
    };
    if (this.root) walk(this.root);
    this.g.innerHTML = edges.join('') + cards.join('');
    this.applyTransform();
  }

  private card(n: GNode) {
    const id = pathId(n.path);
    const t = typeOf(n.value);
    const size = Array.isArray(n.value) ? `${n.value.length} items` : isObj(n.value) ? `${Object.keys(n.value).length} keys` : t;
    const toggle = n.kids.length || n.hiddenKids ? `<text class="g-toggle" x="${CARD_W - 16}" y="16" data-toggle="${escapeHtml(id)}">${n.collapsed ? '▸' : '▾'}</text>` : '';
    let rows = '';
    let y = HEAD_H + 14;
    for (const [k, v] of n.fields) {
      const vt = typeOf(v);
      const vs = vt === 'string' ? JSON.stringify(v) : String(v);
      rows += `<text x="10" y="${y}" class="g-row"><tspan class="g-key">${escapeHtml(trunc(k, 16))}</tspan><tspan class="g-colon">: </tspan><tspan class="j-${vt}">${escapeHtml(trunc(vs, 30 - Math.min(16, k.length)))}</tspan></text>`;
      y += ROW_H;
    }
    if (n.more) {
      rows += `<text x="10" y="${y}" class="g-row muted">+ ${n.more} more fields</text>`;
      y += ROW_H;
    }
    if (n.hiddenKids && n.collapsed) {
      rows += `<text x="10" y="${y}" class="g-row g-more" data-toggle="${escapeHtml(id)}">▸ ${n.hiddenKids} nested ${n.hiddenKids === 1 ? 'object' : 'objects'}</text>`;
      y += ROW_H;
    } else if (n.hiddenKids) {
      rows += `<text x="10" y="${y}" class="g-row g-more" data-more="${escapeHtml(id)}">+ ${n.hiddenKids} more — show ${Math.min(PAGE, n.hiddenKids)}</text>`;
      y += ROW_H;
    } else if (!n.fields.length && !n.kids.length) {
      rows += `<text x="10" y="${y}" class="g-row muted">${Array.isArray(n.value) || isObj(n.value) ? 'empty' : escapeHtml(trunc(JSON.stringify(n.value), 34))}</text>`;
    }
    return `<g class="g-card ${this.selected === id ? 'sel' : ''} g-${t}" transform="translate(${n.x},${n.y})" data-id="${escapeHtml(id)}">
      <rect class="g-box" width="${CARD_W}" height="${n.h}" rx="6"/>
      <rect class="g-head" width="${CARD_W}" height="${HEAD_H}" rx="6"/><rect class="g-head" y="${HEAD_H - 6}" width="${CARD_W}" height="6"/>
      <text x="10" y="16" class="g-title">${escapeHtml(trunc(n.label, 22))}</text>
      <text x="${CARD_W - 24}" y="16" class="g-size" text-anchor="end">${size}</text>
      ${toggle}${rows}
      <title>${escapeHtml(toJsonPath(n.path))} — double-click to show in tree</title></g>`;
  }

  private find(n: GNode | null, id: string): GNode | null {
    if (!n) return null;
    if (pathId(n.path) === id) return n;
    for (const c of n.kids) {
      const f = this.find(c, id);
      if (f) return f;
    }
    return null;
  }

  private toggle(id: string) {
    const p = JSON.parse(id) as Path;
    const node = this.find(this.root, id);
    const wasCollapsed = node ? node.collapsed : this.isCollapsed(p, p.length);
    if (wasCollapsed) {
      this.collapsed.delete(id);
      this.expanded.add(id);
    } else {
      this.expanded.delete(id);
      this.collapsed.add(id);
    }
    this.render();
  }

  private expandLevel() {
    const walk = (n: GNode) => {
      if (n.collapsed) {
        this.collapsed.delete(pathId(n.path));
        this.expanded.add(pathId(n.path));
      } else n.kids.forEach(walk);
    };
    if (this.root) walk(this.root);
    this.render();
  }

  private collapseAll() {
    this.expanded.clear();
    this.collapsed.clear();
    this.defaultDepth = 1;
    this.render(true);
  }

  /* ---------------------------------------------------------- pan & zoom */

  private applyTransform() {
    this.g.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.k})`);
  }

  private zoomBy(f: number, cx?: number, cy?: number) {
    const r = this.svg.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const nk = Math.max(0.1, Math.min(3, this.k * f));
    this.tx = px - ((px - this.tx) * nk) / this.k;
    this.ty = py - ((py - this.ty) * nk) / this.k;
    this.k = nk;
    this.applyTransform();
  }

  fit() {
    if (!this.root) return;
    const bb = this.g.getBBox();
    const r = this.svg.getBoundingClientRect();
    if (!bb.width || !r.width) return;
    // Never shrink below a legible zoom; tall trees start at the top instead.
    this.k = Math.max(0.55, Math.min(1.1, Math.min((r.width - 40) / bb.width, (r.height - 60) / bb.height)));
    this.tx = 20 - bb.x * this.k;
    this.ty = Math.max(56, (r.height - bb.height * this.k) / 2) - bb.y * this.k;
    this.applyTransform();
  }

  private centerOn(n: GNode) {
    const r = this.svg.getBoundingClientRect();
    this.k = Math.max(this.k, 0.8);
    this.tx = r.width / 2 - (n.x + CARD_W / 2) * this.k;
    this.ty = r.height / 2 - (n.y + n.h / 2) * this.k;
    this.applyTransform();
  }

  private bindPanZoom() {
    let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else {
        this.tx -= e.deltaX;
        this.ty -= e.deltaY;
        this.applyTransform();
      }
    }, { passive: false });
    this.svg.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
      this.svg.classList.add('panning');
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.tx = drag.tx + dx;
      this.ty = drag.ty + dy;
      this.applyTransform();
    });
    window.addEventListener('mouseup', (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      this.svg.classList.remove('panning');
      if (moved) return;
      const more = (e.target as Element).closest?.('[data-more]');
      if (more) {
        const id = more.getAttribute('data-more')!;
        this.limits.set(id, (this.limits.get(id) ?? PAGE) + PAGE);
        return this.render();
      }
      const t = (e.target as Element).closest?.('[data-toggle]');
      if (t) return this.toggle(t.getAttribute('data-toggle')!);
      const card = (e.target as Element).closest?.('.g-card');
      if (card) {
        this.selected = card.getAttribute('data-id');
        this.g.querySelectorAll('.g-card.sel').forEach((c) => c.classList.remove('sel'));
        card.classList.add('sel');
      }
    });
    this.svg.addEventListener('dblclick', (e) => {
      const card = (e.target as Element).closest?.('.g-card');
      if (card) this.onReveal(JSON.parse(card.getAttribute('data-id')!));
    });
  }
}

function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}

function nearestContainer(root: unknown, p: Path): Path {
  for (let i = p.length; i >= 0; i--) {
    const v = getAt(root, p.slice(0, i));
    if (v && typeof v === 'object') return p.slice(0, i);
  }
  return [];
}
