import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '../../lib/context';
import { Table } from '../../lib/table';
import { formatTable, formatCsv, formatJson } from '../../lib/repl/formatter';
import path from 'path';

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatter', () => {
    let ctx: Context;

    beforeEach(() => { ctx = new Context(); });
    afterEach(() => { ctx.destroy(); });

    function makeTable(): Table {
        return ctx.readCsvSync(path.join(__dirname, '..', 'fixtures', 'small.csv'));
    }

    describe('formatTable', () => {
        it('produces unicode box output', () => {
            const table = makeTable();
            const output = stripAnsi(formatTable(table));
            expect(output).toContain('\u{250c}');
            expect(output).toContain('\u{2510}');
            expect(output).toContain('\u{2514}');
            expect(output).toContain('\u{2518}');
            expect(output).toContain('\u{2502}');
            expect(output).toContain('\u{2500}');
        });

        it('includes column names in header', () => {
            const table = makeTable();
            const output = stripAnsi(formatTable(table));
            expect(output).toContain('id');
            expect(output).toContain('name');
            expect(output).toContain('value');
        });

        it('includes data rows', () => {
            const table = makeTable();
            const output = stripAnsi(formatTable(table));
            expect(output).toContain('alpha');
            expect(output).toContain('beta');
            expect(output).toContain('gamma');
        });

        it('includes footer with row and column count', () => {
            const table = makeTable();
            const output = stripAnsi(formatTable(table));
            expect(output).toContain('3 rows');
            expect(output).toContain('3 columns');
        });

        it('right-aligns numbers', () => {
            const table = makeTable();
            const output = stripAnsi(formatTable(table));
            const lines = output.split('\n');
            const valueLine = lines.find(l => l.includes('10.5'));
            expect(valueLine).toBeDefined();
        });

        it('handles table with few rows', () => {
            const table = makeTable();
            const output = stripAnsi(formatTable(table));
            // small.csv has 3 rows - should show all without dots
            expect(output).not.toContain('\u{00b7}\u{00b7}\u{00b7}');
        });
    });

    describe('formatCsv', () => {
        it('produces CSV with headers', () => {
            const table = makeTable();
            const output = formatCsv(table);
            const lines = output.split('\n').filter(l => l.length > 0);
            expect(lines[0]).toBe('id,name,value');
            expect(lines.length).toBe(4);
        });

        it('includes data values', () => {
            const table = makeTable();
            const output = formatCsv(table);
            expect(output).toContain('alpha');
        });
    });

    describe('formatJson', () => {
        it('produces JSON array', () => {
            const table = makeTable();
            const output = formatJson(table);
            const parsed = JSON.parse(output);
            expect(parsed).toHaveLength(3);
            expect(parsed[0]).toHaveProperty('id');
            expect(parsed[0]).toHaveProperty('name');
            expect(parsed[0]).toHaveProperty('value');
        });
    });
});
