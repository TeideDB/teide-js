# Web REPL Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a browser-based SQL REPL with CodeMirror 6 editor, WebSocket query execution, and virtual-scrolling result tables — replacing the terminal REPL.

**Architecture:** Node.js HTTP server serves a single self-contained HTML page. WebSocket handles query execution, autocomplete, and metadata. The frontend uses CodeMirror 6 (from CDN) for SQL editing and a custom virtual scroller for large result tables.

**Tech Stack:** Node.js `http` module, `ws` package for WebSocket, CodeMirror 6 via esm.sh CDN, existing teide-js `Context`/`Session`/`Table`/`Series` APIs.

---

### Task 1: Clean Up Terminal REPL + Install Dependencies

Remove terminal-specific modules, install `ws`, remove `terminal-kit`.

**Files:**
- Delete: `lib/repl/input.ts`, `lib/repl/suggestions.ts`, `lib/repl/highlight.ts`, `lib/repl/completer.ts`, `lib/repl/validator.ts`, `lib/repl/index.ts`
- Delete: `test/repl/input.test.ts`, `test/repl/suggestions.test.ts`, `test/repl/highlight.test.ts`, `test/repl/completer.test.ts`, `test/repl/validator.test.ts`
- Modify: `lib/repl/formatter.ts` — export `getCellValue` and `isNumericType`, remove `stripAnsi` re-export
- Modify: `lib/repl/history.ts` — add `getAll(): string[]` method
- Modify: `lib/index.ts` — remove `startRepl` export
- Modify: `package.json` — replace `terminal-kit` with `ws`, add `@types/ws` devDep, update `repl` script

**Step 1: Delete terminal-specific files**

```bash
rm lib/repl/input.ts lib/repl/suggestions.ts lib/repl/highlight.ts lib/repl/completer.ts lib/repl/validator.ts lib/repl/index.ts
rm test/repl/input.test.ts test/repl/suggestions.test.ts test/repl/highlight.test.ts test/repl/completer.test.ts test/repl/validator.test.ts
```

**Step 2: Remove `terminal-kit`, install `ws`**

```bash
npm uninstall terminal-kit
npm install ws
npm install --save-dev @types/ws
```

**Step 3: Update `lib/repl/formatter.ts`**

Change the `stripAnsi` re-export and export the helper functions. Replace the first 6 lines:

Old:
```typescript
import { Table } from '../table';
import { Series } from '../series';
import * as theme from './theme';

export { stripAnsi } from './highlight';

interface FormatOpts {
```

New:
```typescript
import { Table } from '../table';
import { Series } from '../series';
import * as theme from './theme';

interface FormatOpts {
```

Then make `getCellValue` and `isNumericType` exported:
- Change `function getCellValue(` to `export function getCellValue(`
- Change `function isNumericType(` to `export function isNumericType(`

**Step 4: Update `lib/repl/history.ts`**

Add a `getAll()` method to the History class, right after the `length` getter:

```typescript
    getAll(): string[] { return [...this.entries]; }
```

**Step 5: Update `lib/index.ts`**

Remove the `startRepl` export line:
```typescript
export { startRepl } from './repl/index';
```

Replace with:
```typescript
export { startServer } from './repl/server';
```

**Step 6: Update `package.json`**

Change the `repl` script:
```json
"repl": "node dist/repl/server.js"
```

**Step 7: Run remaining tests**

```bash
npx vitest run test/repl/theme.test.ts test/repl/history.test.ts test/repl/formatter.test.ts
```

Expected: All pass (theme, history, formatter tests are independent of deleted modules).

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor(repl): remove terminal REPL, prepare for web REPL"
```

---

### Task 2: WebSocket Protocol Types

**Files:**
- Create: `lib/repl/protocol.ts`
- Test: `test/repl/protocol.test.ts`

**Step 1: Write the test**

```typescript
// test/repl/protocol.test.ts
import { describe, it, expect } from 'vitest';
import {
    ClientMessage,
    ServerMessage,
    parseClientMessage,
    Column,
} from '../../lib/repl/protocol';

describe('protocol', () => {
    it('parses query message', () => {
        const raw = JSON.stringify({ type: 'query', id: '1', sql: 'SELECT 1;' });
        const msg = parseClientMessage(raw);
        expect(msg).toEqual({ type: 'query', id: '1', sql: 'SELECT 1;' });
    });

    it('parses complete message', () => {
        const raw = JSON.stringify({ type: 'complete', prefix: 'SEL', context: 'SEL' });
        const msg = parseClientMessage(raw);
        expect(msg).toEqual({ type: 'complete', prefix: 'SEL', context: 'SEL' });
    });

    it('parses dot message', () => {
        const raw = JSON.stringify({ type: 'dot', command: '.tables' });
        const msg = parseClientMessage(raw);
        expect(msg).toEqual({ type: 'dot', command: '.tables' });
    });

    it('parses meta message', () => {
        const raw = JSON.stringify({ type: 'meta' });
        const msg = parseClientMessage(raw);
        expect(msg).toEqual({ type: 'meta' });
    });

    it('returns null for invalid JSON', () => {
        expect(parseClientMessage('not json')).toBeNull();
    });

    it('returns null for unknown type', () => {
        expect(parseClientMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/repl/protocol.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// lib/repl/protocol.ts

export interface Column {
    name: string;
    dtype: string;
}

// --- Client → Server ---

export interface QueryMessage {
    type: 'query';
    id: string;
    sql: string;
}

export interface CompleteMessage {
    type: 'complete';
    prefix: string;
    context: string;
}

export interface DotMessage {
    type: 'dot';
    command: string;
}

export interface MetaMessage {
    type: 'meta';
}

export type ClientMessage = QueryMessage | CompleteMessage | DotMessage | MetaMessage;

// --- Server → Client ---

export interface ResultMessage {
    type: 'result';
    id: string;
    columns: Column[];
    rows: (string | null)[][];
    nrows: number;
    elapsed: number;
}

export interface ErrorMessage {
    type: 'error';
    id: string;
    message: string;
}

export interface OkMessage {
    type: 'ok';
    id: string;
    message: string;
    elapsed: number;
}

export interface CompletionsMessage {
    type: 'completions';
    items: { value: string; description: string }[];
}

export interface MetaResponseMessage {
    type: 'meta';
    tables: { name: string; nrows: number; ncols: number; columns: Column[] }[];
    history: string[];
}

export interface PrintMessage {
    type: 'print';
    text: string;
}

export type ServerMessage =
    | ResultMessage
    | ErrorMessage
    | OkMessage
    | CompletionsMessage
    | MetaResponseMessage
    | PrintMessage;

const VALID_CLIENT_TYPES = new Set(['query', 'complete', 'dot', 'meta']);

export function parseClientMessage(raw: string): ClientMessage | null {
    try {
        const obj = JSON.parse(raw);
        if (!obj || !VALID_CLIENT_TYPES.has(obj.type)) return null;
        return obj as ClientMessage;
    } catch {
        return null;
    }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/repl/protocol.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/repl/protocol.ts test/repl/protocol.test.ts
git commit -m "feat(repl): add WebSocket protocol types"
```

---

### Task 3: Server — Table Serialization Helper

Extract the logic to serialize a `Table` into JSON-friendly rows for the WebSocket result message. This reuses `getCellValue` from the formatter.

**Files:**
- Create: `lib/repl/serialize.ts`
- Test: `test/repl/serialize.test.ts`

**Step 1: Write the test**

```typescript
// test/repl/serialize.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '../../lib';
import { serializeTable } from '../../lib/repl/serialize';
import path from 'path';

describe('serializeTable', () => {
    let ctx: Context;

    beforeEach(() => { ctx = new Context(); });
    afterEach(() => { ctx.destroy(); });

    it('serializes table to columns and rows', () => {
        const table = ctx.readCsvSync(path.join(__dirname, '..', 'fixtures', 'small.csv'));
        const result = serializeTable(table);

        expect(result.columns).toBeInstanceOf(Array);
        expect(result.columns.length).toBeGreaterThan(0);
        expect(result.columns[0]).toHaveProperty('name');
        expect(result.columns[0]).toHaveProperty('dtype');

        expect(result.rows).toBeInstanceOf(Array);
        expect(result.rows.length).toBe(table.nRows);
        expect(result.nrows).toBe(table.nRows);
    });

    it('rows contain string or null values', () => {
        const table = ctx.readCsvSync(path.join(__dirname, '..', 'fixtures', 'small.csv'));
        const result = serializeTable(table);

        for (const row of result.rows) {
            for (const cell of row) {
                expect(cell === null || typeof cell === 'string').toBe(true);
            }
        }
    });

    it('column dtypes are valid', () => {
        const table = ctx.readCsvSync(path.join(__dirname, '..', 'fixtures', 'small.csv'));
        const result = serializeTable(table);

        for (const col of result.columns) {
            expect(typeof col.dtype).toBe('string');
            expect(col.dtype.length).toBeGreaterThan(0);
        }
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/repl/serialize.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// lib/repl/serialize.ts
import { Table } from '../table';
import { getCellValue } from './formatter';
import type { Column } from './protocol';

export interface SerializedTable {
    columns: Column[];
    rows: (string | null)[][];
    nrows: number;
}

export function serializeTable(table: Table): SerializedTable {
    const colNames = table.columns;
    const series = colNames.map(c => table.col(c));

    const columns: Column[] = series.map((s, i) => ({
        name: colNames[i],
        dtype: s.dtype,
    }));

    const rows: (string | null)[][] = [];
    for (let r = 0; r < table.nRows; r++) {
        rows.push(series.map(s => getCellValue(s, r)));
    }

    return { columns, rows, nrows: table.nRows };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/repl/serialize.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/repl/serialize.ts test/repl/serialize.test.ts
git commit -m "feat(repl): add table serialization for WebSocket results"
```

---

### Task 4: Server — SQL Autocomplete Logic

Move autocomplete logic to a server-side module (no terminal dependencies). Reuse fuzzy matching and context detection from the old completer but simplified.

**Files:**
- Create: `lib/repl/autocomplete.ts`
- Test: `test/repl/autocomplete.test.ts`

**Step 1: Write the test**

```typescript
// test/repl/autocomplete.test.ts
import { describe, it, expect } from 'vitest';
import { getCompletions } from '../../lib/repl/autocomplete';

describe('getCompletions', () => {
    it('completes SQL keywords', () => {
        const items = getCompletions('SEL', 'SEL', [], []);
        expect(items.some(i => i.value === 'SELECT')).toBe(true);
    });

    it('completes table names after FROM', () => {
        const tables = [{ name: 'users', nrows: 10, ncols: 3 }];
        const items = getCompletions('us', 'SELECT * FROM us', tables, []);
        expect(items.some(i => i.value === 'users')).toBe(true);
    });

    it('completes column names after SELECT', () => {
        const cols = [{ name: 'age', dtype: 'i64' }];
        const items = getCompletions('ag', 'SELECT ag', [], cols);
        expect(items.some(i => i.value === 'age')).toBe(true);
    });

    it('returns empty for empty prefix', () => {
        const items = getCompletions('', 'SELECT ', [], []);
        expect(items).toEqual([]);
    });

    it('is case-insensitive', () => {
        const items = getCompletions('sel', 'sel', [], []);
        expect(items.some(i => i.value === 'SELECT')).toBe(true);
    });

    it('completes dot-commands', () => {
        const items = getCompletions('.ta', '.ta', [], []);
        expect(items.some(i => i.value === '.tables')).toBe(true);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/repl/autocomplete.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// lib/repl/autocomplete.ts
import type { Column } from './protocol';

interface CompletionItem {
    value: string;
    description: string;
}

interface TableMeta {
    name: string;
    nrows: number;
    ncols: number;
}

const SQL_KEYWORDS = [
    'SELECT','FROM','WHERE','GROUP','BY','ORDER','LIMIT','AS','ON',
    'JOIN','LEFT','RIGHT','INNER','OUTER','CROSS','HAVING','DISTINCT',
    'UNION','ALL','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
    'CREATE','TABLE','DROP','ALTER','INDEX','VIEW','CASE','WHEN',
    'THEN','ELSE','END','IN','BETWEEN','LIKE','IS','NULL','EXISTS',
    'ASC','DESC','OFFSET','WITH','RECURSIVE','EXCEPT','INTERSECT',
    'OVER','PARTITION','WINDOW','ROWS','RANGE','UNBOUNDED',
    'PRECEDING','FOLLOWING','CURRENT','ROW',
];

const AGG_FUNCTIONS: [string, string][] = [
    ['SUM', 'SUM(col) → sum'],
    ['AVG', 'AVG(col) → average'],
    ['MIN', 'MIN(col) → minimum'],
    ['MAX', 'MAX(col) → maximum'],
    ['COUNT', 'COUNT(col) → count'],
    ['ROW_NUMBER', 'ROW_NUMBER() OVER(...)'],
    ['RANK', 'RANK() OVER(...)'],
    ['DENSE_RANK', 'DENSE_RANK() OVER(...)'],
    ['LAG', 'LAG(col, offset) OVER(...)'],
    ['LEAD', 'LEAD(col, offset) OVER(...)'],
];

const DOT_COMMANDS: [string, string][] = [
    ['.help', 'Show available commands'],
    ['.tables', 'List stored tables'],
    ['.schema', 'Show table schema'],
    ['.load', 'Load CSV file'],
    ['.save', 'Export table to CSV'],
    ['.clear', 'Clear results'],
    ['.timer', 'Toggle timing: on|off'],
];

function fuzzyMatch(pattern: string, candidate: string): number {
    const pat = pattern.toLowerCase();
    const cand = candidate.toLowerCase();
    let pi = 0;
    let score = 0;
    let prevMatch = false;

    for (let ci = 0; ci < cand.length && pi < pat.length; ci++) {
        if (cand[ci] === pat[pi]) {
            score += prevMatch ? 3 : 1;
            if (ci === 0) score += 5;
            prevMatch = true;
            pi++;
        } else {
            prevMatch = false;
        }
    }

    return pi === pat.length ? score : 0;
}

type Context = 'table' | 'column' | 'dot' | 'general';

function detectContext(before: string): Context {
    const upper = before.toUpperCase();
    if (upper.trimStart().startsWith('.')) return 'dot';

    const tableKws = ['FROM ', 'JOIN '];
    const colKws = ['SELECT ', 'WHERE ', 'BY ', 'HAVING ', 'ON ', 'SET ', 'ORDER BY '];

    let lastTable = -1;
    let lastCol = -1;

    for (const kw of tableKws) {
        const pos = upper.lastIndexOf(kw);
        if (pos > lastTable) lastTable = pos;
    }
    for (const kw of colKws) {
        const pos = upper.lastIndexOf(kw);
        if (pos > lastCol) lastCol = pos;
    }

    if (lastTable > lastCol) return 'table';
    if (lastCol >= 0) return 'column';
    return 'general';
}

export function getCompletions(
    prefix: string,
    fullContext: string,
    tables: TableMeta[],
    columns: Column[],
): CompletionItem[] {
    const ctx = detectContext(fullContext);

    if (ctx === 'dot') {
        return DOT_COMMANDS
            .filter(([cmd]) => fuzzyMatch(prefix, cmd) > 0)
            .map(([cmd, desc]) => ({ value: cmd, description: desc }));
    }

    if (prefix.length === 0) return [];

    const candidates: { score: number; item: CompletionItem }[] = [];

    if (ctx === 'table' || ctx === 'general') {
        for (const t of tables) {
            const s = fuzzyMatch(prefix, t.name);
            if (s > 0) candidates.push({ score: s, item: { value: t.name, description: `table — ${t.nrows} rows` } });
        }
    }

    if (ctx === 'column' || ctx === 'general') {
        for (const col of columns) {
            const s = fuzzyMatch(prefix, col.name);
            if (s > 0) candidates.push({ score: s, item: { value: col.name, description: col.dtype } });
        }
    }

    for (const [name, desc] of AGG_FUNCTIONS) {
        const s = fuzzyMatch(prefix, name);
        if (s > 0) candidates.push({ score: s, item: { value: name, description: desc } });
    }

    for (const kw of SQL_KEYWORDS) {
        const s = fuzzyMatch(prefix, kw);
        if (s > 0) candidates.push({ score: s, item: { value: kw, description: 'keyword' } });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.map(c => c.item);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/repl/autocomplete.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/repl/autocomplete.ts test/repl/autocomplete.test.ts
git commit -m "feat(repl): add server-side SQL autocomplete"
```

---

### Task 5: HTTP + WebSocket Server

The core server module. Creates an HTTP server to serve the UI HTML file, and a WebSocket server to handle query execution, autocomplete, and metadata requests.

**Files:**
- Create: `lib/repl/server.ts`
- Modify: `bin/teide.js`

**Step 1: Write the server**

```typescript
// lib/repl/server.ts
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { Context } from '../context';
import { Session } from '../sql/session';
import { History } from './history';
import { serializeTable } from './serialize';
import { getCompletions } from './autocomplete';
import { parseClientMessage, ServerMessage, Column } from './protocol';

export function startServer(opts?: { port?: number; noOpen?: boolean }): void {
    const ctx = new Context();
    const session: Session = (ctx as any)._session;
    const historyPath = path.join(os.homedir(), '.teidedb_history');
    const history = new History(historyPath);
    let showTimer = true;

    // Track known columns for autocomplete
    let knownColumns: Column[] = [];

    const uiPath = path.join(__dirname, 'ui.html');
    let uiHtml: string;
    try {
        uiHtml = fs.readFileSync(uiPath, 'utf8');
    } catch {
        // In development, ui.html might be in lib/repl/ (source dir)
        uiHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'repl', 'ui.html'), 'utf8');
    }

    // Inject version
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    uiHtml = uiHtml.replace('__VERSION__', pkg.version);

    const server = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(uiHtml);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws: WebSocket) => {
        ws.on('message', (data: Buffer | string) => {
            const raw = typeof data === 'string' ? data : data.toString('utf8');
            const msg = parseClientMessage(raw);
            if (!msg) return;

            switch (msg.type) {
                case 'query':
                    handleQuery(msg.id, msg.sql, ws);
                    break;
                case 'complete':
                    handleComplete(msg.prefix, msg.context, ws);
                    break;
                case 'dot':
                    handleDot(msg.command, ws);
                    break;
                case 'meta':
                    handleMeta(ws);
                    break;
            }
        });

        // Send initial meta on connect
        handleMeta(ws);
    });

    function send(ws: WebSocket, msg: ServerMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    function handleQuery(id: string, sql: string, ws: WebSocket): void {
        const trimmed = sql.trim().replace(/;$/, '').trim();
        if (trimmed.length === 0) return;

        // Check for dot-command
        if (trimmed.startsWith('.')) {
            handleDot(trimmed, ws);
            return;
        }

        const start = performance.now();
        try {
            const result = ctx.executeSync(trimmed);
            const elapsed = performance.now() - start;

            if (result) {
                const serialized = serializeTable(result);
                // Update known columns
                knownColumns = serialized.columns;

                send(ws, {
                    type: 'result',
                    id,
                    columns: serialized.columns,
                    rows: serialized.rows,
                    nrows: serialized.nrows,
                    elapsed,
                });
            } else {
                send(ws, {
                    type: 'ok',
                    id,
                    message: 'OK',
                    elapsed: performance.now() - start,
                });
            }

            history.add(sql);
            history.save();
        } catch (e: any) {
            send(ws, { type: 'error', id, message: e.message });
        }
    }

    function handleComplete(prefix: string, context: string, ws: WebSocket): void {
        const tables = getTableMeta();
        const items = getCompletions(prefix, context, tables, knownColumns);
        send(ws, { type: 'completions', items });
    }

    function handleDot(command: string, ws: WebSocket): void {
        const parts = command.split(/\s+/);
        const cmd = parts[0].toLowerCase();

        switch (cmd) {
            case '.help':
                send(ws, { type: 'print', text: [
                    'Commands:',
                    '  .help                 Show this help',
                    '  .tables               List stored tables',
                    '  .schema <table>       Show column names and types',
                    '  .load <file> [as <n>] Load CSV file',
                    '  .save <table> <file>  Export table to CSV',
                    '  .timer on|off         Toggle query timing',
                    '  .clear                Clear results',
                    '',
                    'SQL:',
                    "  SELECT * FROM 'data.csv' WHERE id > 10;",
                    "  CREATE TABLE t AS SELECT * FROM 'data.csv';",
                ].join('\n') });
                break;

            case '.tables':
                handleMeta(ws);
                break;

            case '.schema': {
                const tableName = parts[1];
                if (!tableName) {
                    send(ws, { type: 'print', text: 'Usage: .schema <table>' });
                    return;
                }
                const stored = session.get(tableName);
                if (!stored) {
                    send(ws, { type: 'error', id: '', message: `Table '${tableName}' not found` });
                    return;
                }
                const cols = stored.columns.map(name => {
                    const s = stored.table.col(name);
                    return `  ${name.padEnd(20)} ${s.dtype}`;
                });
                send(ws, { type: 'print', text: cols.join('\n') });
                break;
            }

            case '.load': {
                const args = parts.slice(1);
                if (args.length === 0) {
                    send(ws, { type: 'print', text: 'Usage: .load <file.csv> [as <name>]' });
                    return;
                }
                const filePath = args[0];
                let tableName: string;
                if (args.length >= 3 && args[1].toLowerCase() === 'as') {
                    tableName = args[2];
                } else {
                    tableName = path.basename(filePath, path.extname(filePath));
                }
                try {
                    const table = ctx.readCsvSync(filePath);
                    ctx.registerTable(tableName, table);
                    send(ws, { type: 'ok', id: '', message: `Loaded ${filePath} as '${tableName}' (${table.nRows} rows, ${table.nCols} cols)`, elapsed: 0 });
                    handleMeta(ws);
                } catch (e: any) {
                    send(ws, { type: 'error', id: '', message: `Error loading ${filePath}: ${e.message}` });
                }
                break;
            }

            case '.save': {
                const tableName = parts[1];
                const filePath = parts[2];
                if (!tableName || !filePath) {
                    send(ws, { type: 'print', text: 'Usage: .save <table> <file.csv>' });
                    return;
                }
                const stored = session.get(tableName);
                if (!stored) {
                    send(ws, { type: 'error', id: '', message: `Table '${tableName}' not found` });
                    return;
                }
                try {
                    ctx.writeCsvSync(stored.table, filePath);
                    send(ws, { type: 'ok', id: '', message: `Saved '${tableName}' to ${filePath}`, elapsed: 0 });
                } catch (e: any) {
                    send(ws, { type: 'error', id: '', message: `Error: ${e.message}` });
                }
                break;
            }

            case '.timer':
                if (parts[1] === 'on') showTimer = true;
                else if (parts[1] === 'off') showTimer = false;
                send(ws, { type: 'print', text: `Timer: ${showTimer ? 'on' : 'off'}` });
                break;

            case '.clear':
                send(ws, { type: 'print', text: '__CLEAR__' });
                break;

            default:
                send(ws, { type: 'error', id: '', message: `Unknown command: ${cmd}. Type .help for commands.` });
        }
    }

    function handleMeta(ws: WebSocket): void {
        const tables = getTableMeta();
        const tablesWithColumns = tables.map(t => {
            const stored = session.get(t.name);
            const columns: Column[] = stored
                ? stored.columns.map(name => ({ name, dtype: stored.table.col(name).dtype }))
                : [];
            return { ...t, columns };
        });
        send(ws, { type: 'meta', tables: tablesWithColumns, history: history.getAll() });
    }

    function getTableMeta() {
        return session.listTables().map(name => {
            const stored = session.get(name);
            return {
                name,
                nrows: stored ? stored.table.nRows : 0,
                ncols: stored ? stored.columns.length : 0,
            };
        });
    }

    // Find a free port
    const basePort = opts?.port ?? 3141;
    function tryListen(port: number): void {
        server.listen(port, '127.0.0.1', () => {
            const url = `http://127.0.0.1:${port}`;
            console.log(`TeideDB v${pkg.version} — ${url}`);

            if (!opts?.noOpen) {
                const { exec } = require('child_process');
                const cmd = process.platform === 'darwin' ? 'open'
                    : process.platform === 'win32' ? 'start' : 'xdg-open';
                exec(`${cmd} ${url}`);
            }
        });

        server.on('error', (e: any) => {
            if (e.code === 'EADDRINUSE' && port < basePort + 10) {
                tryListen(port + 1);
            } else {
                console.error(`Error: ${e.message}`);
                process.exit(1);
            }
        });
    }

    tryListen(basePort);

    // Graceful shutdown
    function shutdown(): void {
        console.log('\nShutting down...');
        history.save();
        wss.close();
        server.close();
        ctx.destroy();
        process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
```

**Step 2: Update `bin/teide.js`**

```javascript
#!/usr/bin/env node
require('../dist/repl/server').startServer();
```

**Step 3: Build and verify**

```bash
npm run build:ts
```

Expected: Compiles cleanly. The server won't fully work yet (no `ui.html`), but TypeScript should compile.

**Step 4: Commit**

```bash
git add lib/repl/server.ts bin/teide.js
git commit -m "feat(repl): add HTTP + WebSocket server"
```

---

### Task 6: Frontend — HTML UI with CodeMirror and Virtual Scroller

The single self-contained HTML page. This is the largest task. It includes:
- CodeMirror 6 editor with SQL mode and autocomplete
- WebSocket client connecting to the server
- Virtual-scrolling result table
- Dark theme CSS
- Query history panel
- Table sidebar

**Files:**
- Create: `lib/repl/ui.html`

**Step 1: Create the HTML file**

This is a large self-contained HTML file. Key sections:

1. **CSS** — dark theme, layout grid, editor styling, result table, virtual scroller
2. **HTML** — header bar, editor container, result pane, sidebar panels
3. **JS** — CodeMirror setup (from esm.sh CDN), WebSocket client, virtual scroller, autocomplete bridge

The HTML must be self-contained — all JS/CSS inline, external deps loaded from CDN via ES module imports.

Write the complete `lib/repl/ui.html` file. Requirements:

- **Header**: "TeideDB v__VERSION__" (replaced by server at serve time)
- **Editor**: CodeMirror 6 with `@codemirror/lang-sql`, dark theme, Ctrl+Enter to execute
- **Autocomplete**: CodeMirror autocomplete extension, fetches from WebSocket `complete` message
- **Results**: Virtual-scrolling table — only render visible rows, fixed 28px row height, monospace font
- **Status bar**: "N rows × M columns · Xms" after each query, or error message in red
- **Sidebar**: Table list (from `meta` response), query history (clickable)
- **Export**: CSV download button, JSON download button

- **CDN imports** from `https://esm.sh/`:
  - `codemirror` (the core)
  - `@codemirror/lang-sql`
  - `@codemirror/autocomplete`
  - `@codemirror/view`
  - `@codemirror/state`
  - `@codemirror/theme-one-dark`
  - `@codemirror/commands`

- **CSS variables** matching the design doc:
  ```css
  :root {
      --bg: #1e1e2e;
      --bg-surface: #181825;
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
      --accent: #89b4fa;
  }
  ```

- **Virtual scroller implementation**:
  - Container div with `overflow-y: auto`, fixed height (50vh)
  - Inner spacer div with height = `totalRows * ROW_HEIGHT`
  - On scroll event: compute `startRow = scrollTop / ROW_HEIGHT`, render ~60 rows centered on viewport
  - Each row is absolutely positioned with `top: row * ROW_HEIGHT`
  - Column widths auto-sized on first render, then fixed

NOTE: This is a large file (500+ lines of HTML/CSS/JS). Write it completely — do not use placeholders. The subagent should create this file from scratch based on the requirements above and test it by opening it in a browser.

**Step 2: Copy ui.html to dist**

Add to `package.json` scripts or tsconfig to copy `lib/repl/ui.html` to `dist/repl/ui.html`. The simplest approach: add a postbuild copy command.

Add to `package.json` scripts:
```json
"build:ts": "tsc && cp lib/repl/ui.html dist/repl/ui.html"
```

**Step 3: Build and smoke test**

```bash
npm run build:ts
node bin/teide.js
```

Expected: Browser opens, CodeMirror editor loads, WebSocket connects. Typing SQL and pressing Ctrl+Enter sends query. Results display in virtual-scrolling table.

**Step 4: Commit**

```bash
git add lib/repl/ui.html package.json
git commit -m "feat(repl): add browser UI with CodeMirror and virtual-scrolling table"
```

---

### Task 7: Integration Testing + Polish

**Step 1: Build everything**

```bash
npm run build:ts
```

**Step 2: Run unit tests**

```bash
npx vitest run test/repl/
```

Expected: All test files pass (theme, history, formatter, protocol, serialize, autocomplete).

**Step 3: Run full test suite**

```bash
npm test
```

Expected: No regressions in existing tests.

**Step 4: Manual smoke test**

```bash
node bin/teide.js
```

Test the full flow in the browser:
1. Browser opens automatically to `http://127.0.0.1:3141`
2. CodeMirror editor loads with dark theme
3. Type `.load test/fixtures/sales.csv` and Ctrl+Enter → "Loaded" message, table appears in sidebar
4. Type `SELECT * FROM sales;` and Ctrl+Enter → result table renders with columns and data
5. Type `SELECT category, SUM(price) FROM sales GROUP BY category;` → aggregation works
6. Tab completion shows SQL keywords
7. History panel shows previous queries (clickable)
8. Table sidebar shows registered tables
9. Export CSV/JSON buttons work
10. Ctrl+C in terminal stops the server cleanly

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: complete TeideDB web REPL with CodeMirror, WebSocket, and virtual-scrolling tables"
```
