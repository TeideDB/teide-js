import type { Column } from './protocol';

interface CompletionItem { value: string; description: string; }
interface TableMeta { name: string; nrows: number; ncols: number; }

const SQL_KEYWORDS = [
    'SELECT','FROM','WHERE','GROUP','BY','ORDER','LIMIT','AS','ON',
    'JOIN','LEFT','RIGHT','INNER','OUTER','CROSS','HAVING','DISTINCT',
    'UNION','ALL','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
    'CREATE','TABLE','DROP','ALTER','INDEX','VIEW','CASE','WHEN',
    'THEN','ELSE','END','IN','BETWEEN','LIKE','IS','NULL','EXISTS',
    'ASC','DESC','OFFSET','WITH','RECURSIVE','EXCEPT','INTERSECT',
    'OVER','PARTITION','WINDOW','ROWS','RANGE','UNBOUNDED',
    'PRECEDING','FOLLOWING','CURRENT','ROW',
];

const AGG_FUNCTIONS: [string, string][] = [
    ['SUM', 'SUM(col) → sum'],
    ['AVG', 'AVG(col) → average'],
    ['MIN', 'MIN(col) → minimum'],
    ['MAX', 'MAX(col) → maximum'],
    ['COUNT', 'COUNT(col) → count'],
    ['ROW_NUMBER', 'ROW_NUMBER() OVER(...)'],
    ['RANK', 'RANK() OVER(...)'],
    ['DENSE_RANK', 'DENSE_RANK() OVER(...)'],
    ['LAG', 'LAG(col, offset) OVER(...)'],
    ['LEAD', 'LEAD(col, offset) OVER(...)'],
];

const DOT_COMMANDS: [string, string][] = [
    ['.help', 'Show available commands'],
    ['.tables', 'List stored tables'],
    ['.schema', 'Show table schema'],
    ['.load', 'Load CSV file'],
    ['.save', 'Export table to CSV'],
    ['.clear', 'Clear results'],
    ['.timer', 'Toggle timing: on|off'],
];

function fuzzyMatch(pattern: string, candidate: string): number {
    const pat = pattern.toLowerCase();
    const cand = candidate.toLowerCase();
    let pi = 0, score = 0, prevMatch = false;
    for (let ci = 0; ci < cand.length && pi < pat.length; ci++) {
        if (cand[ci] === pat[pi]) {
            score += prevMatch ? 3 : 1;
            if (ci === 0) score += 5;
            prevMatch = true;
            pi++;
        } else {
            prevMatch = false;
        }
    }
    return pi === pat.length ? score : 0;
}

function detectContext(before: string): 'table' | 'column' | 'dot' | 'general' {
    const upper = before.toUpperCase();
    if (upper.trimStart().startsWith('.')) return 'dot';
    const tableKws = ['FROM ', 'JOIN '];
    const colKws = ['SELECT ', 'WHERE ', 'BY ', 'HAVING ', 'ON ', 'SET ', 'ORDER BY '];
    let lastTable = -1, lastCol = -1;
    for (const kw of tableKws) { const p = upper.lastIndexOf(kw); if (p > lastTable) lastTable = p; }
    for (const kw of colKws) { const p = upper.lastIndexOf(kw); if (p > lastCol) lastCol = p; }
    if (lastTable > lastCol) return 'table';
    if (lastCol >= 0) return 'column';
    return 'general';
}

export function getCompletions(prefix: string, fullContext: string, tables: TableMeta[], columns: Column[]): CompletionItem[] {
    const ctx = detectContext(fullContext);

    if (ctx === 'dot') {
        return DOT_COMMANDS.filter(([cmd]) => fuzzyMatch(prefix, cmd) > 0).map(([cmd, desc]) => ({ value: cmd, description: desc }));
    }
    if (prefix.length === 0) return [];

    const candidates: { score: number; item: CompletionItem }[] = [];

    if (ctx === 'table' || ctx === 'general') {
        for (const t of tables) {
            const s = fuzzyMatch(prefix, t.name);
            if (s > 0) candidates.push({ score: s, item: { value: t.name, description: `table — ${t.nrows} rows` } });
        }
    }
    if (ctx === 'column' || ctx === 'general') {
        for (const col of columns) {
            const s = fuzzyMatch(prefix, col.name);
            if (s > 0) candidates.push({ score: s, item: { value: col.name, description: col.dtype } });
        }
    }
    for (const [name, desc] of AGG_FUNCTIONS) {
        const s = fuzzyMatch(prefix, name);
        if (s > 0) candidates.push({ score: s, item: { value: name, description: desc } });
    }
    for (const kw of SQL_KEYWORDS) {
        const s = fuzzyMatch(prefix, kw);
        if (s > 0) candidates.push({ score: s, item: { value: kw, description: 'keyword' } });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.map(c => c.item);
}
