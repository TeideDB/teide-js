import { Context } from '../context';
import { Table } from '../table';
import { Session } from '../sql/session';
import { validate } from './validator';
import { highlight, stripAnsi } from './highlight';
import { formatTable, formatCsv, formatJson } from './formatter';
import { History } from './history';
import { SqlCompleter, Suggestion } from './completer';
import { SuggestionBox } from './suggestions';
import { LineBuffer } from './input';
import * as theme from './theme';
import path from 'path';
import os from 'os';

type OutputFormat = 'table' | 'csv' | 'json';

interface ReplState {
    ctx: Context;
    session: Session;
    completer: SqlCompleter;
    history: History;
    format: OutputFormat;
    showTimer: boolean;
    maxRows: number;
    maxColWidth: number;
}

let previousPopupHeight = 0;

export function startRepl(): void {
    const ctx = new Context();
    // Access private _session. This is the session that ctx.executeSync() uses.
    const session: Session = (ctx as any)._session;
    const historyPath = path.join(os.homedir(), '.teidedb_history');

    const state: ReplState = {
        ctx,
        session,
        completer: new SqlCompleter(),
        history: new History(historyPath),
        format: 'table',
        showTimer: true,
        maxRows: 40,
        maxColWidth: 40,
    };

    printBanner();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const lineBuf = new LineBuffer();
    let multiLineBuffer = '';
    let isMultiLine = false;
    let popup: SuggestionBox | null = null;

    renderPrompt(lineBuf, isMultiLine, popup);

    stdin.on('data', (data: string) => {
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            const code = data.charCodeAt(i);

            // Escape sequences
            if (ch === '\x1b' && data[i + 1] === '[') {
                const seq = data[i + 2];
                i += 2;
                if (seq === 'A') { // Up
                    if (popup) { popup.moveUp(); }
                    else {
                        const prev = state.history.up();
                        if (prev !== null) {
                            multiLineBuffer = '';
                            isMultiLine = prev.includes('\n');
                            lineBuf.setText(isMultiLine ? prev.split('\n').pop()! : prev);
                            if (isMultiLine) multiLineBuffer = prev.split('\n').slice(0, -1).join('\n') + '\n';
                        }
                    }
                } else if (seq === 'B') { // Down
                    if (popup) { popup.moveDown(); }
                    else {
                        const next = state.history.down();
                        if (next !== null) {
                            multiLineBuffer = '';
                            isMultiLine = next.includes('\n');
                            lineBuf.setText(isMultiLine ? next.split('\n').pop()! : next);
                            if (isMultiLine) multiLineBuffer = next.split('\n').slice(0, -1).join('\n') + '\n';
                        } else {
                            lineBuf.clear();
                            multiLineBuffer = '';
                            isMultiLine = false;
                        }
                    }
                } else if (seq === 'C') { // Right
                    lineBuf.moveRight();
                    popup = null;
                } else if (seq === 'D') { // Left
                    lineBuf.moveLeft();
                    popup = null;
                } else if (seq === 'H') { // Home
                    lineBuf.moveHome();
                    popup = null;
                } else if (seq === 'F') { // End
                    lineBuf.moveEnd();
                    popup = null;
                } else if (seq === 'Z') { // Shift+Tab
                    if (popup) popup.moveUp();
                }
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Ctrl+D
            if (code === 4) {
                if (lineBuf.text.length === 0 && multiLineBuffer.length === 0) {
                    process.stdout.write('\n');
                    state.history.save();
                    state.ctx.destroy();
                    process.exit(0);
                }
                continue;
            }

            // Ctrl+C
            if (code === 3) {
                lineBuf.clear();
                multiLineBuffer = '';
                isMultiLine = false;
                popup = null;
                state.history.resetCursor();
                process.stdout.write('\n');
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Ctrl+W
            if (code === 23) {
                lineBuf.deleteWordBackward();
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Ctrl+U
            if (code === 21) {
                lineBuf.deleteToStart();
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Ctrl+K
            if (code === 11) {
                lineBuf.deleteToEnd();
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Ctrl+A
            if (code === 1) {
                lineBuf.moveHome();
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Ctrl+E
            if (code === 5) {
                lineBuf.moveEnd();
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Ctrl+L (clear screen)
            if (code === 12) {
                process.stdout.write('\x1b[2J\x1b[H');
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Tab
            if (ch === '\t') {
                if (popup && popup.count > 0) {
                    const val = popup.selectedValue;
                    if (val) {
                        lineBuf.replaceWord(val);
                        popup = null;
                    }
                } else {
                    // Open popup
                    const word = lineBuf.wordBeforeCursor();
                    const fullLine = multiLineBuffer + lineBuf.text;
                    const suggestions = state.completer.complete(word, fullLine);
                    if (suggestions.length > 0) {
                        popup = new SuggestionBox(suggestions);
                    }
                }
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Escape
            if (code === 27 && i + 1 < data.length && data[i + 1] !== '[') {
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }
            if (code === 27 && i + 1 >= data.length) {
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Enter
            if (ch === '\r' || ch === '\n') {
                // If popup is open, accept selection
                if (popup && popup.count > 0) {
                    const val = popup.selectedValue;
                    if (val) lineBuf.replaceWord(val);
                    popup = null;
                    renderPrompt(lineBuf, isMultiLine, popup);
                    continue;
                }

                const fullInput = multiLineBuffer + lineBuf.text;
                const result = validate(fullInput);

                if (result === 'incomplete') {
                    multiLineBuffer += lineBuf.text + '\n';
                    lineBuf.clear();
                    isMultiLine = true;
                    process.stdout.write('\n');
                    renderPrompt(lineBuf, isMultiLine, popup);
                    continue;
                }

                process.stdout.write('\n');
                const trimmed = fullInput.trim();

                if (trimmed.length > 0) {
                    if (trimmed.startsWith('.')) {
                        handleDotCommand(trimmed, state);
                    } else {
                        executeSQL(trimmed, state);
                    }
                    state.history.add(fullInput);
                    state.history.resetCursor();
                }

                lineBuf.clear();
                multiLineBuffer = '';
                isMultiLine = false;
                popup = null;
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Backspace
            if (code === 127 || code === 8) {
                lineBuf.backspace();
                popup = null;
                // Auto-suggest after backspace if word remains
                updatePopup(lineBuf, multiLineBuffer, state.completer, p => popup = p);
                renderPrompt(lineBuf, isMultiLine, popup);
                continue;
            }

            // Printable character
            if (code >= 32) {
                lineBuf.insert(ch);
                popup = null;
                updatePopup(lineBuf, multiLineBuffer, state.completer, p => popup = p);
                renderPrompt(lineBuf, isMultiLine, popup);
            }
        }
    });
}

function updatePopup(
    lineBuf: LineBuffer,
    multiLineBuffer: string,
    completer: SqlCompleter,
    setPopup: (p: SuggestionBox | null) => void,
): void {
    const word = lineBuf.wordBeforeCursor();
    if (word.length === 0) { setPopup(null); return; }
    const fullLine = multiLineBuffer + lineBuf.text;
    const suggestions = completer.complete(word, fullLine);
    if (suggestions.length > 0) {
        setPopup(new SuggestionBox(suggestions));
    } else {
        setPopup(null);
    }
}

function renderPrompt(lineBuf: LineBuffer, isMultiLine: boolean, popup: SuggestionBox | null): void {
    const promptStr = isMultiLine
        ? `  ${theme.FOOTER}···${theme.R} `
        : `${theme.FN}▸${theme.R} `;

    const highlighted = highlight(lineBuf.text);

    // Clear previous popup lines
    if (previousPopupHeight > 0) {
        process.stdout.write('\x1b[s');
        for (let i = 0; i < previousPopupHeight; i++) {
            process.stdout.write('\n\x1b[K');
        }
        process.stdout.write('\x1b[u');
    }

    // Clear line and render
    process.stdout.write('\r\x1b[K');
    process.stdout.write(promptStr + highlighted);

    // Render popup below cursor
    if (popup && popup.count > 0) {
        const lines = popup.renderLines();
        // Save cursor, draw popup, restore cursor
        const promptWidth = isMultiLine ? 6 : 3;
        const wordStart = lineBuf.cursor - lineBuf.wordBeforeCursor().length;
        const popupCol = promptWidth + wordStart;

        process.stdout.write('\x1b[s'); // save cursor
        for (const line of lines) {
            process.stdout.write(`\n\x1b[${popupCol}G${line}`);
        }
        process.stdout.write('\x1b[u'); // restore cursor
        previousPopupHeight = lines.length;
    } else {
        previousPopupHeight = 0;
    }

    // Position cursor correctly
    const promptWidth = isMultiLine ? 6 : 3;
    const cursorCol = promptWidth + lineBuf.cursor + 1;
    process.stdout.write(`\r\x1b[${cursorCol}G`);
}

function executeSQL(sql: string, state: ReplState): void {
    const rawSql = sql.replace(/;$/, '').trim();
    if (rawSql.length === 0) return;

    const start = performance.now();
    try {
        const result = state.ctx.executeSync(rawSql);
        const elapsed = performance.now() - start;

        if (result) {
            // Update completer with result columns
            const cols = result.columns.map(name => {
                const s = result.col(name);
                return { name, typeName: s.dtype };
            });
            state.completer.setColumns(cols);

            // Format and print
            switch (state.format) {
                case 'table':
                    process.stdout.write(formatTable(result, {
                        maxRows: state.maxRows,
                        maxColWidth: state.maxColWidth,
                    }));
                    break;
                case 'csv':
                    process.stdout.write(formatCsv(result));
                    break;
                case 'json':
                    process.stdout.write(formatJson(result));
                    break;
            }

            if (state.showTimer) {
                process.stdout.write(`${theme.TIMER}Run Time: ${formatElapsed(elapsed)}${theme.R}\n`);
            }
        } else {
            // DDL statement (CREATE, DROP, INSERT, etc.)
            const elapsed2 = performance.now() - start;
            process.stdout.write(`${theme.SUCCESS}OK${theme.R}\n`);
            updateTableInfo(state);
            if (state.showTimer) {
                process.stdout.write(`${theme.TIMER}Run Time: ${formatElapsed(elapsed2)}${theme.R}\n`);
            }
        }
    } catch (e: any) {
        process.stdout.write(`${theme.ERROR}Error: ${e.message}${theme.R}\n`);
    }
}

function updateTableInfo(state: ReplState): void {
    const names = state.session.listTables();
    const tables = names.map(name => {
        const stored = state.session.get(name);
        return {
            name,
            nrows: stored ? stored.table.nRows : 0,
            ncols: stored ? stored.columns.length : 0,
        };
    });
    state.completer.setTables(tables);
}

function handleDotCommand(cmd: string, state: ReplState): void {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
        case '.help':
            printHelp();
            break;
        case '.tables':
            dotTables(state);
            break;
        case '.schema':
            dotSchema(parts[1], state);
            break;
        case '.load':
            dotLoad(parts.slice(1), state);
            break;
        case '.save':
            dotSave(parts[1], parts[2], state);
            break;
        case '.mode':
            dotMode(parts[1], state);
            break;
        case '.timer':
            dotTimer(parts[1], state);
            break;
        case '.limit':
            dotLimit(parts[1], state);
            break;
        case '.width':
            dotWidth(parts[1], state);
            break;
        case '.clear':
            process.stdout.write('\x1b[2J\x1b[H');
            break;
        case '.quit':
        case '.exit':
            state.history.save();
            state.ctx.destroy();
            process.exit(0);
            break;
        default:
            process.stdout.write(`${theme.ERROR}Unknown command: ${command}. Type .help for commands.${theme.R}\n`);
    }
}

function dotTables(state: ReplState): void {
    const names = state.session.listTables().sort();
    if (names.length === 0) {
        process.stdout.write(`${theme.FOOTER}No stored tables.${theme.R}\n`);
        return;
    }
    for (const name of names) {
        const stored = state.session.get(name);
        if (stored) {
            const nrows = stored.table.nRows;
            const ncols = stored.columns.length;
            process.stdout.write(`  ${theme.HEADER}${name.padEnd(20)}${theme.R} ${theme.FOOTER}${nrows} rows, ${ncols} cols${theme.R}\n`);
        }
    }
}

function dotSchema(tableName: string | undefined, state: ReplState): void {
    if (!tableName) {
        process.stdout.write(`${theme.FOOTER}Usage: .schema <table>${theme.R}\n`);
        return;
    }
    const stored = state.session.get(tableName);
    if (!stored) {
        process.stdout.write(`${theme.ERROR}Table '${tableName}' not found${theme.R}\n`);
        return;
    }
    for (const colName of stored.columns) {
        const s = stored.table.col(colName);
        process.stdout.write(`  ${theme.HEADER}${colName.padEnd(20)}${theme.R} ${theme.TYPE_DIM}${s.dtype}${theme.R}\n`);
    }
}

function dotLoad(args: string[], state: ReplState): void {
    if (args.length === 0) {
        process.stdout.write(`${theme.FOOTER}Usage: .load <file.csv> [as <name>]${theme.R}\n`);
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
        const table = state.ctx.readCsvSync(filePath);
        state.ctx.registerTable(tableName, table);
        updateTableInfo(state);
        process.stdout.write(`${theme.SUCCESS}Loaded ${filePath} as '${tableName}' (${table.nRows} rows, ${table.nCols} cols)${theme.R}\n`);
    } catch (e: any) {
        process.stdout.write(`${theme.ERROR}Error loading ${filePath}: ${e.message}${theme.R}\n`);
    }
}

function dotSave(tableName: string | undefined, filePath: string | undefined, state: ReplState): void {
    if (!tableName || !filePath) {
        process.stdout.write(`${theme.FOOTER}Usage: .save <table> <file.csv>${theme.R}\n`);
        return;
    }
    const stored = state.session.get(tableName);
    if (!stored) {
        process.stdout.write(`${theme.ERROR}Table '${tableName}' not found${theme.R}\n`);
        return;
    }
    try {
        state.ctx.writeCsvSync(stored.table, filePath);
        process.stdout.write(`${theme.SUCCESS}Saved '${tableName}' to ${filePath}${theme.R}\n`);
    } catch (e: any) {
        process.stdout.write(`${theme.ERROR}Error saving: ${e.message}${theme.R}\n`);
    }
}

function dotMode(mode: string | undefined, state: ReplState): void {
    if (!mode) {
        process.stdout.write(`${theme.FOOTER}Current mode: ${state.format}. Usage: .mode table|csv|json${theme.R}\n`);
        return;
    }
    if (mode === 'table' || mode === 'csv' || mode === 'json') {
        state.format = mode;
        process.stdout.write(`${theme.SUCCESS}Output mode: ${mode}${theme.R}\n`);
    } else {
        process.stdout.write(`${theme.ERROR}Unknown mode. Use: table, csv, json${theme.R}\n`);
    }
}

function dotTimer(value: string | undefined, state: ReplState): void {
    if (!value) {
        process.stdout.write(`${theme.FOOTER}Timer is ${state.showTimer ? 'on' : 'off'}. Usage: .timer on|off${theme.R}\n`);
        return;
    }
    if (value === 'on') {
        state.showTimer = true;
        process.stdout.write(`${theme.SUCCESS}Timer: on${theme.R}\n`);
    } else if (value === 'off') {
        state.showTimer = false;
        process.stdout.write(`${theme.SUCCESS}Timer: off${theme.R}\n`);
    } else {
        process.stdout.write(`${theme.FOOTER}Usage: .timer on|off${theme.R}\n`);
    }
}

function dotLimit(value: string | undefined, state: ReplState): void {
    if (!value) {
        process.stdout.write(`${theme.FOOTER}Current limit: ${state.maxRows} rows${theme.R}\n`);
        return;
    }
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 1) {
        process.stdout.write(`${theme.ERROR}Invalid number${theme.R}\n`);
        return;
    }
    state.maxRows = n;
    process.stdout.write(`${theme.SUCCESS}Max rows: ${n}${theme.R}\n`);
}

function dotWidth(value: string | undefined, state: ReplState): void {
    if (!value) {
        process.stdout.write(`${theme.FOOTER}Current width: ${state.maxColWidth} chars${theme.R}\n`);
        return;
    }
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 1) {
        process.stdout.write(`${theme.ERROR}Invalid number${theme.R}\n`);
        return;
    }
    state.maxColWidth = n;
    process.stdout.write(`${theme.SUCCESS}Max column width: ${n}${theme.R}\n`);
}

function printBanner(): void {
    const ver = `v${require(path.join(__dirname, '..', '..', 'package.json')).version}`;
    const help = 'type .help for commands';
    const w = Math.max(ver.length, help.length, 9);
    const fill = w - 9; // "Teide SQL" is 9 chars

    process.stdout.write(
        `${theme.BAN_BORDER}\u256d\u2500 ${theme.BOLD}${theme.BAN_TITLE}Teide SQL${theme.R}${theme.BAN_BORDER} ${'\u2500'.repeat(fill)}\u256e${theme.R}\n` +
        `${theme.BAN_BORDER}\u2502${theme.R} ${theme.BAN_INFO}${ver.padEnd(w)}${theme.R} ${theme.BAN_BORDER}\u2502${theme.R}\n` +
        `${theme.BAN_BORDER}\u2502${theme.R} ${theme.BAN_HELP}${help.padEnd(w)}${theme.R} ${theme.BAN_BORDER}\u2502${theme.R}\n` +
        `${theme.BAN_BORDER}\u2570${'\u2500'.repeat(w + 2)}\u256f${theme.R}\n\n`
    );
}

function printHelp(): void {
    process.stdout.write(`${theme.BOLD}${theme.HEADER}Commands:${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.help${theme.R}                 ${theme.FOOTER}Show this help${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.tables${theme.R}               ${theme.FOOTER}List stored tables${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.schema <table>${theme.R}       ${theme.FOOTER}Show column names and types${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.load <file> [as <n>]${theme.R} ${theme.FOOTER}Load CSV file${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.save <table> <file>${theme.R}  ${theme.FOOTER}Export table to CSV${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.mode table|csv|json${theme.R}  ${theme.FOOTER}Set output format${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.timer on|off${theme.R}         ${theme.FOOTER}Show query execution time${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.limit [n]${theme.R}            ${theme.FOOTER}Set max displayed rows${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.width [n]${theme.R}            ${theme.FOOTER}Set max column width${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.clear${theme.R}                ${theme.FOOTER}Clear screen${theme.R}\n`);
    process.stdout.write(`  ${theme.FN}.quit${theme.R}                 ${theme.FOOTER}Exit${theme.R}\n`);
    process.stdout.write('\n');
    process.stdout.write(`${theme.BOLD}${theme.HEADER}SQL:${theme.R}\n`);
    process.stdout.write(`  ${theme.TEXT}SELECT * FROM 'data.csv' WHERE id > 10;${theme.R}\n`);
    process.stdout.write(`  ${theme.TEXT}CREATE TABLE t AS SELECT * FROM 'data.csv';${theme.R}\n`);
    process.stdout.write(`  ${theme.TEXT}.load data.csv as t${theme.R}\n`);
}

function formatElapsed(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}\u00b5s`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(3)}s`;
}
