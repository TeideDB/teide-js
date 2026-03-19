import { Table } from '../table';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Row-oriented data extracted from a native table for TypeScript-level operations
// (JOINs, set ops, window functions) that aren't yet in the C++ layer.
export interface RowData {
    columns: string[];
    rows: any[][];
}

// Extract all row data from a native Table into JS arrays.
// Numeric columns → number[], symbol columns → string[] (via indices+dictionary).
// Respects nullBitmap: null entries are preserved as JS null.
export function extractRows(table: Table): RowData {
    const columns = table.columns;
    const nRows = table.nRows;
    const colArrays: any[][] = [];

    for (const colName of columns) {
        const series = table.col(colName);
        const dtype = series.dtype;
        const nullBitmap = series.nullBitmap;
        const values: any[] = [];

        if (dtype === 'sym') {
            const indices = series.indices;
            const dict = series.dictionary;
            for (let i = 0; i < nRows; i++) {
                if (nullBitmap && (nullBitmap[i >> 3] & (1 << (i & 7)))) {
                    values.push(null);
                } else {
                    const val = dict[indices[i]];
                    values.push(val === undefined ? null : val);
                }
            }
        } else {
            const data = series.data;
            for (let i = 0; i < nRows; i++) {
                if (nullBitmap && (nullBitmap[i >> 3] & (1 << (i & 7)))) {
                    values.push(null);
                } else {
                    values.push(Number(data[i]));
                }
            }
        }
        colArrays.push(values);
    }

    const rows: any[][] = [];
    for (let i = 0; i < nRows; i++) {
        const row: any[] = [];
        for (let c = 0; c < columns.length; c++) {
            row.push(colArrays[c][i]);
        }
        rows.push(row);
    }

    return { columns, rows };
}

// Materialize JS row data back into a native Table via a temp CSV round-trip.
// This is the pragmatic approach until C++ table-from-data bindings exist.
export function materializeTable(data: RowData, ctx: any): Table {
    if (data.rows.length === 0) {
        // Empty result - write header-only CSV
        const tmpPath = tempCsvPath();
        try {
            writeFileSync(tmpPath, data.columns.join(',') + '\n');
            return new Table(ctx.readCsvSync(tmpPath), ctx);
        } finally {
            tryUnlink(tmpPath);
        }
    }

    const tmpPath = tempCsvPath();
    try {
        const header = data.columns.map(c => csvEscape(c)).join(',');
        // NOTE: NULL values are written as empty fields in the CSV. The C CSV reader
        // will parse these as 0 (numeric) or empty symbol (string), losing null info.
        // This is a known limitation pending C++ table-from-data bindings that would
        // allow constructing tables with null bitmaps directly without CSV round-trip.
        const lines = data.rows.map((row) =>
            row.map((v) => {
                if (v === null || v === undefined) {
                    return '';
                }
                if (typeof v === 'string') return csvEscape(v);
                // Force float representation to avoid i64/BigInt on CSV read
                if (typeof v === 'number' && Number.isInteger(v)) return v.toFixed(1);
                return String(v);
            }).join(',')
        );
        writeFileSync(tmpPath, header + '\n' + lines.join('\n') + '\n');
        return new Table(ctx.readCsvSync(tmpPath), ctx);
    } finally {
        tryUnlink(tmpPath);
    }
}

function tempCsvPath(): string {
    return join(tmpdir(), `teide_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.csv`);
}

function csvEscape(s: string): string {
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function tryUnlink(p: string): void {
    try { unlinkSync(p); } catch { /* ignore */ }
}
