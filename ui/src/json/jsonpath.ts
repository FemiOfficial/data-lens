/**
 * Small JSONPath subset:
 *   $  .key  ['key']  [0]  [-1]  [*]  .*  ..key  ..*  [0:5]  [0,2]  ['a','b']
 *   [?(@.price > 10)]  [?(@.tags)]  [?(@.name == "x")]  [?(@.name =~ /re/i)]
 * Also accepts jq-ish paths (".users[0].name") and bare "users.0.name".
 */
import { Path, isObj, getAt } from './JsonDoc';

type Seg =
  | { t: 'key'; keys: string[] }
  | { t: 'idx'; idx: number[] }
  | { t: 'slice'; a?: number; b?: number; s?: number }
  | { t: 'wild' }
  | { t: 'desc'; inner: Seg }
  | { t: 'filter'; fn: (v: unknown) => boolean };

function parse(q: string): Seg[] {
  q = q.trim();
  if (q.startsWith('$')) q = q.slice(1);
  else if (!q.startsWith('.') && !q.startsWith('[')) q = '.' + q;
  const segs: Seg[] = [];
  let i = 0;
  const readName = () => {
    const m = /^[^.[\]\s]+/.exec(q.slice(i));
    if (!m) throw new Error(`Expected a name at ${i}`);
    i += m[0].length;
    return m[0];
  };
  while (i < q.length) {
    if (q.startsWith('..', i)) {
      i += 2;
      if (q[i] === '*') {
        i++;
        segs.push({ t: 'desc', inner: { t: 'wild' } });
      } else if (q[i] === '[') segs.push({ t: 'desc', inner: bracket() });
      else segs.push({ t: 'desc', inner: nameSeg(readName()) });
    } else if (q[i] === '.') {
      i++;
      if (q[i] === '*') {
        i++;
        segs.push({ t: 'wild' });
      } else if (q[i] === '[') continue;
      else segs.push(nameSeg(readName()));
    } else if (q[i] === '[') segs.push(bracket());
    else if (/\s/.test(q[i])) i++;
    else throw new Error(`Unexpected "${q[i]}" at ${i}`);
  }
  return segs;

  function nameSeg(n: string): Seg {
    return /^-?\d+$/.test(n) ? { t: 'idx', idx: [+n] } : { t: 'key', keys: [n] };
  }
  function bracket(): Seg {
    const start = i;
    let depth = 0;
    let inStr: string | null = null;
    for (; i < q.length; i++) {
      const ch = q[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) break;
    }
    if (i >= q.length) throw new Error('Missing ]');
    const body = q.slice(start + 1, i).trim();
    i++;
    if (body === '*') return { t: 'wild' };
    if (body.startsWith('?')) return { t: 'filter', fn: compileFilter(body.replace(/^\?\s*\(?/, '').replace(/\)$/, '')) };
    const sl = /^(-?\d*)\s*:\s*(-?\d*)(?:\s*:\s*(-?\d+))?$/.exec(body);
    if (sl) return { t: 'slice', a: sl[1] ? +sl[1] : undefined, b: sl[2] ? +sl[2] : undefined, s: sl[3] ? +sl[3] : undefined };
    const parts = splitTop(body);
    if (parts.every((p) => /^-?\d+$/.test(p))) return { t: 'idx', idx: parts.map(Number) };
    return { t: 'key', keys: parts.map((p) => (/^["']/.test(p) ? JSON.parse(p[0] === "'" ? `"${p.slice(1, -1).replace(/"/g, '\\"')}"` : p) : p)) };
  }
}

function splitTop(s: string) {
  const out: string[] = [];
  let cur = '';
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\') cur += s[++i];
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** @.a.b OP literal  |  @.a (truthy)  |  combined with && / || */
function compileFilter(src: string): (v: unknown) => boolean {
  const ors = src.split(/\s*\|\|\s*/).map((part) => part.split(/\s*&&\s*/).map(atom));
  return (v) => ors.some((ands) => ands.every((f) => f(v)));
  function atom(a: string): (v: unknown) => boolean {
    const neg = a.startsWith('!');
    if (neg) a = a.slice(1);
    const m = /^@((?:\.[\w$-]+|\[[^\]]+\])*)\s*(==|!=|<=|>=|<|>|=~)?\s*(.*)$/.exec(a.trim());
    if (!m) throw new Error(`Bad filter "${a}"`);
    const sub = m[1] ? parse('$' + m[1]) : [];
    const get = (v: unknown) => (sub.length ? evaluate(v, sub)[0]?.value : v);
    const op = m[2];
    let lit: any = m[3];
    if (!op) return (v) => neg !== !!(get(v) !== undefined && get(v) !== null && get(v) !== false);
    if (op === '=~') {
      const rm = /^\/(.*)\/(\w*)$/.exec(lit.trim());
      const re = rm ? new RegExp(rm[1], rm[2]) : new RegExp(lit);
      return (v) => neg !== re.test(String(get(v) ?? ''));
    }
    try {
      lit = JSON.parse(lit.replace(/^'(.*)'$/, '"$1"'));
    } catch {
      /* bare word → string */
    }
    return (v) => {
      const x: any = get(v);
      let r: boolean;
      switch (op) {
        case '==':
          r = x == lit;
          break;
        case '!=':
          r = x != lit;
          break;
        case '<':
          r = x < lit;
          break;
        case '<=':
          r = x <= lit;
          break;
        case '>':
          r = x > lit;
          break;
        default:
          r = x >= lit;
      }
      return neg !== r;
    };
  }
}

export interface Match {
  path: Path;
  value: unknown;
}

function children(v: unknown, base: Path): Match[] {
  if (Array.isArray(v)) return v.map((x, i) => ({ path: [...base, i], value: x }));
  if (isObj(v)) return Object.entries(v).map(([k, x]) => ({ path: [...base, k], value: x }));
  return [];
}

function step(m: Match, seg: Seg): Match[] {
  const v = m.value;
  switch (seg.t) {
    case 'key':
      if (Array.isArray(v) && seg.keys.length === 1 && seg.keys[0] === 'length') return [{ path: [...m.path, 'length'], value: v.length }];
      return isObj(v) ? seg.keys.filter((k) => k in v).map((k) => ({ path: [...m.path, k], value: v[k] })) : [];
    case 'idx':
      return Array.isArray(v)
        ? seg.idx
            .map((i) => (i < 0 ? v.length + i : i))
            .filter((i) => i >= 0 && i < v.length)
            .map((i) => ({ path: [...m.path, i], value: v[i] }))
        : [];
    case 'slice': {
      if (!Array.isArray(v)) return [];
      const n = v.length;
      const norm = (x: number | undefined, d: number) => (x === undefined ? d : x < 0 ? Math.max(0, n + x) : Math.min(n, x));
      const a = norm(seg.a, 0);
      const b = norm(seg.b, n);
      const s = seg.s || 1;
      const out: Match[] = [];
      for (let i = a; i < b; i += s) out.push({ path: [...m.path, i], value: v[i] });
      return out;
    }
    case 'wild':
      return children(v, m.path);
    case 'filter':
      return children(v, m.path).filter((c) => {
        try {
          return seg.fn(c.value);
        } catch {
          return false;
        }
      });
    case 'desc': {
      const out: Match[] = [];
      const walk = (x: Match) => {
        out.push(...step(x, seg.inner));
        for (const c of children(x.value, x.path)) walk(c);
      };
      walk(m);
      return out;
    }
  }
}

export function evaluate(root: unknown, q: string | Seg[], limit = 5000): Match[] {
  const segs = typeof q === 'string' ? parse(q) : q;
  let cur: Match[] = [{ path: [], value: root }];
  for (const s of segs) {
    const next: Match[] = [];
    for (const m of cur) {
      next.push(...step(m, s));
      if (next.length > limit * 4) break;
    }
    cur = next;
  }
  return cur.slice(0, limit);
}

export { getAt };
