/**
 * Host bridge. The UI is identical in every IDE; only this layer differs.
 *
 *  - vscode    : VS Code, Cursor, Windsurf, VSCodium, Positron… (acquireVsCodeApi)
 *  - jetbrains : IntelliJ-based IDEs through JCEF (window.__dataLensPost injected by the plugin)
 *  - browser   : standalone page (file picker + downloads) — used for dev and as a fallback
 *
 * Protocol (host → ui):
 *   { type:'init', fileName, data, readonly?, cssVars?, theme?, settings? }
 *   { type:'reload', data }           file changed on disk / revert
 *   { type:'getFileData', requestId } host wants bytes to save
 *   { type:'undo' } | { type:'redo' }
 * Protocol (ui → host):
 *   { type:'ready' }
 *   { type:'edit', label }            document became dirty (VS Code records an undo stop)
 *   { type:'response', requestId, data }
 *   { type:'save', data }             explicit save (jetbrains / browser)
 *   { type:'export', fileName, data } "Save As…" to a new file
 *   { type:'copy', text }             clipboard fallback
 *   { type:'notify', level, message }
 *   { type:'command', id }            run an IDE command (vscode)
 */

export type HostKind = 'vscode' | 'jetbrains' | 'browser';

export interface InitMessage {
  type: 'init';
  fileName: string;
  data: Uint8Array;
  readonly?: boolean;
  theme?: 'dark' | 'light';
  cssVars?: Record<string, string>;
  settings?: Partial<Settings>;
}

export interface Settings {
  csvHasHeader: boolean;
  jsonIndent: number | 'auto';
  autosave: boolean;
}

type Listener = (msg: any) => void;

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void };
    __dataLensPost?: (json: string) => void;
    __dataLensReceive?: (msg: any) => void;
    __dataLensHost?: HostKind;
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(s);
}

class Host {
  readonly kind: HostKind;
  private listeners: Listener[] = [];
  private vscode?: ReturnType<NonNullable<Window['acquireVsCodeApi']>>;

  constructor() {
    if (typeof window.acquireVsCodeApi === 'function') {
      this.kind = 'vscode';
      this.vscode = window.acquireVsCodeApi();
      window.addEventListener('message', (e) => this.emit(e.data));
    } else if (window.__dataLensHost === 'jetbrains' || typeof window.__dataLensPost === 'function') {
      this.kind = 'jetbrains';
      // JCEF can only move strings, so binary payloads travel as base64.
      window.__dataLensReceive = (msg: any) => {
        if (msg && typeof msg.data === 'string' && msg.dataEncoding === 'base64') msg.data = b64ToBytes(msg.data);
        this.emit(msg);
      };
    } else {
      this.kind = 'browser';
    }
  }

  private emit(msg: any) {
    for (const l of this.listeners) l(msg);
  }

  /** Used by the standalone page to inject messages as if they came from a host. */
  inject(msg: any) {
    this.emit(msg);
  }

  on(fn: Listener) {
    this.listeners.push(fn);
  }

  post(msg: any) {
    if (this.kind === 'vscode') {
      this.vscode!.postMessage(msg);
    } else if (this.kind === 'jetbrains') {
      if (msg.data instanceof Uint8Array) msg = { ...msg, data: bytesToB64(msg.data), dataEncoding: 'base64' };
      const send = () => window.__dataLensPost!(JSON.stringify(msg));
      // The bridge function is injected after page load; queue until it exists.
      if (window.__dataLensPost) send();
      else setTimeout(() => this.post(msg), 50);
    } else {
      browserFallback(msg);
    }
  }

  /** Whether the host owns undo/redo & save keybindings (VS Code does for custom editors). */
  get hostHandlesUndo() {
    return this.kind === 'vscode';
  }

  async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.post({ type: 'copy', text });
    }
  }
}

function browserFallback(msg: any) {
  if (msg.type === 'export' || msg.type === 'save') {
    const blob = new Blob([msg.data], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = msg.fileName || 'data';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (msg.type === 'copy') {
    const ta = document.createElement('textarea');
    ta.value = msg.text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export const host = new Host();
