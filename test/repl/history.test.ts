import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { History } from '../../lib/repl/history';

describe('history', () => {
    let tmpFile: string;

    beforeEach(() => {
        tmpFile = path.join(os.tmpdir(), `teide_hist_test_${Date.now()}`);
    });

    afterEach(() => {
        try { fs.unlinkSync(tmpFile); } catch {}
    });

    it('starts empty', () => {
        const h = new History(tmpFile);
        expect(h.length).toBe(0);
    });

    it('adds entries', () => {
        const h = new History(tmpFile);
        h.add('SELECT 1;');
        h.add('SELECT 2;');
        expect(h.length).toBe(2);
    });

    it('deduplicates consecutive entries', () => {
        const h = new History(tmpFile);
        h.add('SELECT 1;');
        h.add('SELECT 1;');
        expect(h.length).toBe(1);
    });

    it('navigates up/down', () => {
        const h = new History(tmpFile);
        h.add('first');
        h.add('second');
        h.add('third');
        h.resetCursor();
        expect(h.up()).toBe('third');
        expect(h.up()).toBe('second');
        expect(h.up()).toBe('first');
        expect(h.up()).toBe('first');
        expect(h.down()).toBe('second');
        expect(h.down()).toBe('third');
        expect(h.down()).toBeNull();
    });

    it('persists to file and reloads', () => {
        const h1 = new History(tmpFile);
        h1.add('SELECT 1;');
        h1.add('SELECT 2;');
        h1.save();

        const h2 = new History(tmpFile);
        expect(h2.length).toBe(2);
        h2.resetCursor();
        expect(h2.up()).toBe('SELECT 2;');
    });

    it('handles multi-line entries', () => {
        const h = new History(tmpFile);
        h.add('SELECT *\nFROM t\nWHERE x > 1;');
        h.save();

        const h2 = new History(tmpFile);
        expect(h2.length).toBe(1);
        h2.resetCursor();
        expect(h2.up()).toBe('SELECT *\nFROM t\nWHERE x > 1;');
    });

    it('caps at max entries', () => {
        const h = new History(tmpFile, 5);
        for (let i = 0; i < 10; i++) h.add(`query ${i}`);
        expect(h.length).toBe(5);
        h.resetCursor();
        expect(h.up()).toBe('query 9');
    });
});
