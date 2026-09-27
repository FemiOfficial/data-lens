# Data Lens

Interactive CSV / TSV / Excel / JSON explorer that runs **inside your IDE**:

| IDE | Package | How |
|---|---|---|
| VS Code, Cursor, Windsurf, VSCodium, Trae, Positron, code-server, Theia | `dist/data-lens.vsix` | VS Code extension (custom editors) |
| IntelliJ IDEA, WebStorm, PyCharm, GoLand, PhpStorm, Rider, CLion, RubyMine, DataGrip, Android Studio (2023.2+) | `jetbrains/build/distributions/data-lens-jetbrains-0.1.0.zip` | IntelliJ Platform plugin (JCEF editor) |
| Any browser | `standalone/index.html` | Drag-and-drop page (also the dev harness) |

## Architecture

```
ui/src/            ← ONE web UI, shared by every host (TypeScript, no framework)
  io.ts            CSV (RFC 4180, delimiter sniffing, BOM/EOL preserved), XLSX via SheetJS, JSON/JSONC/JSONL
  model.ts         Table document + copy-on-write undo/redo
  table/           Virtualized grid, Profile / Chart / Transform drawer
  json/            Tree, graph, table views; JSONPath; JSON document with undo
  expr.ts          Sandboxed formula language (no eval → strict CSP)
  host.ts          The only host-specific code: postMessage bridge
vscode/            Thin CustomEditorProvider: bytes in/out, native dirty/save/undo/backup/revert
jetbrains/         Thin FileEditor on JCEF: base64 bytes over JBCefJSQuery, IDE theme → CSS vars, autosave
standalone/        Browser host
```

The UI parses and serializes files itself, so behavior is identical in every IDE. Each host only moves bytes and wires the UI into native save, undo, clipboard and theme.

## Build

```bash
npm install
npm run build            # UI → vscode/media, jetbrains resources, standalone
npm test                 # core unit tests (parsers, round-trips, formulas, JSONPath, undo)
npm run test:vscode      # launches a real VS Code and opens every sample in the custom editors
npm run package:vscode   # → dist/data-lens.vsix
cd jetbrains && ./gradlew buildPlugin   # → jetbrains/build/distributions/*.zip (JDK 17+; Gradle downloads the IDE SDK)
cd jetbrains && ./gradlew verifyPlugin  # JetBrains Plugin Verifier against IC 2023.2 and 2025.2
cd jetbrains && ./gradlew runIde        # sandbox IDE with the plugin loaded
npm run serve            # standalone page at http://localhost:5178/?file=samples/sales.csv
```

## Install

- **Cursor / Windsurf / VSCodium:** search **"Data Lens"** in the Extensions view (published on [Open VSX](https://open-vsx.org/extension/femiofficial/data-lens) as `femiofficial.data-lens`), or `cursor --install-extension femiofficial.data-lens`
- **VS Code:** Extensions view → `…` → *Install from VSIX…* with the `.vsix` from the [latest release](https://github.com/FemiOfficial/data-lens/releases/latest)
- **JetBrains:** Settings → Plugins → ⚙ → *Install Plugin from Disk…* with the plugin `.zip` from the [latest release](https://github.com/FemiOfficial/data-lens/releases/latest)

## Releasing

1. Bump `version` in `vscode/package.json`, commit.
2. `git tag v<version> && git push --tags`
3. The **Release** workflow builds both packages, attaches them to a GitHub release and publishes to Open VSX (needs the `OVSX_PAT` repository secret) and the VS Code Marketplace (optional `VSCE_PAT` secret).

## Using it

**Tables:** click a header to sort (Shift+click adds a sort key). Drag headers to reorder and drag their edges to resize. `⌘⇧F` shows the per-column filters (`>10`, `1..9`, `=x`, `!x`, `/re/`, `empty`), and `⌘F` searches. To edit, double-click a cell or just start typing; Enter and Tab commit and move. `⌘C`/`⌘V` copy and paste ranges from Excel or Sheets. `⌘D` fills down. `⌘1/2/3` open Profile, Chart and Transform. Right-click opens more options.

**JSON:** in VS Code, JSON opens as text by default; use the **Visualize JSON** button in the editor title. In JetBrains, use the *Data Lens* tab at the bottom of the editor.
- **Tree:** double-click to edit a value, or a key to rename it. Delete removes a node, and right-click opens more options.
- **Graph:** drag to pan, `⌘`+scroll to zoom, and double-click a card to jump to it in the tree.
- **Table:** shows any array of objects as a grid, with profiling and charts.

The `$` box runs JSONPath queries.

## Notes and limits
- **XLSX:** sheets you never edit are written back untouched, so formulas, styles and merges survive. Edited sheets are rewritten as values; the status bar warns when the workbook has formulas. Date cells are shown and saved as ISO text.
- **CSV:** saving preserves the delimiter, line endings and BOM, and unedited files round-trip byte-for-byte. Cells are kept as text, so `007` stays `007`.
- **JSON:** comments in `.jsonc` files are dropped if you save from Data Lens. Integers beyond 2^53 lose precision (a JavaScript `JSON.parse` limitation).
- **Large files:** 100k+ rows scroll smoothly (virtualized). Files above `dataLens.maxFileSizeMB` (default 200) open as text in VS Code.
