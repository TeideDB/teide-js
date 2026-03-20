import * as theme from './theme';
import type { Suggestion } from './completer';

export class SuggestionBox {
    private items: Suggestion[];
    private maxVisible: number;
    private _selected = 0;
    private scrollOffset = 0;

    constructor(items: Suggestion[], maxVisible = 8) {
        this.items = items;
        this.maxVisible = maxVisible;
    }

    get selected(): number { return this._selected; }

    get selectedValue(): string | null {
        return this.items.length > 0 ? this.items[this._selected].value : null;
    }

    get count(): number { return this.items.length; }

    moveDown(): void {
        if (this.items.length === 0) return;
        this._selected = (this._selected + 1) % this.items.length;
        this.adjustScroll();
    }

    moveUp(): void {
        if (this.items.length === 0) return;
        this._selected = (this._selected - 1 + this.items.length) % this.items.length;
        this.adjustScroll();
    }

    renderLines(): string[] {
        if (this.items.length === 0) return [];

        const visible = this.items.slice(this.scrollOffset, this.scrollOffset + this.maxVisible);
        const maxNameW = Math.max(...visible.map(i => i.value.length));
        const maxDescW = Math.max(...visible.map(i => i.description.length));
        const innerW = maxNameW + 2 + maxDescW;

        const lines: string[] = [];
        lines.push(`${theme.BORDER}\u{250c}${'\u{2500}'.repeat(innerW + 2)}\u{2510}${theme.R}`);

        for (let i = 0; i < visible.length; i++) {
            const item = visible[i];
            const globalIdx = this.scrollOffset + i;
            const isSelected = globalIdx === this._selected;

            const name = item.value.padEnd(maxNameW);
            const desc = item.description.padStart(maxDescW);
            const content = `${name}  ${desc}`;

            if (isSelected) {
                lines.push(`${theme.BORDER}\u{2502}${theme.R} ${theme.REVERSE}${content}${theme.R} ${theme.BORDER}\u{2502}${theme.R}`);
            } else {
                lines.push(`${theme.BORDER}\u{2502}${theme.R} ${content} ${theme.BORDER}\u{2502}${theme.R}`);
            }
        }

        lines.push(`${theme.BORDER}\u{2514}${'\u{2500}'.repeat(innerW + 2)}\u{2518}${theme.R}`);
        return lines;
    }

    private adjustScroll(): void {
        if (this._selected < this.scrollOffset) {
            this.scrollOffset = this._selected;
        } else if (this._selected >= this.scrollOffset + this.maxVisible) {
            this.scrollOffset = this._selected - this.maxVisible + 1;
        }
    }
}
