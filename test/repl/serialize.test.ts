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
        expect(result.columns.length).toBeGreaterThan(0);
        expect(result.columns[0]).toHaveProperty('name');
        expect(result.columns[0]).toHaveProperty('dtype');
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
});
