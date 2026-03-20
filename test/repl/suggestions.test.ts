import { describe, it, expect } from 'vitest';
import { SuggestionBox } from '../../lib/repl/suggestions';

describe('SuggestionBox', () => {
    const items = [
        { value: 'SELECT', description: 'keyword' },
        { value: 'SET', description: 'keyword' },
        { value: 'SUM', description: 'SUM(col) → sum' },
    ];

    it('starts with first item selected', () => {
        const box = new SuggestionBox(items);
        expect(box.selected).toBe(0);
        expect(box.selectedValue).toBe('SELECT');
    });

    it('moves down', () => {
        const box = new SuggestionBox(items);
        box.moveDown();
        expect(box.selected).toBe(1);
        expect(box.selectedValue).toBe('SET');
    });

    it('moves up', () => {
        const box = new SuggestionBox(items);
        box.moveDown();
        box.moveDown();
        box.moveUp();
        expect(box.selected).toBe(1);
    });

    it('wraps at bottom', () => {
        const box = new SuggestionBox(items);
        box.moveDown();
        box.moveDown();
        box.moveDown();
        expect(box.selected).toBe(0);
    });

    it('wraps at top', () => {
        const box = new SuggestionBox(items);
        box.moveUp();
        expect(box.selected).toBe(2);
    });

    it('renders lines with box drawing', () => {
        const box = new SuggestionBox(items);
        const lines = box.renderLines();
        expect(lines[0]).toContain('\u{250c}');
        expect(lines[lines.length - 1]).toContain('\u{2514}');
        expect(lines.length).toBe(items.length + 2);
    });

    it('handles empty items', () => {
        const box = new SuggestionBox([]);
        expect(box.selectedValue).toBeNull();
        expect(box.renderLines()).toEqual([]);
    });

    it('scrolls when more than maxVisible items', () => {
        const many = Array.from({ length: 20 }, (_, i) => ({
            value: `item${i}`,
            description: `desc${i}`,
        }));
        const box = new SuggestionBox(many, 8);
        const lines = box.renderLines();
        expect(lines.length).toBe(10);
    });
});
