export type Key = string | number;
export type Path = Key[];

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isContainer = (v: unknown): v is object => !!v && typeof v === 'object';

export function getAt(root: unknown, path: Path): unknown {
  let v: any = root;
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[k as any];
  }
  return v;
}

export function typeOf(v: unknown): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v as any;
}

export function pathId(p: Path) {
  return JSON.stringify(p);
}

/** $.a.b[0]["weird key"] */
export function toJsonPath(p: Path) {
  return (
    '$' +
    p
      .map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`))
      .join('')
  );
}
export function toJsPath(p: Path, root = 'data') {
  return root + toJsonPath(p).slice(1).replace(/^\./, '.');
}
export function toJqPath(p: Path) {
  const s = p.map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_][\w]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('');
  return s.startsWith('.') ? s : '.' + s;
}

function shallow(v: any) {
  return Array.isArray(v) ? v.slice() : isObj(v) ? { ...v } : v;
}

interface Op {
  label: string;
  path: Path; // container path that was replaced
  before: unknown;
  after: unknown;
}

export class JsonDoc {
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private listeners: Array<(label: string) => void> = [];

  constructor(public value: unknown) {}

  onChange(fn: (label: string) => void) {
    this.listeners.push(fn);
  }

  private emit(label: string) {
    for (const l of this.listeners) l(label);
  }

  private replaceAt(path: Path, v: unknown) {
    if (!path.length) {
      this.value = v;
      return;
    }
    const parent: any = getAt(this.value, path.slice(0, -1));
    parent[path[path.length - 1] as any] = v;
  }

  /**
   * Copy-on-write edit of the container at `path`. `fn` mutates a shallow copy.
   * Undo swaps the old container back in — cheap even for large documents.
   */
  edit(label: string, path: Path, fn: (container: any) => unknown | void) {
    const before = getAt(this.value, path);
    let after = shallow(before);
    const ret = fn(after);
    if (ret !== undefined) after = ret;
    this.replaceAt(path, after);
    this.undoStack.push({ label, path, before, after });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.emit(label);
  }

  setValue(path: Path, v: unknown) {
    if (!path.length) return this.edit('Edit value', [], () => v);
    const key = path[path.length - 1];
    this.edit('Edit value', path.slice(0, -1), (c) => void (c[key as any] = v));
  }

  remove(path: Path) {
    const key = path[path.length - 1];
    this.edit('Delete', path.slice(0, -1), (c) => {
      if (Array.isArray(c)) c.splice(key as number, 1);
      else delete c[key as string];
    });
  }

  renameKey(path: Path, to: string) {
    const from = path[path.length - 1] as string;
    this.edit('Rename key', path.slice(0, -1), (c) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(c)) out[k === from ? to : k] = c[k];
      return out;
    });
  }

  insert(parent: Path, key: Key | null, v: unknown, at?: number) {
    this.edit('Add', parent, (c) => {
      if (Array.isArray(c)) c.splice(at ?? c.length, 0, v);
      else if (at !== undefined) {
        const out: Record<string, unknown> = {};
        const keys = Object.keys(c);
        keys.forEach((k, i) => {
          if (i === at) out[key as string] = v;
          out[k] = c[k];
        });
        if (at >= keys.length) out[key as string] = v;
        return out;
      } else c[key as string] = v;
    });
  }

  sortKeys(path: Path) {
    this.edit('Sort keys', path, (c) => {
      if (Array.isArray(c)) return c;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(c).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) out[k] = c[k];
      return out;
    });
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.replaceAt(op.path, op.before);
    this.redoStack.push(op);
    this.emit('');
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.replaceAt(op.path, op.after);
    this.undoStack.push(op);
    this.emit('');
  }

  reset(v: unknown) {
    this.value = v;
    this.undoStack = [];
    this.redoStack = [];
    this.emit('');
  }
}

/** Parse what the user typed into a value: JSON literal if valid, otherwise a string. */
export function parseLiteral(text: string, prevType?: string): unknown {
  const t = text.trim();
  if (prevType === 'string' && !/^(".*"|\{[\s\S]*\}|\[[\s\S]*\])$/.test(t)) return text;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

export function summarize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isObj(v)) return `{${Object.keys(v).length}}`;
  return JSON.stringify(v) ?? 'undefined';
}

export function docStats(v: unknown) {
  let nodes = 0,
    depth = 0,
    arrays = 0,
    objects = 0;
  const walk = (x: unknown, d: number) => {
    nodes++;
    if (d > depth) depth = d;
    if (Array.isArray(x)) {
      arrays++;
      for (const y of x) walk(y, d + 1);
    } else if (isObj(x)) {
      objects++;
      for (const y of Object.values(x)) walk(y, d + 1);
    }
  };
  walk(v, 0);
  return { nodes, depth, arrays, objects };
}

/** Find arrays that look tabular (for the Table view picker). */
export function findArrays(root: unknown, limit = 30): Array<{ path: Path; length: number }> {
  const out: Array<{ path: Path; length: number }> = [];
  const walk = (x: unknown, p: Path, d: number) => {
    if (d > 6 || out.length > 500) return;
    if (Array.isArray(x)) {
      if (x.length && x.some((y) => y && typeof y === 'object')) out.push({ path: p, length: x.length });
      x.slice(0, 3).forEach((y, i) => walk(y, [...p, i], d + 1));
    } else if (isObj(x)) {
      const vals = Object.values(x);
      if (vals.length > 1 && vals.every(isObj)) out.push({ path: p, length: vals.length });
      for (const [k, y] of Object.entries(x)) walk(y, [...p, k], d + 1);
    }
  };
  walk(root, [], 0);
  return out.sort((a, b) => b.length - a.length || a.path.length - b.path.length).slice(0, limit);
}
