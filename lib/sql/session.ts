import { Table } from '../table';
import { GraphCatalog } from './graph-catalog';

export interface StoredTable {
    nativeTable: any;  // NativeTable reference
    columns: string[];
    table: Table;
}

export class Session {
    private tables = new Map<string, StoredTable>();
    readonly graphCatalog = new GraphCatalog();

    register(name: string, table: Table): void {
        const key = name.toLowerCase();
        this.tables.set(key, {
            nativeTable: table._native,
            columns: table.columns,
            table,
        });
    }

    get(name: string): StoredTable | undefined {
        return this.tables.get(name.toLowerCase());
    }

    has(name: string): boolean {
        return this.tables.has(name.toLowerCase());
    }

    drop(name: string): boolean {
        this.graphCatalog.invalidateForTable(name);
        return this.tables.delete(name.toLowerCase());
    }

    listTables(): string[] {
        return Array.from(this.tables.keys());
    }
}
