import { Table } from '../table';
import { getCellValue } from './formatter';
import type { Column } from './protocol';

export interface SerializedTable {
    columns: Column[];
    rows: (string | null)[][];
    nrows: number;
}

export function serializeTable(table: Table): SerializedTable {
    const colNames = table.columns;
    const series = colNames.map(c => table.col(c));

    const columns: Column[] = series.map((s, i) => ({
        name: colNames[i],
        dtype: s.dtype,
    }));

    const rows: (string | null)[][] = [];
    for (let r = 0; r < table.nRows; r++) {
        rows.push(series.map(s => getCellValue(s, r)));
    }

    return { columns, rows, nrows: table.nRows };
}
