# TeideDB Web REPL — Design Document

## Overview

A browser-based SQL console for teide-js, inspired by QuestDB's web console. Single self-contained HTML page served by a lightweight Node.js HTTP server. CodeMirror 6 for SQL editing with autocomplete, WebSocket for query execution, virtual-scrolling HTML tables for results.

Replaces the terminal REPL entirely. Invoked via `teide` or `npx teidedb`.

## Architecture

```
bin/teide.js              — entry point: starts server, opens browser
lib/repl/server.ts        — HTTP server (serves UI) + WebSocket (query execution)
lib/repl/protocol.ts      — WebSocket message types
lib/repl/serialize.ts     — Table → JSON serialization for WebSocket results
lib/repl/autocomplete.ts  — Server-side SQL autocomplete (fuzzy matching)
lib/repl/ui.html          — self-contained HTML page (CodeMirror + result viewer)
```

Reuses existing modules:
- `lib/repl/formatter.ts`  — server-side cell value extraction (`getCellValue`)
- `lib/repl/theme.ts`      — shared color palette
- `lib/repl/history.ts`    — persistent query history (~/.teidedb_history)

## Server (`server.ts`)

Lightweight HTTP + WebSocket server using Node.js built-in `http` module and `ws` package.

### HTTP endpoints

| Route | Purpose |
|-------|---------|
| `GET /` | Serves `ui.html` with `__VERSION__` replaced |

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
{ type: 'result', id: string, columns: Column[], rows: (string|null)[][], nrows: number, elapsed: number }
{ type: 'error', id: string, message: string }
{ type: 'ok', id: string, message: string, elapsed: number }
{ type: 'completions', items: { value: string, description: string }[] }
{ type: 'meta', tables: { name: string, nrows: number, ncols: number, columns: Column[] }[], history: string[] }
{ type: 'print', text: string }
```

Where `Column = { name: string, dtype: string }`.

### Startup flow

1. Find a free port (default 3141, auto-increment on EADDRINUSE up to +10)
2. Create `Context` and `Session`
3. Start HTTP + WebSocket server on 127.0.0.1
4. Open browser (xdg-open/open/start) unless `noOpen` option
5. Print URL to terminal
6. Graceful shutdown on SIGINT/SIGTERM: save history, close WS, close HTTP, destroy context

## Frontend (`ui.html`)

Single self-contained HTML page with all CSS and JS inlined. No build step. CDN imports for CodeMirror 6 and Font Awesome 6.

### Layout (QuestDB-inspired)

```
┌─────────────────────────────────────────────────────────────┐
│ [Teide logo] TeideDB v0.1.1           [? Help] [✕ Clear] ⌨ │  ← top bar
├──┬──────────────────────────────────────────────────────────┤
│  │ [</> SQL 1]  [+]                                         │  ← tab bar (renameable)
│S │                                                          │
│I │  CodeMirror editor (SQL, one-dark, autocomplete)         │  ← editor (~55% height)
│D │                                                          │
│E │                                        [▶ Run query Ctrl↵]│
│B ├══════════════════════════════════════════════════════════╡  ← draggable splitter
│A │ [Output] [Log] [Console]            N rows [Download CSV▾]│  ← bottom tab bar
│R ├──────────────────────────────────────────────────────────┤
│  │ col1    ┊ col2    ┊ col3     ┊ col4                      │
│  │ type    ┊ type    ┊ type     ┊ type                      │  ← virtual-scroll table
│  │─────────┼─────────┼──────────┼───────                    │
│  │ val     ┊ val     ┊    12.34 ┊ text                      │
├──┴──────────────────────────────────────────────────────────┤
│                                       ● Connected  v0.1.1  │  ← footer
└─────────────────────────────────────────────────────────────┘
```

### Top bar
- Left: Teide mountain SVG logo, "TeideDB" brand, version
- Right: Help button (runs .help), Clear button, keyboard shortcut icon

### Left sidebar
- Icon rail (44px): tables icon, history icon — toggles panel
- Expandable panel (224px): filter input + refresh button, expandable table tree with columns, or query history list

### Editor section
- CodeMirror 6 with individual extensions (not basicSetup — esm.sh incompatible)
- SQL syntax highlighting, one-dark theme
- Autocomplete: `activateOnTyping: true`, 2-char minimum, Tab to accept, fetched via WebSocket
- Ctrl+Enter / Cmd+Enter to execute (highest-precedence keymap)
- Green "Run query | Ctrl ↵" button overlaid bottom-right
- Resizable via draggable splitter between editor and results

### SQL tabs
- Tab bar with active tab indicator (accent bottom border)
- Double-click tab label to rename inline (Enter to save, Escape to cancel)

### Bottom pane (tabbed)
Three tabs below the splitter:

**Output** — Query result table with virtual scrolling
- Two-line column headers (name bold + dtype dim), dashed column separators
- Numbers right-aligned (blue), strings left-aligned, nulls dim italic
- Row count + Download CSV dropdown (CSV, JSON, Copy as TSV)

**Log** — Scrollable query history
- Append-only log entries with timestamp, status icon (✓/✗), message, timing
- Persists across queries within the session

**Console** — JavaScript REPL
- Client-side `eval()` with echo of input, formatted results, error display
- Input history via up/down arrow keys

### Color theme (teidelum)
```css
:root {
    --bg: #0e1b24;          /* navy background */
    --bg-surface: #0a1319;  /* darker surface */
    --bg-light: #162a36;    /* lighter surface */
    --fg: #e2e8f0;          /* body text */
    --border: #2a3e4b;      /* borders */
    --header: #8ba8b8;      /* column headers */
    --primary: #4b6777;     /* primary brand */
    --primary-light: #6b8a9e;
    --accent: #6b8a9e;      /* active elements */
    --success: #4ade80;     /* green */
    --error: #f87171;       /* red */
}
```

### CDN dependencies
- CodeMirror 6 packages from `esm.sh` (view, state, lang-sql, theme-one-dark, commands, autocomplete, language, search)
- Font Awesome 6 from `cdnjs.cloudflare.com`

### Fonts
- UI: Inter (sans-serif)
- Code/editor: JetBrains Mono (monospace)

## Dot-commands

| Command | Behavior |
|---------|----------|
| `.help` | Returns help text as `print` message |
| `.tables` | Returns table list via `meta` message |
| `.schema <table>` | Returns column info as `print` message |
| `.load <file.csv> [as <name>]` | Loads CSV, returns `ok` message + meta refresh |
| `.save <table> <file.csv>` | Exports table, returns `ok` message |
| `.timer on\|off` | Toggles timing display |
| `.clear` | Sends `__CLEAR__` sentinel to clear result pane |

## Non-goals

- No authentication (local use only, binds to 127.0.0.1)
- No multiple simultaneous sessions (single Context)
- No query cancellation (executeSync is blocking)
- No saved queries / workspaces (beyond history)
- No chart/visualization
