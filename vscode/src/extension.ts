import * as vscode from 'vscode';

/**
 * Data Lens custom editor. Works unchanged in every VS Code-API editor:
 * VS Code, Cursor, Windsurf, VSCodium, Trae, Positron, Theia/Eclipse Che, code-server, github.dev.
 *
 * The webview owns the parsed document (so parsing/serialising is identical in
 * every host). This side only moves bytes and plugs into the editor's native
 * dirty-state, Save / Save As / Revert, hot-exit backups and Undo/Redo.
 */

const VIEW_TYPES = ['dataLens.table', 'dataLens.workbook', 'dataLens.json'] as const;

class DataLensDocument implements vscode.CustomDocument {
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;
  webviews = new Set<vscode.WebviewPanel>();
  private requestId = 0;
  private pending = new Map<number, { resolve: (d: Uint8Array) => void; reject: (e: Error) => void }>();
  savedVersion = 0;
  version = 0;

  constructor(readonly uri: vscode.Uri, public bytes: Uint8Array) {}

  /** Ask a webview for the current serialized bytes. */
  getFileData(): Promise<Uint8Array> {
    const panel = [...this.webviews][0];
    if (!panel) return Promise.resolve(this.bytes);
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      panel.webview.postMessage({ type: 'getFileData', requestId: id });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('Timed out waiting for Data Lens to serialize the document'));
      }, 60_000);
    });
  }

  resolveRequest(id: number, data?: Uint8Array | number[] | Record<string, number>, error?: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(toBytes(data));
  }

  broadcast(msg: unknown) {
    for (const w of this.webviews) w.webview.postMessage(msg);
  }

  dispose() {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

function toBytes(d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (Array.isArray(d)) return Uint8Array.from(d);
  if (d && typeof d === 'object') return Uint8Array.from(Object.values(d as Record<string, number>));
  return new Uint8Array();
}

class DataLensEditorProvider implements vscode.CustomEditorProvider<DataLensDocument> {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DataLensDocument>>();
  readonly onDidChangeCustomDocument = this._onDidChange.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<DataLensDocument> {
    const src = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    let bytes: Uint8Array;
    try {
      bytes = openContext.untitledDocumentData ?? (await vscode.workspace.fs.readFile(src));
    } catch {
      bytes = new Uint8Array();
    }
    const doc = new DataLensDocument(uri, bytes);

    // Reload when the file changes on disk and we have no unsaved edits.
    if (uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uri.path.split('/').pop()!));
      const reload = async () => {
        if (doc.version !== doc.savedVersion) return;
        try {
          const fresh = await vscode.workspace.fs.readFile(uri);
          if (sameBytes(fresh, doc.bytes)) return;
          doc.bytes = fresh;
          doc.broadcast({ type: 'reload', data: fresh });
        } catch {
          /* deleted */
        }
      };
      watcher.onDidChange(reload);
      doc.onDidDispose(() => watcher.dispose());
    }
    return doc;
  }

  async resolveCustomEditor(doc: DataLensDocument, panel: vscode.WebviewPanel): Promise<void> {
    doc.webviews.add(panel);
    panel.onDidDispose(() => doc.webviews.delete(panel));
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview, media);

    const cfg = vscode.workspace.getConfiguration('dataLens');
    const readonly = !vscode.workspace.fs.isWritableFileSystem(doc.uri.scheme);

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          const maxMB = cfg.get<number>('maxFileSizeMB', 200);
          if (doc.bytes.byteLength > maxMB * 1024 * 1024) {
            vscode.window.showWarningMessage(`File is larger than ${maxMB} MB — opening as text.`);
            return vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
          }
          panel.webview.postMessage({
            type: 'init',
            fileName: doc.uri.path.split('/').pop(),
            data: doc.bytes,
            readonly,
            settings: { csvHasHeader: cfg.get('csv.firstRowIsHeader', true), jsonIndent: cfg.get('json.indent', 'auto') },
          });
          break;
        }
        case 'edit':
          doc.version++;
          this._onDidChange.fire({
            document: doc,
            label: msg.label,
            undo: () => {
              doc.version--;
              doc.broadcast({ type: 'undo' });
            },
            redo: () => {
              doc.version++;
              doc.broadcast({ type: 'redo' });
            },
          });
          break;
        case 'response':
          doc.resolveRequest(msg.requestId, msg.data, msg.error);
          break;
        case 'save':
          await vscode.commands.executeCommand('workbench.action.files.save');
          break;
        case 'export':
          await this.exportFile(doc, msg.fileName, toBytes(msg.data));
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(msg.text);
          break;
        case 'notify':
          (msg.level === 'error' ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(msg.message);
          break;
        case 'command':
          if (msg.id === 'undo' || msg.id === 'redo') await vscode.commands.executeCommand(msg.id);
          else if (msg.id === 'reopenAsText') await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
          break;
      }
    });
  }

  private async exportFile(doc: DataLensDocument, fileName: string, data: Uint8Array) {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(doc.uri, '..', fileName),
      saveLabel: 'Export',
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, data);
    const open = await vscode.window.showInformationMessage(`Exported ${target.path.split('/').pop()}`, 'Open', 'Reveal');
    if (open === 'Open') await vscode.commands.executeCommand('vscode.open', target);
    if (open === 'Reveal') await vscode.commands.executeCommand('revealFileInOS', target);
  }

  private html(webview: vscode.Webview, media: vscode.Uri) {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'ui.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'ui.css'));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet"><title>Data Lens</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  async saveCustomDocument(doc: DataLensDocument, _c: vscode.CancellationToken) {
    await this.saveAs(doc, doc.uri);
    doc.savedVersion = doc.version;
    doc.broadcast({ type: 'saved' });
  }

  async saveCustomDocumentAs(doc: DataLensDocument, dest: vscode.Uri) {
    await this.saveAs(doc, dest);
  }

  private async saveAs(doc: DataLensDocument, dest: vscode.Uri) {
    const data = await doc.getFileData();
    doc.bytes = data;
    await vscode.workspace.fs.writeFile(dest, data);
  }

  async revertCustomDocument(doc: DataLensDocument) {
    const data = await vscode.workspace.fs.readFile(doc.uri);
    doc.bytes = data;
    doc.savedVersion = doc.version;
    doc.broadcast({ type: 'reload', data });
  }

  async backupCustomDocument(doc: DataLensDocument, ctx: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    const data = await doc.getFileData();
    await vscode.workspace.fs.writeFile(ctx.destination, data);
    return {
      id: ctx.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(ctx.destination);
        } catch {
          /* noop */
        }
      },
    };
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function viewTypeFor(uri: vscode.Uri) {
  const ext = uri.path.toLowerCase().split('.').pop() || '';
  if (['xlsx', 'xlsm', 'xls', 'ods'].includes(ext)) return 'dataLens.workbook';
  if (['json', 'jsonc', 'geojson', 'jsonl', 'ndjson', 'har'].includes(ext)) return 'dataLens.json';
  return 'dataLens.table';
}

function activeUri(arg?: vscode.Uri): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const tab = vscode.window.tabGroups?.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
  return tab?.uri ?? vscode.window.activeTextEditor?.document.uri;
}

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new DataLensEditorProvider(ctx);
  for (const vt of VIEW_TYPES) {
    ctx.subscriptions.push(
      vscode.window.registerCustomEditorProvider(vt, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
    );
  }

  const openWith = async (arg?: vscode.Uri) => {
    const uri = activeUri(arg);
    if (!uri) return vscode.window.showInformationMessage('Open a CSV, Excel or JSON file first.');
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc?.isDirty) await doc.save();
    await vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri));
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('dataLens.open', openWith),
    vscode.commands.registerCommand('dataLens.openJson', openWith),
    vscode.commands.registerCommand('dataLens.openAsText', async (arg?: vscode.Uri) => {
      const uri = activeUri(arg);
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    vscode.commands.registerCommand('dataLens.newFromClipboard', async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text.trim()) return vscode.window.showInformationMessage('Clipboard is empty.');
      const isJson = /^\s*[[{]/.test(text);
      const ext = isJson ? 'json' : text.includes('\t') ? 'tsv' : 'csv';
      const uri = vscode.Uri.parse(`untitled:clipboard.${ext}`);
      const bytes = new TextEncoder().encode(text);
      // Untitled custom documents receive their initial data via untitledDocumentData.
      const tmp = vscode.Uri.joinPath(ctx.globalStorageUri, `clipboard-${Date.now()}.${ext}`);
      await vscode.workspace.fs.writeFile(tmp, bytes);
      await vscode.commands.executeCommand('vscode.openWith', tmp, viewTypeFor(uri));
    }),
  );
}

export function deactivate() {}
