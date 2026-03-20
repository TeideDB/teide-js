# TeideDB Web REPL — Design Document

## Overview

A browser-based SQL REPL for teide-js. Single self-contained HTML page served by a lightweight Node.js HTTP server. CodeMirror 6 for SQL editing with autocomplete, WebSocket for query execution, virtual-scrolling HTML tables for results.

Replaces the terminal REPL entirely. Invoked via `teide` or `npx teidedb`.

## Architecture

```
bin/teide.js              — entry point: starts server, opens browser
lib/repl/server.ts        — HTTP server (serves UI) + WebSocket (query execution)
lib/repl/protocol.ts      — WebSocket message types
lib/repl/ui.html          — self-contained HTML page (CodeMirror + result viewer)
```

Reuses existing modules:
- `lib/repl/formatter.ts`  — server-side cell value extraction for JSON results
- `lib/repl/theme.ts`      — shared color palette (CSS variables mirror ANSI theme)
- `lib/repl/history.ts`    — persistent query history (~/.teidedb_history)

Removes (terminal-specific, no longer needed):
- `lib/repl/input.ts`
- `lib/repl/suggestions.ts`
- `lib/repl/highlight.ts` (CodeMirror handles this)
- `lib/repl/completer.ts` (autocomplete moves to server → WebSocket → CodeMirror)
- `lib/repl/validator.ts` (CodeMirror handles multi-line)

## Server (`server.ts`)

Lightweight HTTP + WebSocket server using Node.js built-in `http` module and `ws` package.

### HTTP endpoints

| Route | Purpose |
|-------|---------|
| `GET /` | Serves `ui.html` (inlined, no external files) |

### WebSocket protocol (`protocol.ts`)

Client → Server:
```typescript
{ type: 'query', id: string, sql: string }
{ type: 'complete', prefix: string, context: string }
{ type: 'dot', command: string }
{ type: 'meta' }  // request table list + schema
```

Server → Client:
```typescript
{ type: 'result', id: string, columns: Column[], rows: any[][], nrows: number, elapsed: number }
{ type: 'error', id: string, message: string }
{ type: 'ok', id: string, message: string, elapsed: number }  // DDL result
{ type: 'completions', items: { value: string, description: string }[] }
{ type: 'meta', tables: { name: string, nrows: number, ncols: number, columns: Column[] }[] }
{ type: 'print', text: string }  // dot-command output
```

Where `Column = { name: string, dtype: string }`.

### Startup flow

1. Find a free port (default 3141, auto-increment if busy)
2. Create `Context` and `Session`
3. Start HTTP + WebSocket server
4. Open browser to `http://localhost:<port>`
5. Print URL to terminal for manual access
6. On WebSocket close (last client disconnects) + Ctrl+C → cleanup and exit

## Frontend (`ui.html`)

Single self-contained HTML file with all CSS and JS inlined. No build step. CDN imports for CodeMirror and virtual scroller.

### Layout

```
┌──────────────────────────────────────────────────┐
│  TeideDB   v0.1.1                    [.tables ▼] │
├──────────────────────────────────────────────────┤
│                                                  │
│  CodeMirror SQL editor                           │
│  (multi-line, syntax highlighting, autocomplete) │
│                                         [Run ▶]  │
├──────────────────────────────────────────────────┤
│  ┌────────┬─────┬──────────┐                     │
│  │ name   │ age │ city     │  ← virtual-scroll   │
│  ├────────┼─────┼──────────┤     result table     │
│  │ Alice  │  30 │ Seattle  │                     │
│  │ Bob    │  25 │ Portland │                     │
│  │ ...    │     │          │                     │
│  └────────┴─────┴──────────┘                     │
│  3 rows × 3 columns · 0.42ms           [Export ▼]│
├──────────────────────────────────────────────────┤
│  History: SELECT * FROM t  │  .load sales.csv    │
└──────────────────────────────────────────────────┘
```

### Components

**Editor pane:**
- CodeMirror 6 with `@codemirror/lang-sql` for syntax highlighting
- SQL autocomplete via `@codemirror/autocomplete` — completions fetched from server over WebSocket
- Ctrl+Enter / Cmd+Enter to execute (or click Run button)
- Multi-line input with proper indentation
- Dark theme matching the Teide color palette

**Result pane:**
- Virtual-scrolling table for large results
- Column headers with type badge (dim, like the terminal formatter)
- Numbers right-aligned, strings left-aligned, NULLs styled dim/italic
- Row count + column count + elapsed time in footer
- Export dropdown: CSV, JSON, copy to clipboard

**Sidebar/status:**
- Table list (clickable to insert table name or show schema)
- Query history (clickable to re-run)

### CSS theme

Dark theme with CSS variables mirroring the terminal ANSI palette:
```css
:root {
    --bg: #1e1e2e;
    --fg: #cdd6f4;
    --border: #45475a;
    --header: #89dceb;
    --type-dim: #6c7086;
    --null: #6c7086;
    --string: #a6e3a1;
    --number: #89b4fa;
    --keyword: #cba6f7;
    --error: #f38ba8;
    --success: #a6e3a1;
    --selection: #313244;
}
```

### Virtual scroller

For handling large result sets (100K+ rows), use a simple custom virtual scroller:
- Container has `overflow-y: auto` with a fixed height
- A spacer div sets the total scroll height (`rowCount * rowHeight`)
- On scroll, compute which rows are visible and render only those
- Row height is fixed (monospace font, single line per cell)
- Renders ~50 rows at a time with buffer above/below viewport

### CDN dependencies (loaded in `ui.html`)

- `codemirror` + `@codemirror/lang-sql` + `@codemirror/autocomplete` — editor
- `@codemirror/theme-one-dark` — dark theme base

All loaded from esm.sh or unpkg CDN via `<script type="module">`.

## Server-side dependencies

- `ws` — WebSocket server (lightweight, 0 deps)

## Entry point (`bin/teide.js`)

```javascript
#!/usr/bin/env node
require('../dist/repl/server').startServer();
```

The `startServer()` function:
1. Parses args (--port, --no-open)
2. Creates Context + Session
3. Starts HTTP server
4. Opens browser via `open` (child_process)
5. Handles shutdown (Ctrl+C, SIGTERM)

## Dot-commands (via WebSocket)

Same set as designed for terminal, but executed via WebSocket messages:

| Command | Behavior |
|---------|----------|
| `.help` | Returns help text as `print` message |
| `.tables` | Returns table list via `meta` message |
| `.schema <table>` | Returns column info via `meta` message |
| `.load <file.csv> [as <name>]` | Loads CSV, returns `ok` message |
| `.save <table> <file.csv>` | Exports table, returns `ok` message |
| `.timer on\|off` | Toggles timing display |
| `.clear` | Clears result pane (client-side) |

`.mode`, `.limit`, `.width` are no longer needed — the browser UI handles display formatting.

## Migration from terminal REPL

- Remove: `lib/repl/input.ts`, `lib/repl/suggestions.ts`, `lib/repl/highlight.ts`, `lib/repl/completer.ts`, `lib/repl/validator.ts`
- Keep: `lib/repl/formatter.ts` (reuse `getCellValue` for JSON serialization), `lib/repl/history.ts`, `lib/repl/theme.ts`
- Rewrite: `lib/repl/index.ts` → `lib/repl/server.ts`
- Update: `bin/teide.js`, `package.json`, `lib/index.ts`

## Non-goals

- No authentication (local use only, binds to 127.0.0.1)
- No multiple simultaneous sessions
- No query cancellation (executeSync is blocking)
- No saved queries / workspaces
- No chart/visualization
