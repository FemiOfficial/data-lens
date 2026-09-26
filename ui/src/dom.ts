/** Minimal DOM helpers: element builder, context menus, modal prompts, toasts. */

type Attrs = Record<string, any> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/* Codicon-free inline SVG icons (so they work in JetBrains / browser too). */
const P: Record<string, string> = {
  undo: 'M4 7h7a4 4 0 010 8H8M4 7l3-3M4 7l3 3',
  redo: 'M16 7H9a4 4 0 000 8h3M16 7l-3-3m3 3l-3 3',
  filter: 'M3 4h14l-5.5 6.5V16l-3-1.5v-4z',
  search: 'M8.5 3a5.5 5.5 0 104.2 9.1L17 16.5M13 8.5A4.5 4.5 0 118.5 4',
  chart: 'M3 17h14M5 14V9m4 5V5m4 9v-6m4 6V7',
  stats: 'M3 3v14h14M6 13l3-4 3 2 4-6',
  wand: 'M4 16L14 6m-2-2l4 4M15 2v2m2 1h-2M3 7v2m1-1H2',
  save: 'M4 3h9l3 3v11H4zM7 3v4h6V3M7 17v-5h6v5',
  export: 'M10 3v10m0-10l-4 4m4-4l4 4M4 13v4h12v-4',
  plus: 'M10 4v12M4 10h12',
  minus: 'M4 10h12',
  close: 'M5 5l10 10M15 5L5 15',
  menu: 'M6 8l4 4 4-4',
  sortAsc: 'M10 15V5m0 0l-4 4m4-4l4 4',
  sortDesc: 'M10 5v10m0 0l-4-4m4 4l4-4',
  copy: 'M7 7h9v10H7zM4 13V3h9',
  tree: 'M4 4h5v4H4zM11 12h5v4h-5zM6.5 8v6H11',
  graph: 'M5 10a2 2 0 100-.01M15 5a2 2 0 100-.01M15 15a2 2 0 100-.01M7 9l6-3M7 11l6 3',
  table: 'M3 4h14v12H3zM3 8h14M3 12h14M8 4v12',
  expand: 'M4 8l6 6 6-6',
  collapse: 'M4 12l6-6 6 6',
  columns: 'M3 4h14v12H3zM8 4v12M12 4v12',
  header: 'M3 4h14v4H3zM3 8h14v8H3z',
  sheet: 'M4 3h9l3 3v11H4z',
  eye: 'M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5zm8-2a2 2 0 100 4 2 2 0 000-4',
  edit: 'M4 16l1-4 8-8 3 3-8 8zM12 5l3 3',
  trash: 'M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11',
  pin: 'M10 3l4 4-2 1-2 4-4-4 4-2zM7 13l-4 4',
  link: 'M8 12l4-4M7 9l-2 2a3 3 0 004 4l2-2m0-6l2-2a3 3 0 00-4-4l-2 2',
  target: 'M10 3v4m0 6v4M3 10h4m6 0h4M10 7a3 3 0 100 6 3 3 0 000-6',
};

export function icon(name: keyof typeof P | string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', P[name] || P.menu);
  svg.appendChild(path);
  return svg;
}

export function btn(label: string | null, iconName: string | null, onclick: (e: MouseEvent) => void, opts: { title?: string; cls?: string; primary?: boolean } = {}) {
  return h(
    'button',
    { class: `btn ${label ? '' : 'icon-only'} ${opts.primary ? 'primary' : ''} ${opts.cls || ''}`, title: opts.title || label || '', onclick },
    iconName ? icon(iconName) : null,
    label ? h('span', null, label) : null,
  );
}

/* ---------------------------------------------------------------- menus */

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  action?: () => void;
  disabled?: boolean;
  danger?: boolean;
  submenu?: MenuItem[];
}
export type MenuEntry = MenuItem | '-';

let openMenu: HTMLElement | null = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

export function showMenu(x: number, y: number, items: MenuEntry[]) {
  closeMenu();
  const menu = buildMenu(items);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  openMenu = menu;
  (menu.querySelector('.menu-item:not(.disabled)') as HTMLElement | null)?.focus();
}

function buildMenu(items: MenuEntry[]): HTMLElement {
  const menu = h('div', { class: 'menu', role: 'menu', tabindex: -1 });
  menu.addEventListener('keydown', (e) => {
    const all = [...menu.querySelectorAll<HTMLElement>(':scope > .menu-item:not(.disabled)')];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') all[(i + 1) % all.length]?.focus();
    else if (e.key === 'ArrowUp') all[(i - 1 + all.length) % all.length]?.focus();
    else if (e.key === 'Escape') closeMenu();
    else if (e.key === 'Enter') (document.activeElement as HTMLElement)?.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  for (const it of items) {
    if (it === '-') {
      menu.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    const el = h(
      'div',
      { class: `menu-item ${it.disabled ? 'disabled' : ''} ${it.danger ? 'danger' : ''}`, role: 'menuitem', tabindex: -1 },
      h('span', { class: 'menu-icon' }, it.icon ? icon(it.icon, 14) : null),
      h('span', { class: 'menu-label' }, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
      it.submenu ? h('span', { class: 'menu-hint' }, '›') : null,
    );
    if (it.submenu) {
      let sub: HTMLElement | null = null;
      const open = () => {
        if (sub) return;
        sub = buildMenu(it.submenu!);
        sub.classList.add('submenu');
        el.appendChild(sub);
        const r = sub.getBoundingClientRect();
        if (r.right > window.innerWidth) sub.style.left = `-${r.width}px`;
        if (r.bottom > window.innerHeight) sub.style.top = `${window.innerHeight - r.bottom}px`;
      };
      el.addEventListener('mouseenter', open);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        open();
      });
      el.addEventListener('mouseleave', () => {
        sub?.remove();
        sub = null;
      });
    } else if (!it.disabled) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        it.action?.();
      });
    }
    menu.appendChild(el);
  }
  return menu;
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
});
window.addEventListener('blur', closeMenu);

/* --------------------------------------------------------------- dialogs */

export interface Field {
  key: string;
  label: string;
  type?: 'text' | 'select' | 'checkbox' | 'textarea' | 'note';
  value?: string | boolean;
  options?: Array<string | [string, string]>;
  placeholder?: string;
  hint?: string;
}

/** Modal form (window.prompt is unavailable inside VS Code webviews). Resolves null on cancel. */
export function dialog(title: string, fields: Field[], okLabel = 'OK', validate?: (v: Record<string, any>) => string | null): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    const inputs: Record<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = {};
    const err = h('div', { class: 'dlg-error' });
    const values = () => {
      const o: Record<string, any> = {};
      for (const f of fields) if (f.type !== 'note') o[f.key] = f.type === 'checkbox' ? (inputs[f.key] as HTMLInputElement).checked : inputs[f.key].value;
      return o;
    };
    const done = (ok: boolean) => {
      if (ok && validate) {
        const m = validate(values());
        if (m) {
          err.textContent = m;
          return;
        }
      }
      overlay.remove();
      resolve(ok ? values() : null);
    };
    const body = fields.map((f) => {
      let input: any;
      if (f.type === 'note') return h('p', { class: 'dlg-note' }, f.label);
      if (f.type === 'select') {
        input = h('select', null, ...(f.options || []).map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
        if (f.value !== undefined) input.value = String(f.value);
      } else if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox' });
        input.checked = !!f.value;
        inputs[f.key] = input;
        return h('label', { class: 'dlg-check' }, input, f.label);
      } else if (f.type === 'textarea') {
        input = h('textarea', { rows: 3, placeholder: f.placeholder || '', spellcheck: false });
        input.value = String(f.value ?? '');
      } else {
        input = h('input', { type: 'text', placeholder: f.placeholder || '', spellcheck: false });
        input.value = String(f.value ?? '');
      }
      inputs[f.key] = input;
      return h('label', { class: 'dlg-field' }, h('span', null, f.label), input, f.hint ? h('small', null, f.hint) : null);
    });
    const overlay = h(
      'div',
      { class: 'overlay', onmousedown: (e: MouseEvent) => e.target === overlay && done(false) },
      h(
        'form',
        {
          class: 'dialog',
          onsubmit: (e: Event) => {
            e.preventDefault();
            done(true);
          },
          onkeydown: (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Escape') done(false);
          },
        },
        h('div', { class: 'dlg-title' }, title),
        ...body,
        err,
        h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, okLabel)),
      ),
    );
    document.body.appendChild(overlay);
    const first = Object.values(inputs)[0];
    setTimeout(() => {
      if (!first) (overlay.querySelector('button[type=submit]') as HTMLElement)?.focus();
      first?.focus();
      if (first instanceof HTMLInputElement) first.select();
    });
  });
}

export async function confirmDialog(title: string, message: string, ok = 'Continue') {
  return !!(await dialog(title, [{ key: 'msg', label: message, type: 'note' }], ok));
}

/* ---------------------------------------------------------------- toasts */

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 2600) {
  let wrap = document.querySelector('.toasts');
  if (!wrap) document.body.appendChild((wrap = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })));
  const t = h('div', { class: `toast ${kind}` }, msg);
  wrap.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: any;
  return ((...a: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
