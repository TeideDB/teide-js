import { describe, it, expect } from 'vitest';
import { validate } from '../../lib/repl/validator';

describe('validator', () => {
    it('empty input is complete', () => {
        expect(validate('')).toBe('complete');
        expect(validate('   ')).toBe('complete');
    });

    it('dot-commands are always complete', () => {
        expect(validate('.help')).toBe('complete');
        expect(validate('.tables')).toBe('complete');
        expect(validate('.mode csv')).toBe('complete');
    });

    it('SQL without semicolon is incomplete', () => {
        expect(validate('SELECT * FROM t')).toBe('incomplete');
    });

    it('SQL with semicolon is complete', () => {
        expect(validate('SELECT * FROM t;')).toBe('complete');
    });

    it('unbalanced parens are incomplete', () => {
        expect(validate('SELECT COUNT(;')).toBe('incomplete');
        expect(validate('SELECT (1 + (2 * 3);')).toBe('incomplete');
    });

    it('balanced parens with semicolon are complete', () => {
        expect(validate('SELECT COUNT(*) FROM t;')).toBe('complete');
    });

    it('parens inside strings are ignored', () => {
        expect(validate("SELECT '(' FROM t;")).toBe('complete');
        expect(validate('SELECT "(" FROM t;')).toBe('complete');
    });

    it('multi-line SQL without semicolon is incomplete', () => {
        expect(validate('SELECT *\nFROM t\nWHERE x > 1')).toBe('incomplete');
    });

    it('multi-line SQL with semicolon is complete', () => {
        expect(validate('SELECT *\nFROM t\nWHERE x > 1;')).toBe('complete');
    });
});
