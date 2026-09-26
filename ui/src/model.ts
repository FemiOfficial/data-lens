export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  headers: string[];
  rows: Cell[][];
  /** Original SheetJS worksheet — written back untouched when the sheet was never edited (keeps formulas & styles). */
  origin?: unknown;
  dirty?: boolean;
  /** Created inside Data Lens (e.g. group-by result). Not written to single-sheet formats. */
  derived?: boolean;
}

export type TableFormat = 'csv' | 'tsv' | 'xlsx' | 'xls' | 'ods';

export interface CsvOptions {
  delimiter: string;
  eol: string;
  bom: boolean;
  hasHeader: boolean;
}

type Snapshot = { sheets: Sheet[]; active: number; hasHeader: boolean; label: string };

const MAX_HISTORY = 60;

function cloneSheets(sheets: Sheet[]): Sheet[] {
  // Shallow: row arrays are shared. All writers must replace a row array rather than mutate it (see setCell).
  return sheets.map((s) => ({ ...s, headers: s.headers.slice(), rows: s.rows.slice() }));
}

export class TableDoc {
  sheets: Sheet[];
  active = 0;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners: Array<(label: string) => void> = [];

  constructor(sheets: Sheet[], public format: TableFormat, public csv: CsvOptions, public hasFormulas = false) {
    this.sheets = sheets;
  }

  get sheet() {
    return this.sheets[this.active];
  }

  onChange(fn: (label: string) => void) {
    this.listeners.push(fn);
  }

  private snap(label: string): Snapshot {
    return { sheets: cloneSheets(this.sheets), active: this.active, hasHeader: this.csv.hasHeader, label };
  }

  private restore(s: Snapshot) {
    this.sheets = cloneSheets(s.sheets);
    this.active = Math.min(s.active, this.sheets.length - 1);
    this.csv.hasHeader = s.hasHeader;
  }

  /** Run a mutation as one undoable step. `fn` receives the active sheet. */
  mutate(label: string, fn: (sheet: Sheet, doc: TableDoc) => void, opts: { markDirty?: boolean } = {}) {
    this.undoStack.push(this.snap(label));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    fn(this.sheet, this);
    if (opts.markDirty !== false) this.sheet.dirty = true;
    this.emit(label);
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snap(s.label));
    this.restore(s);
    this.emit('Undo ' + s.label, true);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snap(s.label));
    this.restore(s);
    this.emit('Redo ' + s.label, true);
  }

  replaceAll(sheets: Sheet[]) {
    this.sheets = sheets;
    this.active = Math.min(this.active, sheets.length - 1);
    this.undoStack = [];
    this.redoStack = [];
    this.emit('reload', true);
  }

  private emit(label: string, silent = false) {
    for (const l of this.listeners) l(silent ? '' : label);
  }
}

/** Copy-on-write cell setter — required so undo snapshots stay intact. */
export function setCell(sheet: Sheet, r: number, c: number, v: Cell) {
  while (sheet.rows.length <= r) sheet.rows.push(new Array(sheet.headers.length).fill(null));
  const row = sheet.rows[r].slice();
  while (row.length <= c) row.push(null);
  row[c] = v;
  sheet.rows[r] = row;
}

export function colName(i: number): string {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export function uniqueHeader(headers: string[], base: string) {
  if (!headers.includes(base)) return base;
  let i = 2;
  while (headers.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(15));
  return String(v);
}

/** Interpret a cell as a number when it looks like one ("1,234.5", "12%", "$3"). */
export function toNum(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return parseFloat(s);
  const cleaned = s.replace(/^[$€£¥₦]/, '').replace(/,/g, '');
  if (/^[-+]?(\d+\.?\d*|\.\d+)%$/.test(cleaned)) return parseFloat(cleaned) / 100;
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return parseFloat(cleaned);
  return null;
}

/** Parse user-typed text into the best cell value (keeps text as text for CSV to preserve formatting). */
export function parseInput(text: string, typed: boolean): Cell {
  if (text === '') return null;
  if (!typed) return text;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text.trim()) && !/^0\d/.test(text.trim())) return parseFloat(text);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  return text;
}
