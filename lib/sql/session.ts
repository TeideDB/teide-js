import { Table } from '../table';
import { GraphCatalog } from './graph-catalog';
import { VectorIndexRegistry } from './vector';

export interface StoredTable {
    nativeTable: any;  // NativeTable reference
    columns: string[];
    table: Table;
}

export class Session {
    private tables = new Map<string, StoredTable>();
    readonly graphCatalog = new GraphCatalog();
    readonly vectorIndexes = new VectorIndexRegistry();
    /** Per-session counter for unique temp table names (avoids cross-session collisions). */
    tempTableCounter = 0;

    register(name: string, table: Table): void {
        const key = name.toLowerCase();
        const existed = this.tables.has(key);
        this.tables.set(key, {
            nativeTable: table._native,
            columns: table.columns,
            table,
        });
        // Invalidate graph/vector indexes when overwriting an existing table
        if (existed) {
            this.graphCatalog.invalidateForTable(key);
            this.vectorIndexes.invalidateForTable(key);
        }
    }

    get(name: string): StoredTable | undefined {
        return this.tables.get(name.toLowerCase());
    }

    has(name: string): boolean {
        return this.tables.has(name.toLowerCase());
    }

    drop(name: string): boolean {
        this.graphCatalog.invalidateForTable(name);
        this.vectorIndexes.invalidateForTable(name);
        return this.tables.delete(name.toLowerCase());
    }

    // Called when a table is mutated (INSERT/UPDATE/DELETE)
    onTableMutated(name: string): void {
        this.graphCatalog.invalidateForTable(name);
        this.vectorIndexes.invalidateForTable(name);
    }

    listTables(): string[] {
        return Array.from(this.tables.keys());
    }
}
