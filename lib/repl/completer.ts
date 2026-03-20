export enum CompletionContext {
    Table = 'table',
    Column = 'column',
    DotCommand = 'dot',
    General = 'general',
}

export interface Suggestion {
    value: string;
    description: string;
}

export interface ColumnInfo {
    name: string;
    typeName: string;
}

export interface TableInfo {
    name: string;
    nrows: number;
    ncols: number;
}

export interface FuzzyResult {
    score: number;
    indices: number[];
}

const SQL_KEYWORDS = [
    'SELECT','FROM','WHERE','GROUP','BY','ORDER','LIMIT','AS','ON',
    'JOIN','LEFT','RIGHT','INNER','OUTER','CROSS','HAVING','DISTINCT',
    'UNION','ALL','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
    'CREATE','TABLE','DROP','ALTER','INDEX','VIEW','CASE','WHEN',
    'THEN','ELSE','END','IN','BETWEEN','LIKE','IS','NULL','EXISTS',
    'ASC','DESC','OFFSET','FETCH','WITH','RECURSIVE','EXCEPT',
    'INTERSECT','OVER','PARTITION','WINDOW','ROWS','RANGE',
    'UNBOUNDED','PRECEDING','FOLLOWING','CURRENT','ROW',
];

const AGG_FUNCTIONS: [string, string][] = [
    ['SUM', 'SUM(col) → sum of values'],
    ['AVG', 'AVG(col) → average'],
    ['MIN', 'MIN(col) → minimum'],
    ['MAX', 'MAX(col) → maximum'],
    ['COUNT', 'COUNT(col) → row count'],
    ['ROW_NUMBER', 'ROW_NUMBER() OVER(...)'],
    ['RANK', 'RANK() OVER(...)'],
    ['DENSE_RANK', 'DENSE_RANK() OVER(...)'],
    ['NTILE', 'NTILE(n) OVER(...)'],
    ['LAG', 'LAG(col, offset) OVER(...)'],
    ['LEAD', 'LEAD(col, offset) OVER(...)'],
];

const DOT_COMMANDS: [string, string][] = [
    ['.help', 'Show available commands'],
    ['.tables', 'List stored tables'],
    ['.schema', 'Show table schema'],
    ['.load', 'Load CSV file'],
    ['.save', 'Export table to CSV'],
    ['.mode', 'Set output format: table|csv|json'],
    ['.timer', 'Show query time: on|off'],
    ['.limit', 'Set max rows displayed'],
    ['.width', 'Set max column width'],
    ['.clear', 'Clear screen'],
    ['.quit', 'Exit the REPL'],
    ['.exit', 'Exit the REPL'],
];

export function fuzzyMatch(pattern: string, candidate: string): FuzzyResult | null {
    const pat = pattern.toLowerCase();
    const cand = candidate.toLowerCase();
    let pi = 0;
    const indices: number[] = [];
    let score = 0;
    let prevMatch = false;

    for (let ci = 0; ci < cand.length && pi < pat.length; ci++) {
        if (cand[ci] === pat[pi]) {
            indices.push(ci);
            score += prevMatch ? 3 : 1;
            if (ci === 0) score += 5;
            prevMatch = true;
            pi++;
        } else {
            prevMatch = false;
        }
    }

    return pi === pat.length ? { score, indices } : null;
}

export function detectContext(before: string): CompletionContext {
    const upper = before.toUpperCase();

    if (upper.trimStart().startsWith('.')) return CompletionContext.DotCommand;

    const tableKws = ['FROM ', 'JOIN '];
    const colKws = ['SELECT ', 'WHERE ', 'BY ', 'HAVING ', 'ON ', 'SET ', 'ORDER BY '];

    let lastTable = -1;
    let lastCol = -1;

    for (const kw of tableKws) {
        const pos = upper.lastIndexOf(kw);
        if (pos > lastTable) lastTable = pos;
    }
    for (const kw of colKws) {
        const pos = upper.lastIndexOf(kw);
        if (pos > lastCol) lastCol = pos;
    }

    if (lastTable > lastCol) return CompletionContext.Table;
    if (lastCol >= 0) return CompletionContext.Column;
    return CompletionContext.General;
}

export class SqlCompleter {
    private columns: ColumnInfo[] = [];
    private tables: TableInfo[] = [];

    setColumns(columns: ColumnInfo[]): void { this.columns = columns; }
    setTables(tables: TableInfo[]): void { this.tables = tables; }

    complete(prefix: string, fullLine: string): Suggestion[] {
        const context = detectContext(fullLine);

        if (context === CompletionContext.DotCommand) {
            return this.completeDotCommands(prefix);
        }

        if (prefix.length === 0) return [];

        const candidates: { score: number; suggestion: Suggestion }[] = [];

        switch (context) {
            case CompletionContext.Table:
                this.addTables(prefix, candidates);
                break;
            case CompletionContext.Column:
                this.addColumns(prefix, candidates);
                this.addFunctions(prefix, candidates);
                this.addKeywords(prefix, candidates);
                break;
            case CompletionContext.General:
                this.addColumns(prefix, candidates);
                this.addFunctions(prefix, candidates);
                this.addKeywords(prefix, candidates);
                this.addTables(prefix, candidates);
                break;
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates.map(c => c.suggestion);
    }

    private completeDotCommands(prefix: string): Suggestion[] {
        const results: Suggestion[] = [];
        for (const [cmd, desc] of DOT_COMMANDS) {
            if (fuzzyMatch(prefix, cmd)) {
                results.push({ value: cmd, description: desc });
            }
        }
        return results;
    }

    private addTables(prefix: string, out: { score: number; suggestion: Suggestion }[]): void {
        for (const t of this.tables) {
            const m = fuzzyMatch(prefix, t.name);
            if (m) {
                out.push({
                    score: m.score,
                    suggestion: { value: t.name, description: `table — ${t.nrows} rows, ${t.ncols} cols` },
                });
            }
        }
    }

    private addColumns(prefix: string, out: { score: number; suggestion: Suggestion }[]): void {
        for (const col of this.columns) {
            const m = fuzzyMatch(prefix, col.name);
            if (m) {
                out.push({
                    score: m.score,
                    suggestion: { value: col.name, description: col.typeName },
                });
            }
        }
    }

    private addFunctions(prefix: string, out: { score: number; suggestion: Suggestion }[]): void {
        for (const [name, desc] of AGG_FUNCTIONS) {
            const m = fuzzyMatch(prefix, name);
            if (m) {
                out.push({ score: m.score, suggestion: { value: name, description: desc } });
            }
        }
    }

    private addKeywords(prefix: string, out: { score: number; suggestion: Suggestion }[]): void {
        for (const kw of SQL_KEYWORDS) {
            const m = fuzzyMatch(prefix, kw);
            if (m) {
                out.push({ score: m.score, suggestion: { value: kw, description: 'keyword' } });
            }
        }
    }
}
