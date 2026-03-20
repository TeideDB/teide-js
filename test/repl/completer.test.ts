import { describe, it, expect } from 'vitest';
import {
    fuzzyMatch,
    detectContext,
    SqlCompleter,
    CompletionContext,
} from '../../lib/repl/completer';

describe('fuzzyMatch', () => {
    it('matches exact prefix', () => {
        const result = fuzzyMatch('SEL', 'SELECT');
        expect(result).not.toBeNull();
        expect(result!.score).toBeGreaterThan(0);
    });

    it('matches subsequence', () => {
        const result = fuzzyMatch('SLT', 'SELECT');
        expect(result).not.toBeNull();
    });

    it('returns null for no match', () => {
        expect(fuzzyMatch('XYZ', 'SELECT')).toBeNull();
    });

    it('prefix bonus gives higher score', () => {
        const prefixMatch = fuzzyMatch('S', 'SELECT')!;
        const midMatch = fuzzyMatch('L', 'SELECT')!;
        expect(prefixMatch.score).toBeGreaterThan(midMatch.score);
    });

    it('is case-insensitive', () => {
        expect(fuzzyMatch('sel', 'SELECT')).not.toBeNull();
        expect(fuzzyMatch('SEL', 'select')).not.toBeNull();
    });
});

describe('detectContext', () => {
    it('detects table context after FROM', () => {
        expect(detectContext('SELECT * FROM ')).toBe(CompletionContext.Table);
    });

    it('detects table context after JOIN', () => {
        expect(detectContext('SELECT * FROM t JOIN ')).toBe(CompletionContext.Table);
    });

    it('detects column context after SELECT', () => {
        expect(detectContext('SELECT ')).toBe(CompletionContext.Column);
    });

    it('detects column context after WHERE', () => {
        expect(detectContext('SELECT * FROM t WHERE ')).toBe(CompletionContext.Column);
    });

    it('detects dot-command context', () => {
        expect(detectContext('.ta')).toBe(CompletionContext.DotCommand);
    });

    it('detects general context for unknown position', () => {
        expect(detectContext('CREATE ')).toBe(CompletionContext.General);
    });
});

describe('SqlCompleter', () => {
    it('completes SQL keywords', () => {
        const c = new SqlCompleter();
        const results = c.complete('SEL', 'SEL');
        expect(results.some(r => r.value === 'SELECT')).toBe(true);
    });

    it('completes dot-commands', () => {
        const c = new SqlCompleter();
        const results = c.complete('.ta', '.ta');
        expect(results.some(r => r.value === '.tables')).toBe(true);
    });

    it('completes table names after FROM', () => {
        const c = new SqlCompleter();
        c.setTables([{ name: 'users', nrows: 100, ncols: 5 }]);
        const results = c.complete('us', 'SELECT * FROM us');
        expect(results.some(r => r.value === 'users')).toBe(true);
    });

    it('completes column names after SELECT', () => {
        const c = new SqlCompleter();
        c.setColumns([{ name: 'age', typeName: 'i64' }]);
        const results = c.complete('ag', 'SELECT ag');
        expect(results.some(r => r.value === 'age')).toBe(true);
    });

    it('returns empty for empty prefix', () => {
        const c = new SqlCompleter();
        const results = c.complete('', 'SELECT ');
        expect(results).toEqual([]);
    });
});
