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
        expect(getCompletions('', 'SELECT ', [], [])).toEqual([]);
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
