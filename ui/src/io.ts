import * as XLSX from 'xlsx';
import { Cell, colName, CsvOptions, Sheet, TableDoc, TableFormat, cellText } from './model';

export type FileKind = TableFormat | 'json' | 'jsonl';

export function detectKind(fileName: string): FileKind {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'tsv':
    case 'tab':
      return 'tsv';
    case 'xlsx':
    case 'xlsm':
      return 'xlsx';
    case 'xls':
      return 'xls';
    case 'ods':
      return 'ods';
    case 'json':
    case 'geojson':
    case 'jsonc':
    case 'har':
      return 'json';
    case 'jsonl':
    case 'ndjson':
      return 'jsonl';
    default:
      return 'csv';
  }
}

export const isTableKind = (k: FileKind): k is TableFormat => k !== 'json' && k !== 'jsonl';

/* ------------------------------------------------------------------ text */

export function decodeText(bytes: Uint8Array): { text: string; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else text = new TextDecoder('utf-8').decode(bom ? bytes.subarray(3) : bytes);
  return { text, bom };
}

export function encodeText(text: string, bom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/* ------------------------------------------------------------------- CSV */

export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const lines = sample.split(/\r?\n/).filter((l) => l.length).slice(0, 30);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => splitCsvLine(l, d).length);
    if (!counts.length) continue;
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 100 + Math.min(first, 50);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitCsvLine(line: string, d: string) {
  // cheap approximation for sniffing only
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') q = !q;
    else if (ch === d && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** RFC 4180 parser (quoted fields, escaped quotes, embedded newlines, CRLF/LF). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;
  let quoted = false;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function serializeCsv(headers: string[] | null, rows: Cell[][], o: CsvOptions): string {
  const d = o.delimiter;
  const needs = new RegExp(`["\\r\\n${d === '\t' ? '\\t' : d.replace(/[|\\]/g, '\\$&')}]`);
  const enc = (v: Cell) => {
    const s = cellText(v);
    return needs.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  if (headers) lines.push(headers.map(enc).join(d));
  for (const r of rows) lines.push(r.map(enc).join(d));
  return lines.join(o.eol) + (lines.length ? o.eol : '');
}

function normalize(headers: string[], rows: Cell[][]) {
  let width = headers.length;
  for (const r of rows) if (r.length > width) width = r.length;
  for (let c = headers.length; c < width; c++) headers.push(colName(c));
  const seen = new Map<string, number>();
  headers.forEach((h, i) => {
    let name = (h ?? '').toString().trim() || colName(i);
    const k = seen.get(name) || 0;
    seen.set(name, k + 1);
    if (k) name = `${name} (${k + 1})`;
    headers[i] = name;
  });
  for (let i = 0; i < rows.length; i++) if (rows[i].length < width) rows[i] = rows[i].concat(new Array(width - rows[i].length).fill(null));
}

/* ------------------------------------------------------------------ load */

export function loadTable(bytes: Uint8Array, kind: TableFormat, hasHeader = true): TableDoc {
  if (kind === 'csv' || kind === 'tsv') {
    const { text, bom } = decodeText(bytes);
    const delimiter = kind === 'tsv' ? '\t' : sniffDelimiter(text);
    const eol = /\r\n/.test(text.slice(0, 10000)) ? '\r\n' : '\n';
    const raw = parseCsv(text, delimiter) as Cell[][];
    const rows = raw.map((r) => r.map((v) => (v === '' ? null : v)));
    const headers = hasHeader && rows.length ? (rows.shift() as Cell[]).map((v) => cellText(v)) : [];
    normalize(headers, rows);
    return new TableDoc([{ name: kind.toUpperCase(), headers, rows }], kind, { delimiter, eol, bom, hasHeader });
  }

  const wb = XLSX.read(bytes, { type: 'array', cellDates: true, cellFormula: true, cellStyles: true });
  let hasFormulas = false;
  const sheets: Sheet[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    for (const k in ws) if (k[0] !== '!' && (ws as any)[k]?.f) {
      hasFormulas = true;
      break;
    }
    const aoa = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null, blankrows: true }) as any[][];
    const rows: Cell[][] = aoa.map((r) => r.map(fromXlsxValue));
    const headers = hasHeader && rows.length ? rows.shift()!.map((v) => cellText(v)) : [];
    normalize(headers, rows);
    return { name, headers, rows, origin: ws };
  });
  if (!sheets.length) sheets.push({ name: 'Sheet1', headers: ['A'], rows: [] });
  return new TableDoc(sheets, kind, { delimiter: ',', eol: '\n', bom: false, hasHeader }, hasFormulas);
}

function fromXlsxValue(v: unknown): Cell {
  if (v instanceof Date) {
    const iso = new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  if (v === undefined) return null;
  return v as Cell;
}

/* ------------------------------------------------------------------ save */

export type ExportFormat = 'csv' | 'tsv' | 'xlsx' | 'xls' | 'ods' | 'json' | 'jsonl' | 'md' | 'html' | 'sql';

export function sheetToObjects(s: Sheet, rows = s.rows) {
  return rows.map((r) => {
    const o: Record<string, Cell> = {};
    s.headers.forEach((h, i) => (o[h] = r[i] ?? null));
    return o;
  });
}

export function exportSheet(doc: TableDoc, fmt: ExportFormat, sheet = doc.sheet, rows = sheet.rows): Uint8Array {
  const o = doc.csv;
  switch (fmt) {
    case 'csv':
      return encodeText(serializeCsv(sheet.headers, rows, { ...o, delimiter: o.delimiter === '\t' ? ',' : o.delimiter }), o.bom);
    case 'tsv':
      return encodeText(serializeCsv(sheet.headers, rows, { ...o, delimiter: '\t' }), o.bom);
    case 'json':
      return encodeText(JSON.stringify(sheetToObjects(sheet, rows), null, 2) + '\n');
    case 'jsonl':
      return encodeText(sheetToObjects(sheet, rows).map((x) => JSON.stringify(x)).join('\n') + '\n');
    case 'md':
      return encodeText(toMarkdown(sheet.headers, rows));
    case 'html':
      return encodeText(toHtml(sheet.headers, rows));
    case 'sql':
      return encodeText(toSql(sheet.name, sheet.headers, rows));
    default:
      return writeWorkbook([{ ...sheet, rows, dirty: true }], fmt, true);
  }
}

/** Serialize the document back to its own format (what "Save" writes). */
export function serializeDoc(doc: TableDoc): Uint8Array {
  const s0 = doc.sheets.find((s) => !s.derived) || doc.sheets[0];
  if (doc.format === 'csv' || doc.format === 'tsv') {
    return encodeText(serializeCsv(doc.csv.hasHeader ? s0.headers : null, s0.rows, doc.csv), doc.csv.bom);
  }
  return writeWorkbook(doc.sheets, doc.format, doc.csv.hasHeader);
}

function writeWorkbook(sheets: Sheet[], bookType: TableFormat | ExportFormat, hasHeader: boolean): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    let ws: any;
    if (s.origin && !s.dirty) {
      ws = s.origin; // untouched → keep formulas, merges, widths, styles as parsed
    } else {
      ws = XLSX.utils.aoa_to_sheet(hasHeader ? [s.headers, ...s.rows] : s.rows);
      const prev = s.origin as any;
      if (prev?.['!cols']) ws['!cols'] = prev['!cols'];
      else ws['!cols'] = s.headers.map((h, i) => ({ wch: Math.min(60, Math.max(8, h.length + 2, ...s.rows.slice(0, 200).map((r) => cellText(r[i]).length + 1))) }));
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31) || 'Sheet');
  }
  const out = XLSX.write(wb, { type: 'array', bookType: bookType as XLSX.BookType, compression: true });
  return new Uint8Array(out as ArrayBuffer);
}

export function toMarkdown(headers: string[], rows: Cell[][]) {
  const esc = (v: Cell) => cellText(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = [`| ${headers.map(esc).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${headers.map((_, i) => esc(r[i] ?? null)).join(' | ')} |`);
  return lines.join('\n') + '\n';
}

function toHtml(headers: string[], rows: Cell[][]) {
  const e = (v: Cell) => cellText(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<table>\n<thead><tr>${headers.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead>\n<tbody>\n${rows
    .map((r) => `<tr>${headers.map((_, i) => `<td>${e(r[i] ?? null)}</td>`).join('')}</tr>`)
    .join('\n')}\n</tbody>\n</table>\n`;
}

function toSql(name: string, headers: string[], rows: Cell[][]) {
  const id = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lit = (v: Cell) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/'/g, "''")}'`);
  const t = id(name.replace(/\W+/g, '_').toLowerCase() || 'data');
  const cols = headers.map(id).join(', ');
  return rows.map((r) => `INSERT INTO ${t} (${cols}) VALUES (${headers.map((_, i) => lit(r[i] ?? null)).join(', ')});`).join('\n') + '\n';
}

/* ------------------------------------------------------------------ JSON */

export interface JsonDocInfo {
  value: unknown;
  indent: string | number;
  lines: boolean;
}

export function parseJson(bytes: Uint8Array, kind: 'json' | 'jsonl'): JsonDocInfo {
  const { text } = decodeText(bytes);
  if (kind === 'jsonl') {
    const value = text
      .split(/\r?\n/)
      .map((l, i) => ({ l: l.trim(), i }))
      .filter((x) => x.l)
      .map((x) => {
        try {
          return JSON.parse(x.l);
        } catch (e) {
          throw new Error(`Line ${x.i + 1}: ${(e as Error).message}`);
        }
      });
    return { value, indent: 0, lines: true };
  }
  const m = /^[\[{]\s*?\r?\n([ \t]+)\S/.exec(text.trimStart());
  const indent = m ? (m[1].includes('\t') ? '\t' : m[1].length) : 2;
  const trimmed = text.trim();
  if (!trimmed) return { value: {}, indent, lines: false };
  try {
    return { value: JSON.parse(trimmed), indent, lines: false };
  } catch (e) {
    // JSONC (comments / trailing commas) fallback — tsconfig, settings.json, etc.
    const stripped = stripJsonComments(trimmed);
    try {
      return { value: JSON.parse(stripped), indent, lines: false };
    } catch {
      throw e;
    }
  }
}

function stripJsonComments(s: string) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += s[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function serializeJson(info: JsonDocInfo): Uint8Array {
  if (info.lines && Array.isArray(info.value)) return encodeText(info.value.map((v) => JSON.stringify(v)).join('\n') + '\n');
  return encodeText(JSON.stringify(info.value, null, info.indent) + '\n');
}

/** Try to turn an arbitrary JSON value into a table (array of objects / array of arrays / object of objects). */
export function jsonToSheet(value: unknown, name = 'JSON'): Sheet | null {
  let arr: unknown[] | null = null;
  let keyCol: string | null = null;
  if (Array.isArray(value)) arr = value;
  else if (value && typeof value === 'object') {
    const vals = Object.values(value);
    if (vals.length && vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      arr = Object.entries(value).map(([k, v]) => ({ key: k, ...(v as object) }));
      keyCol = 'key';
    }
  }
  if (!arr || !arr.length) return null;
  if (arr.every((r) => Array.isArray(r))) {
    const width = Math.max(...arr.map((r) => (r as unknown[]).length));
    const headers = Array.from({ length: width }, (_, i) => colName(i));
    return { name, headers, rows: arr.map((r) => (r as unknown[]).map(toCell)) };
  }
  const headers: string[] = keyCol ? [keyCol] : [];
  const seen = new Set(headers);
  const objs = arr.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? flatten(r as object) : { value: r }));
  for (const o of objs) for (const k of Object.keys(o)) if (!seen.has(k)) {
    seen.add(k);
    headers.push(k);
  }
  return { name, headers, rows: objs.map((o) => headers.map((h) => toCell((o as any)[h]))) };
}

function flatten(o: object, prefix = '', out: Record<string, unknown> = {}, depth = 0) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2 && Object.keys(v).length <= 20) flatten(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

function toCell(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as Cell;
}
