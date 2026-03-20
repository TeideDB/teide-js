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
    uiHtml = uiHtml.replaceAll('__VERSION__', pkg.version);

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
                    send(ws, { type: 'print', text: 'Usage: .load <file.csv> [as <name>] [types <t1,t2,...>]' });
                    return;
                }
                const filePath = args[0];
                let tableName: string;
                const csvOpts: { columnTypes?: string[] } = {};

                // Parse: .load file [as name] [types t1,t2,...]
                let i = 1;
                if (i < args.length && args[i].toLowerCase() === 'as') {
                    tableName = args[i + 1] || path.basename(filePath, path.extname(filePath));
                    i += 2;
                } else {
                    tableName = path.basename(filePath, path.extname(filePath));
                }
                if (i < args.length && args[i].toLowerCase() === 'types') {
                    const typesStr = args[i + 1];
                    if (typesStr) csvOpts.columnTypes = typesStr.split(',').map(t => t.trim());
                    i += 2;
                }

                try {
                    const table = ctx.readCsvSync(filePath, Object.keys(csvOpts).length > 0 ? csvOpts : undefined);
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
