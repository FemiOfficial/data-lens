// Builds the shared UI once and ships it into every host.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const out = path.join(root, 'build/ui');

const copyOut = () => {
  const js = fs.readFileSync(path.join(out, 'ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(out, 'ui.css'), 'utf8');

  // 1) VS Code-family extension (VS Code, Cursor, Windsurf, VSCodium, Positron, Theia…)
  const media = path.join(root, 'vscode/media');
  fs.mkdirSync(media, { recursive: true });
  fs.copyFileSync(path.join(out, 'ui.js'), path.join(media, 'ui.js'));
  fs.copyFileSync(path.join(out, 'ui.css'), path.join(media, 'ui.css'));

  // 2) JetBrains plugin: one self-contained HTML (JCEF loads it from the plugin jar)
  const jb = path.join(root, 'jetbrains/src/main/resources/webview');
  fs.mkdirSync(jb, { recursive: true });
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  fs.writeFileSync(
    path.join(jb, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<script>window.__dataLensHost='jetbrains'</script><style>${css}</style></head>` +
      `<body><div id="app"></div><script>${safeJs}</script></body></html>`,
  );

  // 3) Standalone browser page
  const sa = path.join(root, 'standalone');
  fs.copyFileSync(path.join(out, 'ui.js'), path.join(sa, 'ui.js'));
  fs.copyFileSync(path.join(out, 'ui.css'), path.join(sa, 'ui.css'));
  const kb = (n) => (fs.statSync(path.join(out, n)).size / 1024).toFixed(0) + ' KB';
  console.log(`ui.js ${kb('ui.js')}, ui.css ${kb('ui.css')} → vscode/media, jetbrains resources, standalone`);
};

const uiOpts = {
  entryPoints: { ui: path.join(root, 'ui/src/main.ts') },
  bundle: true,
  format: 'iife',
  target: ['chrome100', 'safari15'],
  outdir: out,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [{ name: 'copy', setup: (b) => b.onEnd((r) => !r.errors.length && copyOut()) }],
};

const extOpts = {
  entryPoints: [path.join(root, 'vscode/src/extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  external: ['vscode'],
  outfile: path.join(root, 'vscode/dist/extension.js'),
  minify: !watch,
  sourcemap: watch,
  logLevel: 'warning',
};

if (watch) {
  const a = await esbuild.context(uiOpts);
  const b = await esbuild.context(extOpts);
  await Promise.all([a.watch(), b.watch()]);
  console.log('watching…');
} else {
  await esbuild.build(uiOpts);
  await esbuild.build(extOpts);
  console.log('extension → vscode/dist/extension.js');
}
