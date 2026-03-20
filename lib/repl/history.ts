import fs from 'fs';

const SEPARATOR = '\x00';

export class History {
    private entries: string[] = [];
    private cursor = 0;
    private maxEntries: number;
    private filePath: string;

    constructor(filePath: string, maxEntries = 1000) {
        this.filePath = filePath;
        this.maxEntries = maxEntries;
        this.load();
    }

    get length(): number { return this.entries.length; }

    getAll(): string[] { return [...this.entries]; }

    add(entry: string): void {
        const trimmed = entry.trim();
        if (trimmed.length === 0) return;
        if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) return;
        this.entries.push(trimmed);
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(this.entries.length - this.maxEntries);
        }
        this.cursor = this.entries.length;
    }

    resetCursor(): void {
        this.cursor = this.entries.length;
    }

    up(): string | null {
        if (this.entries.length === 0) return null;
        if (this.cursor > 0) this.cursor--;
        return this.entries[this.cursor];
    }

    down(): string | null {
        if (this.cursor >= this.entries.length - 1) {
            this.cursor = this.entries.length;
            return null;
        }
        this.cursor++;
        return this.entries[this.cursor];
    }

    save(): void {
        try {
            const encoded = this.entries
                .map(e => e.replace(/\n/g, SEPARATOR))
                .join('\n');
            fs.writeFileSync(this.filePath, encoded + '\n', 'utf8');
        } catch {
            // Silently ignore — history is best-effort
        }
    }

    private load(): void {
        try {
            const content = fs.readFileSync(this.filePath, 'utf8');
            this.entries = content
                .split('\n')
                .filter(line => line.length > 0)
                .map(line => line.replace(new RegExp(SEPARATOR, 'g'), '\n'));
            if (this.entries.length > this.maxEntries) {
                this.entries = this.entries.slice(this.entries.length - this.maxEntries);
            }
        } catch {
            this.entries = [];
        }
        this.cursor = this.entries.length;
    }
}
