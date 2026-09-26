import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { parseCsv, loadTable, serializeDoc, sniffDelimiter, parseJson, serializeJson, jsonToSheet, exportSheet } from '../ui/src/io';
import { compile, compileFilter } from '../ui/src/expr';
import { evaluate } from '../ui/src/json/jsonpath';
import { JsonDoc } from '../ui/src/json/JsonDoc';
import { setCell, toNum } from '../ui/src/model';
import { profile, groupBy } from '../ui/src/stats';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
let n = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    n++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name, '\n', e);
    process.exitCode = 1;
  }
};

test('CSV: quotes, escaped quotes, embedded newlines, CRLF', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",\r\n', ',');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'multi\nline', '']]);
});
test('CSV: delimiter sniffing', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n4;5;6'), ';');
  assert.equal(sniffDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(sniffDelimiter('a,b\n"1,5",2'), ',');
});
test('CSV: lossless round-trip (BOM, CRLF, quoting)', () => {
  const src = '﻿name,note\r\nAda,"hello, world"\r\nBo,"line1\nline2"\r\nCy, padded \r\n';
  const doc = loadTable(enc(src), 'csv');
  assert.equal(doc.csv.bom, true);
  assert.equal(doc.csv.eol, '\r\n');
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(serializeDoc(doc)), '﻿name,note\r\nAda,"hello, world"\r\nBo,"line1\nline2"\r\nCy," padded "\r\n');
});
test('CSV: sample file round-trips byte-identically', () => {
  const bytes = fs.readFileSync('samples/sales.csv');
  const doc = loadTable(new Uint8Array(bytes), 'csv');
  assert.equal(doc.sheet.rows.length, 2501);
  assert.equal(dec(serializeDoc(doc)), bytes.toString('utf8'));
});
test('CSV: ragged rows normalised, duplicate headers de-duped', () => {
  const doc = loadTable(enc('a,a,b\n1\n1,2,3,4\n'), 'csv');
  assert.deepEqual(doc.sheet.headers, ['a', 'a (2)', 'b', 'D']);
  assert.equal(doc.sheet.rows[0].length, 4);
});
test('Undo/redo snapshots survive copy-on-write edits', () => {
  const doc = loadTable(enc('x\n1\n2\n'), 'csv');
  doc.mutate('edit', (s) => setCell(s, 0, 0, '9'));
  doc.mutate('del', (s) => (s.rows = s.rows.slice(1)));
  assert.deepEqual(doc.sheet.rows, [['2']]);
  doc.undo();
  assert.deepEqual(doc.sheet.rows, [['9'], ['2']]);
  doc.undo();
  assert.deepEqual(doc.sheet.rows, [['1'], ['2']]);
  doc.redo();
  assert.deepEqual(doc.sheet.rows, [['9'], ['2']]);
});
test('XLSX: multi-sheet load, untouched sheet keeps formulas on save', () => {
  const doc = loadTable(new Uint8Array(fs.readFileSync('samples/inventory.xlsx')), 'xlsx');
  assert.deepEqual(doc.sheets.map((s) => s.name), ['Inventory', 'Suppliers']);
  assert.ok(doc.hasFormulas);
  assert.equal(typeof doc.sheets[0].rows[0][3], 'number');
  assert.match(String(doc.sheets[0].rows[0][6]), /^\d{4}-\d{2}-\d{2}$/); // date cell → ISO text
  doc.active = 1;
  doc.mutate('edit', (s) => setCell(s, 0, 3, 5));
  const wb = XLSX.read(serializeDoc(doc), { type: 'array' });
  assert.equal(wb.Sheets.Inventory.H2.f, 'D2*F2', 'formula preserved on untouched sheet');
  assert.equal(wb.Sheets.Suppliers.D2.v, 5, 'edit written');
});
test('Formula language', () => {
  const H = ['Unit Price', 'qty', 'name', 'date'];
  const row = ['2.5', '4', 'ada lovelace', '2025-03-09'];
  const ev = (s: string) => compile(s, H)(row, 0);
  assert.equal(ev('[Unit Price] * qty'), 10);
  assert.equal(ev('unit_price * qty + 1'), 11);
  assert.equal(ev('title(name) & "!"'), 'Ada Lovelace!');
  assert.equal(ev('if(qty >= 4, "bulk", "single")'), 'bulk');
  assert.equal(ev('round(10 / 3, 2)'), 3.33);
  assert.equal(ev('month(date)'), 3);
  assert.equal(ev('contains(name, "LOVE") and not isempty(qty)'), true);
  assert.equal(ev('-qty ^ 2'), -16);
  assert.equal(ev('row'), 1);
  assert.throws(() => compile('nope * 2', H), /Unknown column/);
  assert.throws(() => compile('upper(', H), /end of formula/);
});
test('Column filter syntax', () => {
  const f = (q: string, v: any) => compileFilter(q)!(v);
  assert.ok(f('>10', '12') && !f('>10', '9'));
  assert.ok(f('1..5', 3) && !f('1..5', 6));
  assert.ok(f('=lagos', 'Lagos') && !f('=lag', 'Lagos'));
  assert.ok(f('lag', 'Lagos') && f('!abuja', 'Lagos'));
  assert.ok(f('/^L.g/', 'Lagos'));
  assert.ok(f('empty', null) && f('!empty', 'x'));
  assert.ok(f('>=2025-06-01', '2025-07-01') && !f('>=2025-06-01', '2025-05-01'));
});
test('Number parsing', () => {
  assert.equal(toNum('1,234.5'), 1234.5);
  assert.equal(toNum('$30'), 30);
  assert.equal(toNum('12%'), 0.12);
  assert.equal(toNum('ORD-1'), null);
});
test('Profile & group-by', () => {
  const p = profile(['1', '2', '3', '4', null, '4']);
  assert.equal(p.type, 'number');
  assert.equal(p.mean, 2.8);
  assert.equal(p.median, 3);
  assert.equal(p.empty, 1);
  const g = groupBy([['a', 1], ['b', 2], ['a', 3]], [0], 1, ['count', 'sum']);
  assert.deepEqual(g, [['a', 2, 4], ['b', 1, 2]]);
});
test('JSON: indent detection, JSONC fallback, JSONL', () => {
  assert.equal(parseJson(enc('{\n    "a": 1\n}'), 'json').indent, 4);
  assert.deepEqual(parseJson(enc('{\n  // c\n  "a": [1,2,], /* x */\n}'), 'json').value, { a: [1, 2] });
  const l = parseJson(enc('{"a":1}\n\n{"a":2}\n'), 'jsonl');
  assert.deepEqual(l.value, [{ a: 1 }, { a: 2 }]);
  assert.equal(dec(serializeJson(l)), '{"a":1}\n{"a":2}\n');
  assert.throws(() => parseJson(enc('{"a":1}\n{bad'), 'jsonl'), /Line 2/);
});
test('JSON sample round-trips byte-identically', () => {
  const b = fs.readFileSync('samples/users.json');
  assert.equal(dec(serializeJson(parseJson(new Uint8Array(b), 'json'))), b.toString('utf8'));
});
test('JSONPath', () => {
  const v = parseJson(new Uint8Array(fs.readFileSync('samples/users.json')), 'json').value as any;
  assert.equal(evaluate(v, '$.users[0].name')[0].value, v.users[0].name);
  assert.equal(evaluate(v, '$.users[*].id').length, 120);
  assert.equal(evaluate(v, '$.users[-1].id')[0].value, 120);
  assert.equal(evaluate(v, '$.users[0:3]').length, 3);
  assert.equal(evaluate(v, '$..lat').length, 120);
  assert.equal(evaluate(v, '$.users[?(@.age > 40)]').length, v.users.filter((u: any) => u.age > 40).length);
  assert.equal(evaluate(v, '$.users[?(@.address.city == "Lagos" && @.active)]').length, v.users.filter((u: any) => u.address.city === 'Lagos' && u.active).length);
  assert.equal(evaluate(v, "$.settings['theme'].primary")[0].value, '#2a78d6');
  assert.equal(evaluate(v, 'users.length')[0].value, 120);
  assert.deepEqual(evaluate(v, '$.users[0,2].id').map((m) => m.value), [1, 3]);
});
test('JsonDoc edit / rename (order kept) / undo / redo', () => {
  const d = new JsonDoc({ a: 1, b: { c: [1, 2] }, z: 0 });
  d.setValue(['b', 'c', 1], 5);
  d.renameKey(['a'], 'A');
  d.remove(['b', 'c', 0]);
  assert.deepEqual(d.value, { A: 1, b: { c: [5] }, z: 0 });
  assert.deepEqual(Object.keys(d.value as object), ['A', 'b', 'z']);
  d.undo();
  d.undo();
  d.undo();
  assert.deepEqual(d.value, { a: 1, b: { c: [1, 2] }, z: 0 });
  d.redo();
  assert.deepEqual(d.value, { a: 1, b: { c: [1, 5] }, z: 0 });
});
test('JSON → table flattening + export', () => {
  const s = jsonToSheet([{ id: 1, u: { name: 'x', geo: { lat: 1 } }, tags: ['a'] }, { id: 2, extra: true }])!;
  assert.deepEqual(s.headers, ['id', 'u.name', 'u.geo.lat', 'tags', 'extra']);
  assert.deepEqual(s.rows[0], [1, 'x', 1, '["a"]', null]);
  const doc = loadTable(enc('a,b\n1,x\n'), 'csv');
  assert.equal(dec(exportSheet(doc, 'json')), '[\n  {\n    "a": "1",\n    "b": "x"\n  }\n]\n');
  assert.match(dec(exportSheet(doc, 'sql')), /INSERT INTO "csv" \("a", "b"\) VALUES \('1', 'x'\);/);
  assert.match(dec(exportSheet(doc, 'md')), /\| a \| b \|\n\| --- \| --- \|\n\| 1 \| x \|/);
  const x = XLSX.read(exportSheet(doc, 'xlsx'), { type: 'array' });
  assert.equal(x.Sheets[x.SheetNames[0]].B2.v, 'x');
});
console.log(`\n${n} tests passed${process.exitCode ? ' (with failures)' : ''}`);
