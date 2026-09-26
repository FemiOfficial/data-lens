import './styles.css';
import { host, InitMessage, Settings } from './host';
import { detectKind, isTableKind, loadTable, serializeDoc, exportSheet, parseJson, serializeJson, JsonDocInfo, ExportFormat, FileKind } from './io';
import { TableView } from './table/TableView';
import { JsonView } from './json/JsonView';
import { JsonDoc } from './json/JsonDoc';
import { TableDoc } from './model';
import { h, toast, debounce, icon } from './dom';

const app = document.getElementById('app')!;
let settings: Settings = { csvHasHeader: true, jsonIndent: 'auto', autosave: false };
let fileName = 'data.csv';
let kind: FileKind = 'csv';
let tableDoc: TableDoc | null = null;
let tableView: TableView | null = null;
let jsonInfo: JsonDocInfo | null = null;
let jsonDoc: JsonDoc | null = null;
let readonly = false;
let dirty = false;

function applyTheme(msg: Partial<InitMessage>) {
  const root = document.documentElement;
  if (msg.theme) root.dataset.theme = msg.theme;
  if (msg.cssVars) for (const [k, v] of Object.entries(msg.cssVars)) root.style.setProperty(k, v);
  root.dataset.host = host.kind;
}

function setDirty(d: boolean) {
  dirty = d;
  document.documentElement.classList.toggle('is-dirty', d);
}

const autosave = debounce(() => {
  if (dirty && settings.autosave) save();
}, 1200);

function onEdit(label: string) {
  setDirty(true);
  host.post({ type: 'edit', label });
  if (host.kind === 'jetbrains') autosave();
}

function serialize(): Uint8Array {
  if (tableDoc) return serializeDoc(tableDoc);
  if (jsonDoc && jsonInfo) {
    const indent = settings.jsonIndent === 'auto' ? jsonInfo.indent : settings.jsonIndent;
    return serializeJson({ ...jsonInfo, value: jsonDoc.value, indent });
  }
  return new Uint8Array();
}

function save() {
  try {
    host.post({ type: 'save', fileName, data: serialize() });
    if (host.kind === 'browser') setDirty(false);
  } catch (e) {
    toast('Save failed: ' + (e as Error).message, 'error', 5000);
  }
}

function doExport(name: string, data: Uint8Array) {
  host.post({ type: 'export', fileName: name, data });
}

function load(bytes: Uint8Array, keepView = false) {
  kind = detectKind(fileName);
  try {
    if (isTableKind(kind)) {
      const doc = loadTable(bytes, kind, settings.csvHasHeader);
      if (keepView && tableDoc && tableView) {
        tableDoc.replaceAll(doc.sheets);
        tableDoc.csv = doc.csv;
        return;
      }
      tableDoc = doc;
      jsonDoc = null;
      tableView = new TableView(doc, {
        readonly,
        typedInput: kind !== 'csv' && kind !== 'tsv',
        allowSheets: true,
        onEdit,
        onSave: save,
        onExport: (fmt: ExportFormat, which) => {
          const rows = which === 'view' ? tableView!.viewRows() : doc.sheet.rows;
          const base = fileName.replace(/\.[^.]+$/, '');
          const suffix = doc.sheets.length > 1 ? `-${doc.sheet.name}` : '';
          doExport(`${base}${suffix}.${fmt}`, exportSheet(doc, fmt, doc.sheet, rows));
        },
      });
      app.replaceChildren(tableView.el);
      if (doc.sheet.rows.length > 200000) toast(`${doc.sheet.rows.length.toLocaleString()} rows loaded — filters and charts may take a moment`, 'info', 4000);
      requestAnimationFrame(() => tableView!.focusGrid());
    } else {
      const info = parseJson(bytes, kind as 'json' | 'jsonl');
      if (keepView && jsonDoc) {
        jsonInfo = info;
        jsonDoc.reset(info.value);
        return;
      }
      jsonInfo = info;
      jsonDoc = new JsonDoc(info.value);
      tableDoc = null;
      const view = new JsonView(jsonDoc, { readonly, onEdit, onSave: save, onExport: doExport, fileName });
      app.replaceChildren(view.el);
    }
    setDirty(false);
  } catch (e) {
    showError(e as Error);
  }
}

function showError(e: Error) {
  app.replaceChildren(
    h(
      'div',
      { class: 'empty-state big error' },
      icon('close', 28),
      h('h2', null, `Couldn't open ${fileName}`),
      h('pre', null, e.message),
      host.kind === 'vscode' ? h('button', { class: 'btn primary', onclick: () => host.post({ type: 'command', id: 'reopenAsText' }) }, 'Open in text editor') : null,
    ),
  );
}

host.on((msg) => {
  switch (msg.type) {
    case 'init': {
      const m = msg as InitMessage;
      fileName = m.fileName;
      readonly = !!m.readonly;
      settings = { ...settings, ...(m.settings || {}) };
      applyTheme(m);
      load(m.data);
      break;
    }
    case 'reload':
      load(msg.data, true);
      break;
    case 'theme':
      applyTheme(msg);
      break;
    case 'getFileData':
      try {
        host.post({ type: 'response', requestId: msg.requestId, data: serialize() });
      } catch (e) {
        host.post({ type: 'response', requestId: msg.requestId, error: (e as Error).message });
      }
      break;
    case 'saved':
      setDirty(false);
      break;
    case 'undo':
      tableDoc?.undo();
      jsonDoc?.undo();
      break;
    case 'redo':
      tableDoc?.redo();
      jsonDoc?.redo();
      break;
    case 'toast':
      toast(msg.message, msg.level || 'info');
      break;
  }
});

document.documentElement.dataset.host = host.kind;
host.post({ type: 'ready' });

// Standalone/dev page hook
(window as any).dataLens = {
  open(name: string, data: Uint8Array) {
    host.inject({ type: 'init', fileName: name, data });
  },
};
