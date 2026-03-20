import { Table } from '../table';
import { Series } from '../series';
import * as theme from './theme';

export { stripAnsi } from './highlight';

interface FormatOpts {
    maxRows?: number;
    maxColWidth?: number;
}

const HEAD_ROWS = 20;
const TAIL_ROWS = 20;

function getCellValue(series: Series, row: number): string | null {
    const bitmap = series.nullBitmap;
    if (bitmap) {
        const byteIdx = row >> 3;
        const bitIdx = row & 7;
        if (byteIdx < bitmap.length && !(bitmap[byteIdx] & (1 << bitIdx))) {
            return null;
        }
    }

    const dtype = series.dtype;

    if (dtype === 'sym') {
        const indices = series.indices;
        const dict = series.dictionary;
        if (row < indices.length) {
            const idx = indices[row];
            return idx < dict.length ? dict[idx] : null;
        }
        return null;
    }

    const data = series.data;
    if (row >= data.length) return null;

    const val = data[row];

    switch (dtype) {
        case 'bool':
            return Number(val) !== 0 ? 'true' : 'false';
        case 'i16':
        case 'i32':
        case 'i64':
            return String(val);
        case 'f64': {
            const n = Number(val);
            let s = n.toFixed(6);
            s = s.replace(/0+$/, '');
            if (s.endsWith('.')) s += '0';
            return s;
        }
        case 'u8':
        case 'char':
            return String(val);
        default:
            return String(val);
    }
}

function isNumericType(dtype: string): boolean {
    return ['i16', 'i32', 'i64', 'f64', 'u8', 'bool'].includes(dtype);
}

export function formatTable(table: Table, opts?: FormatOpts): string {
    const maxRows = opts?.maxRows ?? (HEAD_ROWS + TAIL_ROWS);
    const maxColWidth = opts?.maxColWidth ?? 40;
    const nrows = table.nRows;
    const cols = table.columns;
    const ncols = cols.length;

    if (ncols === 0) {
        return `${theme.FOOTER}(empty result)${theme.R}\n`;
    }

    const series: Series[] = cols.map(c => table.col(c));
    const dtypes = series.map(s => s.dtype);
    const rightAlign = dtypes.map(d => isNumericType(d));

    const showDots = nrows > maxRows;
    const headN = showDots ? HEAD_ROWS : nrows;
    const tailN = showDots ? TAIL_ROWS : 0;

    const cells: (string | null)[][] = [];
    for (let r = 0; r < headN; r++) {
        cells.push(series.map(s => getCellValue(s, r)));
    }
    if (showDots) {
        cells.push(cols.map(() => '\u{00b7}\u{00b7}\u{00b7}'));
        for (let r = nrows - tailN; r < nrows; r++) {
            cells.push(series.map(s => getCellValue(s, r)));
        }
    }

    const widths = cols.map((name, c) => {
        let w = Math.max(name.length, dtypes[c].length);
        for (const row of cells) {
            const val = row[c] ?? 'NULL';
            w = Math.max(w, val.length);
        }
        return Math.min(w, maxColWidth);
    });

    const footerLeft = showDots
        ? `${nrows} rows (${headN + tailN} shown)`
        : `${nrows} rows`;
    const footerRight = `${ncols} columns`;
    const footerMin = footerLeft.length + footerRight.length + 3;
    let innerWidth = widths.reduce((sum, w) => sum + w + 2, 0) + ncols - 1;
    if (innerWidth < footerMin) {
        widths[ncols - 1] += footerMin - innerWidth;
        innerWidth = footerMin;
    }

    const out: string[] = [];

    // Top border
    out.push(theme.BORDER + '\u{250c}' + widths.map(w => '\u{2500}'.repeat(w + 2)).join('\u{252c}') + '\u{2510}' + theme.R);

    // Header row
    let headerLine = '';
    for (let c = 0; c < ncols; c++) {
        headerLine += `${theme.BORDER}\u{2502}${theme.R} ${theme.BOLD}${theme.HEADER}${center(cols[c], widths[c])}${theme.R} `;
    }
    headerLine += `${theme.BORDER}\u{2502}${theme.R}`;
    out.push(headerLine);

    // Type row
    let typeLine = '';
    for (let c = 0; c < ncols; c++) {
        typeLine += `${theme.BORDER}\u{2502}${theme.R} ${theme.TYPE_DIM}${center(dtypes[c], widths[c])}${theme.R} `;
    }
    typeLine += `${theme.BORDER}\u{2502}${theme.R}`;
    out.push(typeLine);

    // Header separator
    out.push(theme.BORDER + '\u{251c}' + widths.map(w => '\u{2500}'.repeat(w + 2)).join('\u{253c}') + '\u{2524}' + theme.R);

    // Data rows
    const dotsIdx = showDots ? headN : -1;
    for (let ri = 0; ri < cells.length; ri++) {
        const row = cells[ri];
        let line = '';
        const isDots = ri === dotsIdx;
        for (let c = 0; c < ncols; c++) {
            const raw = row[c];
            const isNull = raw === null;
            const val = raw ?? 'NULL';
            const truncated = val.length > widths[c] ? val.slice(0, widths[c] - 1) + '\u{2026}' : val;

            line += `${theme.BORDER}\u{2502}${theme.R} `;
            if (isDots) {
                line += `${theme.FOOTER}${center(truncated, widths[c])}${theme.R}`;
            } else if (isNull) {
                line += `${theme.ITALIC}${theme.NULL_CLR}${padRight(truncated, widths[c])}${theme.R}`;
            } else if (rightAlign[c]) {
                line += `${theme.TEXT}${padLeft(truncated, widths[c])}${theme.R}`;
            } else {
                line += `${theme.TEXT}${padRight(truncated, widths[c])}${theme.R}`;
            }
            line += ' ';
        }
        line += `${theme.BORDER}\u{2502}${theme.R}`;
        out.push(line);
    }

    // Footer separator
    out.push(theme.BORDER + '\u{251c}' + widths.map(w => '\u{2500}'.repeat(w + 2)).join('\u{2534}') + '\u{2524}' + theme.R);

    // Footer row
    const pad = innerWidth - footerLeft.length - footerRight.length - 2;
    out.push(`${theme.BORDER}\u{2502}${theme.R} ${theme.FOOTER}${footerLeft}${' '.repeat(pad)}${footerRight}${theme.R} ${theme.BORDER}\u{2502}${theme.R}`);

    // Bottom border
    out.push(theme.BORDER + '\u{2514}' + '\u{2500}'.repeat(innerWidth) + '\u{2518}' + theme.R);

    return out.join('\n') + '\n';
}

export function formatCsv(table: Table): string {
    const cols = table.columns;
    const series = cols.map(c => table.col(c));
    const lines: string[] = [cols.join(',')];

    for (let r = 0; r < table.nRows; r++) {
        const row = series.map(s => {
            const val = getCellValue(s, r);
            if (val === null) return '';
            return csvQuote(val);
        });
        lines.push(row.join(','));
    }

    return lines.join('\n') + '\n';
}

export function formatJson(table: Table): string {
    const cols = table.columns;
    const series = cols.map(c => table.col(c));
    const dtypes = series.map(s => s.dtype);
    const rows: Record<string, any>[] = [];

    for (let r = 0; r < table.nRows; r++) {
        const obj: Record<string, any> = {};
        for (let c = 0; c < cols.length; c++) {
            const val = getCellValue(series[c], r);
            if (val === null) {
                obj[cols[c]] = null;
            } else if (isNumericType(dtypes[c]) && dtypes[c] !== 'bool') {
                obj[cols[c]] = dtypes[c] === 'i64' ? Number(val) : parseFloat(val);
            } else if (dtypes[c] === 'bool') {
                obj[cols[c]] = val === 'true';
            } else {
                obj[cols[c]] = val;
            }
        }
        rows.push(obj);
    }

    return JSON.stringify(rows, null, 2) + '\n';
}

function center(s: string, w: number): string {
    if (s.length >= w) return s.slice(0, w);
    const left = Math.floor((w - s.length) / 2);
    const right = w - s.length - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
}

function padLeft(s: string, w: number): string {
    return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s;
}

function padRight(s: string, w: number): string {
    return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function csvQuote(val: string): string {
    if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
        return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
}
