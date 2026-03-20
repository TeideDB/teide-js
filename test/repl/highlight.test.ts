import { describe, it, expect } from 'vitest';
import { highlight, stripAnsi } from '../../lib/repl/highlight';

describe('highlight', () => {
    it('returns plain text for empty input', () => {
        expect(highlight('')).toBe('');
    });

    it('highlights SQL keywords', () => {
        const result = highlight('SELECT * FROM t');
        expect(result).toContain('\x1b[1;34mSELECT\x1b[0m');
        expect(result).toContain('\x1b[1;34mFROM\x1b[0m');
    });

    it('highlights string literals', () => {
        const result = highlight("WHERE name = 'Alice'");
        expect(result).toContain("\x1b[33m'Alice'\x1b[0m");
    });

    it('highlights numbers', () => {
        const result = highlight('WHERE x > 42');
        expect(result).toContain('\x1b[35m42\x1b[0m');
    });

    it('highlights functions', () => {
        const result = highlight('SELECT COUNT(*) FROM t');
        expect(result).toContain('\x1b[1;36mCOUNT\x1b[0m');
    });

    it('highlights dot-commands as a whole line', () => {
        const result = highlight('.tables');
        expect(result).toContain('\x1b[36m.tables\x1b[0m');
    });

    it('is case-insensitive for keywords', () => {
        const result = highlight('select from where');
        expect(result).toContain('\x1b[1;34mselect\x1b[0m');
    });

    it('stripAnsi removes all ANSI codes', () => {
        const result = highlight('SELECT 1;');
        expect(stripAnsi(result)).toBe('SELECT 1;');
    });
});
