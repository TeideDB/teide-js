import { describe, it, expect } from 'vitest';
import { LineBuffer } from '../../lib/repl/input';

describe('LineBuffer', () => {
    it('starts empty', () => {
        const buf = new LineBuffer();
        expect(buf.text).toBe('');
        expect(buf.cursor).toBe(0);
    });

    it('inserts characters', () => {
        const buf = new LineBuffer();
        buf.insert('a');
        buf.insert('b');
        buf.insert('c');
        expect(buf.text).toBe('abc');
        expect(buf.cursor).toBe(3);
    });

    it('inserts at cursor position', () => {
        const buf = new LineBuffer();
        buf.insert('a');
        buf.insert('c');
        buf.moveLeft();
        buf.insert('b');
        expect(buf.text).toBe('abc');
        expect(buf.cursor).toBe(2);
    });

    it('handles backspace', () => {
        const buf = new LineBuffer();
        buf.insert('a');
        buf.insert('b');
        buf.backspace();
        expect(buf.text).toBe('a');
        expect(buf.cursor).toBe(1);
    });

    it('handles delete', () => {
        const buf = new LineBuffer();
        buf.insert('a');
        buf.insert('b');
        buf.moveLeft();
        buf.delete();
        expect(buf.text).toBe('a');
    });

    it('moves left/right with bounds', () => {
        const buf = new LineBuffer();
        buf.insert('abc');
        buf.moveLeft();
        expect(buf.cursor).toBe(2);
        buf.moveLeft();
        buf.moveLeft();
        buf.moveLeft();
        expect(buf.cursor).toBe(0);
        buf.moveRight();
        expect(buf.cursor).toBe(1);
        buf.moveRight();
        buf.moveRight();
        buf.moveRight();
        expect(buf.cursor).toBe(3);
    });

    it('handles home/end', () => {
        const buf = new LineBuffer();
        buf.insert('hello');
        buf.moveHome();
        expect(buf.cursor).toBe(0);
        buf.moveEnd();
        expect(buf.cursor).toBe(5);
    });

    it('deletes word backward (Ctrl+W)', () => {
        const buf = new LineBuffer();
        buf.insert('SELECT * FROM users');
        buf.deleteWordBackward();
        expect(buf.text).toBe('SELECT * FROM ');
    });

    it('deletes to start (Ctrl+U)', () => {
        const buf = new LineBuffer();
        buf.insert('hello world');
        buf.moveLeft(); buf.moveLeft(); buf.moveLeft(); buf.moveLeft(); buf.moveLeft();
        buf.deleteToStart();
        expect(buf.text).toBe('world');
        expect(buf.cursor).toBe(0);
    });

    it('deletes to end (Ctrl+K)', () => {
        const buf = new LineBuffer();
        buf.insert('hello world');
        buf.moveHome();
        buf.moveRight(); buf.moveRight(); buf.moveRight(); buf.moveRight(); buf.moveRight();
        buf.deleteToEnd();
        expect(buf.text).toBe('hello');
    });

    it('replaces from position (for suggestion accept)', () => {
        const buf = new LineBuffer();
        buf.insert('SELECT SEL');
        buf.replaceWord('SELECT');
        expect(buf.text).toBe('SELECT SELECT');
    });

    it('sets full text', () => {
        const buf = new LineBuffer();
        buf.setText('hello world');
        expect(buf.text).toBe('hello world');
        expect(buf.cursor).toBe(11);
    });

    it('clears', () => {
        const buf = new LineBuffer();
        buf.insert('something');
        buf.clear();
        expect(buf.text).toBe('');
        expect(buf.cursor).toBe(0);
    });

    it('gets word before cursor', () => {
        const buf = new LineBuffer();
        buf.insert('SELECT na');
        expect(buf.wordBeforeCursor()).toBe('na');
    });

    it('gets word before cursor at word boundary', () => {
        const buf = new LineBuffer();
        buf.insert('SELECT ');
        expect(buf.wordBeforeCursor()).toBe('');
    });
});
