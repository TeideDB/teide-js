// Graph catalog extracted from pgq.ts to break circular dependency with session.ts.

import { PgqCreateGraph, PgqDropGraph } from './pgq-parser';

// Forward-declare the types that pgq.ts fills in
export interface PropertyGraph {
    name: string;
    vertexTables: any[];
    edgeTables: any[];
    nodeIndex: Map<string, Map<string | number, number>>;
    nodeInfo: Map<number, { label: string; key: string | number; row: any[]; columns: string[] }>;
    csr: CSR;
    undirectedCsr: CSR;
    nodeCount: number;
    edgeInfo: Map<number, { label: string; row: any[]; columns: string[] }>;
}

export interface CSR {
    nodeCount: number;
    offsets: number[];
    targets: number[];
    weights?: number[];
}

// Builder function type - set by pgq.ts at import time
let _buildPropertyGraph: ((def: PgqCreateGraph, session: any) => PropertyGraph) | null = null;

export function setGraphBuilder(fn: (def: PgqCreateGraph, session: any) => PropertyGraph): void {
    _buildPropertyGraph = fn;
}

export class GraphCatalog {
    private graphs = new Map<string, PropertyGraph>();

    createGraph(def: PgqCreateGraph, session: any): void {
        const key = def.name.toLowerCase();
        if (this.graphs.has(key) && !def.orReplace) {
            if (def.ifNotExists) return;
            throw new Error(`Property graph already exists: ${def.name}`);
        }

        if (!_buildPropertyGraph) throw new Error('Graph builder not initialized');
        const graph = _buildPropertyGraph(def, session);
        this.graphs.set(key, graph);
    }

    dropGraph(def: PgqDropGraph): void {
        const key = def.name.toLowerCase();
        if (!this.graphs.has(key)) {
            if (def.ifExists) return;
            throw new Error(`Property graph not found: ${def.name}`);
        }
        this.graphs.delete(key);
    }

    getGraph(name: string): PropertyGraph | undefined {
        return this.graphs.get(name.toLowerCase());
    }

    hasGraph(name: string): boolean {
        return this.graphs.has(name.toLowerCase());
    }

    invalidateForTable(tableName: string): void {
        const lower = tableName.toLowerCase();
        for (const [key, graph] of this.graphs) {
            const deps = [
                ...graph.vertexTables.map((v: any) => (v.table || '').toLowerCase()),
                ...graph.edgeTables.map((e: any) => (e.table || '').toLowerCase()),
            ];
            if (deps.includes(lower)) {
                this.graphs.delete(key);
            }
        }
    }
}
