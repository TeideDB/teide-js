# TeideDB JavaScript REPL — Design Document

## Overview

A full-featured SQL REPL for teide-js, matching the experience of the Rust `teide-rs` CLI. SQL-first with unicode table output, IdeMenu-style suggestion popups, syntax highlighting, multi-line input, and persistent history. No new runtime dependencies — built on Node.js raw stdin and the existing `Session`/`Context` APIs.

## Architecture

```
bin/teide.js              — shebang wrapper (#! /usr/bin/env node)
lib/repl/index.ts         — main loop: read → parse → execute → display
lib/repl/input.ts         — raw stdin input engine (keypress handling, line buffer)
lib/repl/suggestions.ts   — IdeMenu-style popup (fuzzy match, ANSI rendering)
lib/repl/completer.ts     — context-aware completion (table/column/keyword/dot-command)
lib/repl/highlight.ts     — SQL syntax colorizer (ANSI escape codes on prompt line)
lib/repl/validator.ts     — multi-line detection (semicolons + balanced parens)
lib/repl/formatter.ts     — unicode box table renderer + CSV + JSON output
lib/repl/history.ts       — persistent history (~/.teidedb_history)
lib/repl/theme.ts         — ANSI 16-color constants (adapts to dark/light terminals)
```

## Entry Point

```
package.json:
  "bin": { "teide": "bin/teide.js" }
```

`npm install -g teidedb` → `teide` command. `npx teidedb` works without install.

### Startup

```
╭─ Teide SQL ─────────────────╮
│ v0.1.1                      │
│ type .help for commands      │
╰─────────────────────────────╯

▸
```

Banner uses rounded-corner unicode box characters (`╭╮╰╯`), matching the Rust REPL style. The `▸` prompt glyph matches teide-rs.

## Input Engine (`input.ts`)

Custom input engine on `process.stdin` in raw mode. No readline dependency.

### Keypress handling

| Key | Action |
|-----|--------|
| Printable chars | Insert at cursor, re-render, update suggestions |
| Backspace / Delete | Remove char, re-render |
| Left / Right | Move cursor |
| Home / Ctrl+A | Move to line start |
| End / Ctrl+E | Move to line end |
| Ctrl+W | Delete word backward |
| Ctrl+U | Delete to line start |
| Ctrl+K | Delete to line end |
| Up / Down | History navigation (dismiss popup first) |
| Tab | Open/accept suggestion |
| Shift+Tab | Previous suggestion |
| Escape | Dismiss popup |
| Enter | Submit if valid, else newline (continuation) |
| Ctrl+C | Cancel current input |
| Ctrl+D | Exit REPL (on empty line) |

### Multi-line

When the validator reports `incomplete` (no trailing `;` or unbalanced parens), Enter inserts a newline and the prompt changes to `  ··· `. The full buffer is re-highlighted across lines.

## Suggestion Popup (`suggestions.ts`)

IdeMenu-style bordered popup rendered below the cursor using ANSI escape sequences.

### Rendering

```
▸ SELECT na
  ┌──────────────────────────────────┐
  │ name              sym            │
  │ nationality       sym            │
  └──────────────────────────────────┘
```

- Max 8 visible items, scrollable
- Selected item highlighted (reverse video)
- Right-aligned type/description column
- Arrow up/down to navigate, Enter/Tab to accept, Escape to dismiss
- Cursor save/restore (`\x1b[s` / `\x1b[u`) for flicker-free updates

### Trigger

Popup appears after 1+ character typed. Dismissed on Escape, accept, or when no matches.

## Completer (`completer.ts`)

Port of the Rust `SqlCompleter` — context-aware fuzzy matching.

### Context detection

Scans text before cursor for the last relevant SQL keyword:

| Last keyword | Context | Candidates |
|-------------|---------|------------|
| `FROM`, `JOIN` | Table | Session table names, CSV files in cwd |
| `SELECT`, `WHERE`, `BY`, `HAVING`, `ON`, `SET`, `ORDER BY` | Column | Column names from last result |
| `.` prefix | Dot-command | Dot-command list |
| Other | General | Columns + keywords + functions + tables |

### Fuzzy matching

Subsequence fuzzy match with scoring (ported from Rust):
- Consecutive character bonus (+3)
- Prefix match bonus (+5)
- Results sorted by score descending

### Dynamic state

After each query execution:
- `Query` results → update known column names + types
- `DDL` results → update known table names + row/column counts

## Syntax Highlighting (`highlight.ts`)

Colorizes the buffer on every keystroke. Ported from the Rust `SqlHighlighter`.

| Token | Color |
|-------|-------|
| SQL keywords (`SELECT`, `FROM`, etc.) | Bold blue |
| Functions (`COUNT`, `SUM`, `AVG`, etc.) | Bold cyan |
| Operators (`AND`, `OR`, `NOT`) | Bold blue |
| Comparison (`=`, `<>`, `>=`) | Bold blue |
| String literals (`'...'`) | Yellow |
| Numbers | Magenta |
| Dot-commands | Cyan |
| Identifiers | Default foreground |

Uses the terminal's 16-color ANSI palette — automatically adapts to dark/light themes.

## Validator (`validator.ts`)

Determines whether input is complete (ready to execute) or incomplete (continue on next line).

Rules (matching Rust `SqlValidator`):
1. Empty input → complete (no-op)
2. Dot-commands (starts with `.`) → always complete
3. Unbalanced parentheses (skipping quoted strings) → incomplete
4. No trailing `;` → incomplete
5. Otherwise → complete

## Formatter (`formatter.ts`)

### Unicode table output

```
┌────────┬─────┬──────────┐
│  name  │ age │   city   │
│  sym   │ i64 │   sym    │
├────────┼─────┼──────────┤
│ Alice  │  30 │ Seattle  │
│ Bob    │  25 │ Portland │
│ Carol  │  35 │ Seattle  │
├────────┴─────┴──────────┤
│ 3 rows          3 columns│
└─────────────────────────┘
```

Matching the Rust `print_table` layout:
- Header row: bold cyan, centered
- Type row: dim grey, centered
- Numbers: right-aligned
- Strings: left-aligned
- NULL: dim grey italic
- Footer: row count + column count in a bottom panel
- Long tables (>40 rows): show first 20 + `···` + last 20
- Column widths: auto-sized to content, footer width is minimum
- Single buffered write to stdout (avoids per-line flush overhead)

### CSV output

Standard CSV with quoting for values containing `,`, `"`, or newlines.

### JSON output

Array of objects, one per row.

### Mode switching

`.mode table|csv|json` switches the active formatter.

## Dot-Commands

| Command | Description |
|---------|-------------|
| `.help` | Show all commands |
| `.tables` | List registered tables with row/column counts |
| `.schema <table>` | Show column names and types |
| `.load <file.csv> [as <name>]` | Load CSV into session (name defaults to filename stem) |
| `.save <table> <file.csv>` | Export table to CSV |
| `.mode table\|csv\|json` | Set output format |
| `.timer on\|off` | Toggle query timing display |
| `.limit [n]` | Get/set max displayed rows (default 40) |
| `.width [n]` | Get/set max column char width (default 40) |
| `.clear` | Clear screen |
| `.quit` / `.exit` | Exit REPL |

Dot-commands are case-insensitive. Unknown commands print an error with `.help` hint.

## History (`history.ts`)

- File: `~/.teidedb_history`
- Max 1000 entries, deduplicated
- Loaded on startup, appended on each successful execution
- Up/Down arrows cycle through history
- Multi-line statements stored as single entries (newlines preserved)

## Theme (`theme.ts`)

ANSI 16-color constants matching the Rust `theme.rs`:

```typescript
// Formatting
export const BOLD = '\x1b[1m';
export const ITALIC = '\x1b[3m';
export const R = '\x1b[0m';

// Table structure
export const BORDER = '\x1b[90m';
export const HEADER = '\x1b[1;36m';
export const TYPE_DIM = '\x1b[90m';
export const TEXT = '\x1b[39m';
export const NULL_CLR = '\x1b[90m';
export const FOOTER = '\x1b[90m';

// Status
export const ERROR = '\x1b[1;31m';
export const SUCCESS = '\x1b[32m';
export const TIMER = '\x1b[90m';

// Banner
export const BAN_BORDER = '\x1b[34m';
export const BAN_TITLE = '\x1b[1;36m';
export const BAN_INFO = '\x1b[39m';
export const BAN_HELP = '\x1b[90m';
```

## Execution Flow

1. Create `Context` and `Session` on startup
2. Display banner
3. Enter input loop:
   a. Render prompt (`▸` or `···`)
   b. Read keypress, update buffer
   c. Re-render highlighted buffer + suggestion popup
   d. On Enter with valid input:
      - Dot-command → dispatch to handler
      - SQL → `session.execute(sql)` → format result → print
      - Update completion state (columns/tables)
      - Append to history
4. On Ctrl+D → cleanup and exit

## Non-goals

- No JS/TS expression evaluation (SQL-only)
- No remote connections (local session only)
- No plugin system
- No mouse support
