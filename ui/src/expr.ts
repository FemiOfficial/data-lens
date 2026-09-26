/**
 * Tiny, sandboxed formula language for computed columns & row filters.
 * No eval — webview CSP stays strict.
 *
 *   price * qty                    [Unit Price] * 1.075
 *   upper(first_name) & " " & last_name
 *   if(score >= 50, "pass", "fail")
 *   round(total / count, 2)        contains(email, "@gmail")
 */
import { Cell, toNum, cellText } from './model';

type Tok = { t: 'num' | 'str' | 'id' | 'col' | 'op' | 'eof'; v: string };
type Node =
  | { k: 'lit'; v: Cell }
  | { k: 'col'; i: number }
  | { k: 'row' }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; f: string; args: Node[] };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new Error('Unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (ch === '[' || ch === '`') {
      const close = ch === '[' ? ']' : '`';
      const j = src.indexOf(close, i + 1);
      if (j < 0) throw new Error(`Missing ${close}`);
      out.push({ t: 'col', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_À-￿][\wÀ-￿.]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(==|!=|<>|<=|>=|&&|\|\||[-+*/%^<>=!&(),])/.exec(src.slice(i));
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new Error(`Unexpected "${ch}"`);
  }
  out.push({ t: 'eof', v: '' });
  return out;
}

const FUNCS: Record<string, (...a: Cell[]) => Cell> = {
  upper: (s) => cellText(s).toUpperCase(),
  lower: (s) => cellText(s).toLowerCase(),
  title: (s) => cellText(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
  trim: (s) => cellText(s).trim(),
  len: (s) => cellText(s).length,
  left: (s, n) => cellText(s).slice(0, num(n)),
  right: (s, n) => cellText(s).slice(-num(n) || cellText(s).length),
  mid: (s, a, n) => cellText(s).substr(num(a) - 1, n == null ? undefined : num(n)),
  replace: (s, a, b) => cellText(s).split(cellText(a)).join(cellText(b)),
  regex: (s, p, g) => {
    const m = new RegExp(cellText(p)).exec(cellText(s));
    return m ? m[g == null ? 0 : num(g)] ?? null : null;
  },
  split: (s, d, i) => cellText(s).split(cellText(d))[num(i ?? 0)] ?? null,
  concat: (...a) => a.map(cellText).join(''),
  contains: (s, x) => cellText(s).toLowerCase().includes(cellText(x).toLowerCase()),
  startswith: (s, x) => cellText(s).startsWith(cellText(x)),
  endswith: (s, x) => cellText(s).endsWith(cellText(x)),
  isempty: (s) => s === null || cellText(s).trim() === '',
  coalesce: (...a) => a.find((x) => x !== null && cellText(x) !== '') ?? null,
  if: (c, a, b) => (truthy(c) ? a : b ?? null),
  num: (s) => toNum(s),
  str: (s) => cellText(s),
  round: (x, n) => {
    const p = Math.pow(10, num(n ?? 0));
    return Math.round(num(x) * p) / p;
  },
  floor: (x) => Math.floor(num(x)),
  ceil: (x) => Math.ceil(num(x)),
  abs: (x) => Math.abs(num(x)),
  sqrt: (x) => Math.sqrt(num(x)),
  pow: (x, y) => Math.pow(num(x), num(y)),
  log: (x) => Math.log(num(x)),
  exp: (x) => Math.exp(num(x)),
  min: (...a) => Math.min(...a.map(num)),
  max: (...a) => Math.max(...a.map(num)),
  year: (d) => dateOf(d)?.getFullYear() ?? null,
  month: (d) => (dateOf(d) ? dateOf(d)!.getMonth() + 1 : null),
  day: (d) => dateOf(d)?.getDate() ?? null,
  weekday: (d) => dateOf(d)?.toLocaleDateString('en', { weekday: 'short' }) ?? null,
  today: () => new Date().toISOString().slice(0, 10),
  datediff: (a, b) => {
    const x = dateOf(a);
    const y = dateOf(b);
    return x && y ? Math.round((y.getTime() - x.getTime()) / 86400000) : null;
  },
};
export const FUNCTION_NAMES = Object.keys(FUNCS);

function dateOf(v: Cell): Date | null {
  if (v === null) return null;
  const d = new Date(typeof v === 'number' && v < 100000 ? Math.round((v - 25569) * 86400000) : (v as any));
  return isNaN(d.getTime()) ? null : d;
}
function num(v: Cell): number {
  const n = toNum(v);
  return n === null ? NaN : n;
}
function truthy(v: Cell) {
  if (typeof v === 'string') return v !== '' && v.toLowerCase() !== 'false' && v !== '0';
  return !!v;
}

export function compile(src: string, headers: string[]): (row: Cell[], index: number) => Cell {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const accept = (v: string) => (peek().t === 'op' && peek().v === v ? (p++, true) : false);
  const acceptWord = (w: string) => (peek().t === 'id' && peek().v.toLowerCase() === w ? (p++, true) : false);
  const expect = (v: string) => {
    if (!accept(v)) throw new Error(`Expected "${v}"`);
  };
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, '');
  const findCol = (name: string) => {
    let i = headers.indexOf(name);
    if (i < 0) i = headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (i < 0) i = headers.findIndex((h) => norm(h) === norm(name));
    return i;
  };

  const or = (): Node => {
    let a = and();
    while (accept('||') || acceptWord('or')) a = { k: 'bin', op: '||', a, b: and() };
    return a;
  };
  const and = (): Node => {
    let a = not();
    while (accept('&&') || acceptWord('and')) a = { k: 'bin', op: '&&', a, b: not() };
    return a;
  };
  const not = (): Node => (accept('!') || acceptWord('not') ? { k: 'un', op: '!', a: not() } : cmp());
  const cmp = (): Node => {
    let a = add();
    for (;;) {
      const t = peek();
      if (t.t === 'op' && ['==', '=', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
        p++;
        a = { k: 'bin', op: t.v, a, b: add() };
      } else return a;
    }
  };
  const add = (): Node => {
    let a = mul();
    for (;;) {
      const t = peek();
      if (t.t === 'op' && (t.v === '+' || t.v === '-' || t.v === '&')) {
        p++;
        a = { k: 'bin', op: t.v, a, b: mul() };
      } else return a;
    }
  };
  const mul = (): Node => {
    let a = unary();
    for (;;) {
      const t = peek();
      if (t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        p++;
        a = { k: 'bin', op: t.v, a, b: unary() };
      } else return a;
    }
  };
  const unary = (): Node => (accept('-') ? { k: 'un', op: '-', a: unary() } : accept('+') ? unary() : pow());
  const pow = (): Node => {
    const a = primary();
    return accept('^') ? { k: 'bin', op: '^', a, b: unary() } : a;
  };
  const primary = (): Node => {
    const t = next();
    if (t.t === 'num') return { k: 'lit', v: parseFloat(t.v) };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'col') {
      const i = findCol(t.v);
      if (i < 0) throw new Error(`Unknown column [${t.v}]`);
      return { k: 'col', i };
    }
    if (t.t === 'op' && t.v === '(') {
      const e = or();
      expect(')');
      return e;
    }
    if (t.t === 'id') {
      const lw = t.v.toLowerCase();
      if (peek().t === 'op' && peek().v === '(') {
        p++;
        if (!FUNCS[lw]) throw new Error(`Unknown function ${t.v}()`);
        const args: Node[] = [];
        if (!accept(')')) {
          do args.push(or());
          while (accept(','));
          expect(')');
        }
        return { k: 'call', f: lw, args };
      }
      if (lw === 'true' || lw === 'false') return { k: 'lit', v: lw === 'true' };
      if (lw === 'null') return { k: 'lit', v: null };
      const i = findCol(t.v);
      if (i >= 0) return { k: 'col', i };
      if (lw === 'row') return { k: 'row' };
      throw new Error(`Unknown column "${t.v}" — use [Column Name] for names with spaces`);
    }
    throw new Error(t.t === 'eof' ? 'Unexpected end of formula' : `Unexpected "${t.v}"`);
  };

  const ast = or();
  if (peek().t !== 'eof') throw new Error(`Unexpected "${peek().v}"`);

  const ev = (n: Node, row: Cell[], idx: number): Cell => {
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'col':
        return row[n.i] ?? null;
      case 'row':
        return idx + 1;
      case 'un': {
        const a = ev(n.a, row, idx);
        return n.op === '!' ? !truthy(a) : -num(a);
      }
      case 'call':
        if (n.f === 'if') return truthy(ev(n.args[0], row, idx)) ? ev(n.args[1], row, idx) : n.args[2] ? ev(n.args[2], row, idx) : null;
        return FUNCS[n.f](...n.args.map((a) => ev(a, row, idx)));
      case 'bin': {
        if (n.op === '&&') return truthy(ev(n.a, row, idx)) && truthy(ev(n.b, row, idx));
        if (n.op === '||') return truthy(ev(n.a, row, idx)) || truthy(ev(n.b, row, idx));
        const a = ev(n.a, row, idx);
        const b = ev(n.b, row, idx);
        const na = toNum(a);
        const nb = toNum(b);
        const bothNum = na !== null && nb !== null;
        switch (n.op) {
          case '+':
            return bothNum ? na! + nb! : cellText(a) + cellText(b);
          case '&':
            return cellText(a) + cellText(b);
          case '-':
            return num(a) - num(b);
          case '*':
            return num(a) * num(b);
          case '/':
            return num(b) === 0 ? null : num(a) / num(b);
          case '%':
            return num(a) % num(b);
          case '^':
            return Math.pow(num(a), num(b));
          case '=':
          case '==':
            return bothNum ? na === nb : cellText(a).toLowerCase() === cellText(b).toLowerCase();
          case '!=':
          case '<>':
            return bothNum ? na !== nb : cellText(a).toLowerCase() !== cellText(b).toLowerCase();
          default: {
            const c = bothNum ? na! - nb! : cellText(a).localeCompare(cellText(b));
            return n.op === '<' ? c < 0 : n.op === '<=' ? c <= 0 : n.op === '>' ? c > 0 : c >= 0;
          }
        }
      }
    }
  };
  return (row, idx) => {
    const v = ev(ast, row, idx);
    return typeof v === 'number' && !Number.isFinite(v) ? null : v;
  };
}

/**
 * Column filter mini-syntax used in the filter row:
 *   text      contains (case-insensitive)      =x   exact        !=x  not equal
 *   >10 <5 >=1 <=2   numeric/date compare        a..b  range      /re/  regex
 *   empty  !empty                                 !text  does not contain
 */
export function compileFilter(q: string): ((v: Cell) => boolean) | null {
  q = q.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  if (lower === 'empty') return (v) => v === null || cellText(v).trim() === '';
  if (lower === '!empty') return (v) => !(v === null || cellText(v).trim() === '');
  const re = /^\/(.+)\/([gimsuy]*)$/.exec(q);
  if (re) {
    try {
      const r = new RegExp(re[1], re[2].replace('g', ''));
      return (v) => r.test(cellText(v));
    } catch {
      return () => false;
    }
  }
  const range = /^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)$/.exec(q);
  if (range) {
    const lo = +range[1];
    const hi = +range[2];
    return (v) => {
      const n = toNum(v);
      return n !== null && n >= lo && n <= hi;
    };
  }
  const cmp = /^(>=|<=|>|<|!=|=)\s*(.*)$/.exec(q);
  if (cmp) {
    const [, op, rhs] = cmp;
    const nr = toNum(rhs);
    const dr = !nr && /^\d{4}-\d{2}/.test(rhs) ? rhs : null;
    return (v) => {
      if (op === '=') return cellText(v).toLowerCase() === rhs.toLowerCase();
      if (op === '!=') return cellText(v).toLowerCase() !== rhs.toLowerCase();
      let c: number;
      if (nr !== null) {
        const n = toNum(v);
        if (n === null) return false;
        c = n - nr;
      } else if (dr) {
        const s = cellText(v);
        if (!s) return false;
        c = s.localeCompare(dr);
      } else c = cellText(v).localeCompare(rhs);
      return op === '>' ? c > 0 : op === '<' ? c < 0 : op === '>=' ? c >= 0 : c <= 0;
    };
  }
  if (q.startsWith('!')) {
    const s = q.slice(1).toLowerCase();
    return (v) => !cellText(v).toLowerCase().includes(s);
  }
  return (v) => cellText(v).toLowerCase().includes(lower);
}
