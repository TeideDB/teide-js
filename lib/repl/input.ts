export class LineBuffer {
    private _text = '';
    private _cursor = 0;

    get text(): string { return this._text; }
    get cursor(): number { return this._cursor; }

    insert(ch: string): void {
        this._text = this._text.slice(0, this._cursor) + ch + this._text.slice(this._cursor);
        this._cursor += ch.length;
    }

    backspace(): void {
        if (this._cursor > 0) {
            this._text = this._text.slice(0, this._cursor - 1) + this._text.slice(this._cursor);
            this._cursor--;
        }
    }

    delete(): void {
        if (this._cursor < this._text.length) {
            this._text = this._text.slice(0, this._cursor) + this._text.slice(this._cursor + 1);
        }
    }

    moveLeft(): void { if (this._cursor > 0) this._cursor--; }
    moveRight(): void { if (this._cursor < this._text.length) this._cursor++; }
    moveHome(): void { this._cursor = 0; }
    moveEnd(): void { this._cursor = this._text.length; }

    deleteWordBackward(): void {
        if (this._cursor === 0) return;
        let i = this._cursor - 1;
        while (i > 0 && this._text[i] === ' ') i--;
        while (i > 0 && this._text[i - 1] !== ' ') i--;
        this._text = this._text.slice(0, i) + this._text.slice(this._cursor);
        this._cursor = i;
    }

    deleteToStart(): void {
        this._text = this._text.slice(this._cursor);
        this._cursor = 0;
    }

    deleteToEnd(): void {
        this._text = this._text.slice(0, this._cursor);
    }

    replaceWord(replacement: string): void {
        const wordStart = this.wordStart();
        this._text = this._text.slice(0, wordStart) + replacement + this._text.slice(this._cursor);
        this._cursor = wordStart + replacement.length;
    }

    setText(text: string): void {
        this._text = text;
        this._cursor = text.length;
    }

    clear(): void {
        this._text = '';
        this._cursor = 0;
    }

    wordBeforeCursor(): string {
        const start = this.wordStart();
        return this._text.slice(start, this._cursor);
    }

    private wordStart(): number {
        let i = this._cursor;
        while (i > 0 && this._text[i - 1] !== ' ' && this._text[i - 1] !== ',' && this._text[i - 1] !== '(') {
            i--;
        }
        return i;
    }
}
