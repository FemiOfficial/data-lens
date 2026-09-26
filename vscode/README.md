# Data Lens — CSV, Excel & JSON Explorer

An interactive data workbench inside your editor. Works in **VS Code, Cursor, Windsurf, VSCodium, Trae, Positron, code-server** and any other VS Code-API editor.

## Tables — `.csv` `.tsv` `.xlsx` `.xlsm` `.xls` `.ods`
- Virtualized grid that stays fast on 100k+ rows; sticky headers & row numbers
- Click a header to sort (Shift+click for multi-sort); drag headers to reorder; drag edges to resize
- Per-column filters: `text`, `=exact`, `!=x`, `>10`, `1..9`, `/regex/`, `empty`, `!empty` — plus a global search
- Spreadsheet editing: double-click / type to edit, Enter/Tab to move, copy/paste ranges from Excel & Sheets, fill down (⌘D), insert/delete rows & columns
- **Profile** panel: type detection, fill rate, unique/duplicate counts, mean/median/percentiles, histograms and top values — click any bar to filter
- **Chart** panel: bar, line, area, scatter, donut, histogram with aggregation (sum/avg/count/min/max/median), respecting your filters; export as PNG
- **Transform** panel: computed columns with a safe formula language, filter by formula, find & replace (regex), trim, dedupe, split, change case, transpose, group-by/pivot into a new sheet
- Multi-sheet workbooks with sheet tabs; untouched sheets keep formulas and styles on save
- Export to CSV, TSV, XLSX, JSON, JSON Lines, SQL INSERTs, HTML, Markdown (all rows or just the filtered view)
- Native Save / Save As / Revert / Undo / Redo and hot-exit backups

## JSON — `.json` `.jsonc` `.geojson` `.jsonl` `.ndjson` `.har`
Use **Visualize JSON** in the editor title bar (JSON keeps opening in the text editor by default).
- **Tree**: virtualized, search with match navigation, inline edit/rename/delete/add, copy path as JSONPath / JS / jq
- **Graph**: pan & zoom node graph of the document
- **Table**: any array of objects as a sortable, filterable, chartable grid (nested objects are flattened)
- **JSONPath queries**: `$..id`, `$.users[?(@.age > 30 && @.active)]`, `[0:10]`…
- Export pretty/minified JSON, JSON Lines, CSV, XLSX, or copy generated TypeScript interfaces

## Formula language
`[Unit Price] * qty` · `upper(name)` · `if(score >= 50, "pass", "fail")` · `round(total / count, 2)` · `contains(email, "@gmail")` · `year(date)`

Functions: upper lower title trim len left right mid replace regex split concat contains startswith endswith isempty coalesce if num str round floor ceil abs sqrt pow log exp min max year month day weekday today datediff

## Settings
- `dataLens.csv.firstRowIsHeader` (default `true`)
- `dataLens.json.indent` — `auto` keeps the file's indentation
- `dataLens.maxFileSizeMB` (default 200)
