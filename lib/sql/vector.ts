// Vector similarity operations, HNSW index, and KNN fast-path detection.
// Vectors are stored as JSON string arrays in symbol columns (e.g., "[1.0, 2.0, 3.0]").

import { Table } from '../table';
import { extractRows, materializeTable, RowData } from './js-table';

// ─── Similarity functions ───────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

export function euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

// Parse a vector from its storage representation (JSON array string or actual array)
export function parseVector(value: any): number[] {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) {
            return JSON.parse(trimmed);
        }
        // Comma-separated values without brackets
        return trimmed.split(',').map(s => parseFloat(s.trim()));
    }
    throw new Error(`Cannot parse vector from: ${value}`);
}

// ─── HNSW Index ─────────────────────────────────────────────────────────────

// Simplified HNSW (Hierarchical Navigable Small World) index for approximate
// nearest neighbor search. Uses a single-layer navigable small world graph.

interface HnswNode {
    id: number;
    vector: number[];
    neighbors: number[]; // indices into the nodes array
    level: number;
}

export interface VectorIndex {
    name: string;
    tableName: string;
    columnName: string;
    metric: 'cosine' | 'euclidean';
    m: number;              // max connections per node
    efConstruction: number; // search width during construction
    nodes: HnswNode[];
    maxLevel: number;
    entryPoint: number;     // index of entry node
    valid: boolean;         // invalidated on table mutation
}

export function createHnswIndex(
    name: string,
    tableName: string,
    columnName: string,
    vectors: number[][],
    metric: 'cosine' | 'euclidean' = 'cosine',
    m: number = 16,
    efConstruction: number = 200,
): VectorIndex {
    if (vectors.length === 0) {
        return { name, tableName, columnName, metric, m, efConstruction, nodes: [], maxLevel: 0, entryPoint: -1, valid: true };
    }

    const nodes: HnswNode[] = [];
    let maxLevel = 0;
    let entryPoint = 0;
    const mL = 1 / Math.log(m);

    // Assign random levels
    function randomLevel(): number {
        return Math.floor(-Math.log(Math.random()) * mL);
    }

    function distance(a: number[], b: number[]): number {
        if (metric === 'cosine') {
            // For cosine, use 1 - similarity as distance
            return 1 - cosineSimilarity(a, b);
        }
        return euclideanDistance(a, b);
    }

    // Insert first node
    nodes.push({ id: 0, vector: vectors[0], neighbors: [], level: randomLevel() });
    maxLevel = nodes[0].level;

    // Insert remaining nodes
    for (let i = 1; i < vectors.length; i++) {
        const level = randomLevel();
        const node: HnswNode = { id: i, vector: vectors[i], neighbors: [], level };
        nodes.push(node);

        // Find nearest neighbors using greedy search from entry point
        const candidates = searchLayer(nodes, entryPoint, vectors[i], efConstruction, distance);

        // Connect to M nearest neighbors
        const nearest = candidates.slice(0, m);
        for (const { idx } of nearest) {
            if (idx !== i) {
                node.neighbors.push(idx);
                nodes[idx].neighbors.push(i);
                // Prune if over capacity
                if (nodes[idx].neighbors.length > m * 2) {
                    pruneNeighbors(nodes, idx, m, distance);
                }
            }
        }

        if (level > maxLevel) {
            maxLevel = level;
            entryPoint = i;
        }
    }

    return { name, tableName, columnName, metric, m, efConstruction, nodes, maxLevel, entryPoint, valid: true };
}

function searchLayer(
    nodes: HnswNode[],
    entryIdx: number,
    query: number[],
    ef: number,
    distFn: (a: number[], b: number[]) => number,
): { idx: number; dist: number }[] {
    const visited = new Set<number>();
    const candidates: { idx: number; dist: number }[] = [];
    const entryDist = distFn(nodes[entryIdx].vector, query);

    candidates.push({ idx: entryIdx, dist: entryDist });
    visited.add(entryIdx);

    let changed = true;
    while (changed) {
        changed = false;
        // Sort candidates by distance
        candidates.sort((a, b) => a.dist - b.dist);

        // Explore neighbors of best candidates
        const toExplore = candidates.slice(0, ef);
        for (const { idx } of toExplore) {
            for (const neighborIdx of nodes[idx].neighbors) {
                if (visited.has(neighborIdx)) continue;
                visited.add(neighborIdx);

                const dist = distFn(nodes[neighborIdx].vector, query);
                if (candidates.length < ef || dist < candidates[candidates.length - 1].dist) {
                    candidates.push({ idx: neighborIdx, dist });
                    changed = true;
                }
            }
        }

        // Keep only top ef candidates
        candidates.sort((a, b) => a.dist - b.dist);
        if (candidates.length > ef) {
            candidates.length = ef;
        }
    }

    return candidates;
}

function pruneNeighbors(
    nodes: HnswNode[],
    nodeIdx: number,
    m: number,
    distFn: (a: number[], b: number[]) => number,
): void {
    const node = nodes[nodeIdx];
    const scored = node.neighbors.map(nIdx => ({
        idx: nIdx,
        dist: distFn(node.vector, nodes[nIdx].vector),
    }));
    scored.sort((a, b) => a.dist - b.dist);
    node.neighbors = scored.slice(0, m).map(s => s.idx);
}

// Search the HNSW index for k nearest neighbors
export function hnswSearch(
    index: VectorIndex,
    query: number[],
    k: number,
    ef: number = 50,
): { rowIndex: number; distance: number }[] {
    if (!index.valid) throw new Error(`Vector index '${index.name}' has been invalidated`);
    if (index.nodes.length === 0) return [];

    const distFn = index.metric === 'cosine'
        ? (a: number[], b: number[]) => 1 - cosineSimilarity(a, b)
        : euclideanDistance;

    const searchEf = Math.max(ef, k);
    const results = searchLayer(index.nodes, index.entryPoint, query, searchEf, distFn);

    return results.slice(0, k).map(r => ({
        rowIndex: r.idx,
        distance: r.dist,
    }));
}

// ─── KNN fast-path detection ────────────────────────────────────────────────

export interface KnnQuery {
    tableName: string;
    columnName: string;
    queryVector: number[];
    k: number;
    metric: 'cosine' | 'euclidean';
    selectColumns: any; // original SELECT columns AST
}

// Detect KNN pattern: SELECT ... FROM t ORDER BY COSINE_SIMILARITY(col, ARRAY[...]) DESC LIMIT k
// or: SELECT ... FROM t ORDER BY EUCLIDEAN_DISTANCE(col, ARRAY[...]) ASC LIMIT k
export function detectKnnQuery(ast: any): KnnQuery | null {
    if (!ast.orderby || ast.orderby.length !== 1) return null;
    if (!ast.limit) return null;
    if (!ast.from || ast.from.length !== 1) return null;

    const orderExpr = ast.orderby[0].expr;
    const orderDir = ast.orderby[0].type;

    // Check if ORDER BY expression is a similarity/distance function call
    const funcInfo = extractVectorFuncCall(orderExpr);
    if (!funcInfo) return null;

    // Cosine similarity should be DESC (higher = more similar)
    // Euclidean distance should be ASC (lower = closer)
    if (funcInfo.metric === 'cosine' && orderDir !== 'DESC') return null;
    if (funcInfo.metric === 'euclidean' && orderDir !== 'ASC') return null;

    // Extract LIMIT k
    const limitVal = ast.limit.value;
    if (!limitVal || limitVal.length !== 1) return null;
    const k = limitVal[0].value;
    if (typeof k !== 'number' || k <= 0) return null;

    const tableName = ast.from[0].table || ast.from[0].as;

    return {
        tableName,
        columnName: funcInfo.columnName,
        queryVector: funcInfo.queryVector,
        k,
        metric: funcInfo.metric,
        selectColumns: ast.columns,
    };
}

function extractVectorFuncCall(node: any): { columnName: string; queryVector: number[]; metric: 'cosine' | 'euclidean' } | null {
    if (!node || node.type !== 'function') return null;

    const funcName = extractFuncName(node).toUpperCase();
    let metric: 'cosine' | 'euclidean';
    if (funcName === 'COSINE_SIMILARITY') {
        metric = 'cosine';
    } else if (funcName === 'EUCLIDEAN_DISTANCE') {
        metric = 'euclidean';
    } else {
        return null;
    }

    const args = node.args?.value;
    if (!args || args.length !== 2) return null;

    // First arg: column reference
    const colArg = args[0];
    if (colArg.type !== 'column_ref') return null;
    const columnName = typeof colArg.column === 'string' ? colArg.column : colArg.column?.expr?.value;

    // Second arg: ARRAY literal or expr_list
    const vecArg = args[1];
    const queryVector = extractArrayLiteral(vecArg);
    if (!queryVector) return null;

    return { columnName, queryVector, metric };
}

function extractFuncName(node: any): string {
    const nameParts = node.name?.name;
    if (Array.isArray(nameParts)) {
        return nameParts.map((p: any) => p.value).join('.');
    }
    return String(node.name);
}

function extractArrayLiteral(node: any): number[] | null {
    // node-sql-parser may parse ARRAY[1,2,3] as various forms
    // Handle expr_list: {type: 'expr_list', value: [{type:'number', value:1}, ...]}
    if (node?.type === 'expr_list') {
        return node.value.map((v: any) => {
            if (v.type === 'number') return v.value;
            if (v.type === 'unary_expr' && v.operator === '-' && v.expr?.type === 'number') {
                return -v.expr.value;
            }
            throw new Error(`Non-numeric value in vector literal: ${JSON.stringify(v)}`);
        });
    }

    // Handle array constructor: {type: 'array', value: [...]}
    if (node?.type === 'array') {
        return extractArrayLiteral(node.value);
    }

    return null;
}

// ─── Vector column computation (for SELECT with vector functions) ───────────

export function computeVectorSimilarity(
    rows: any[][],
    columns: string[],
    columnName: string,
    queryVector: number[],
    metric: 'cosine' | 'euclidean',
): number[] {
    const colIdx = columns.indexOf(columnName);
    if (colIdx === -1) throw new Error(`Column not found: ${columnName}`);

    return rows.map(row => {
        const vec = parseVector(row[colIdx]);
        if (metric === 'cosine') {
            return cosineSimilarity(vec, queryVector);
        } else {
            return euclideanDistance(vec, queryVector);
        }
    });
}

// ─── Vector Index Registry ──────────────────────────────────────────────────

export class VectorIndexRegistry {
    private indexes = new Map<string, VectorIndex>();

    create(
        name: string,
        tableName: string,
        columnName: string,
        vectors: number[][],
        metric: 'cosine' | 'euclidean',
        m?: number,
        efConstruction?: number,
    ): void {
        if (this.indexes.has(name.toLowerCase())) {
            throw new Error(`Vector index already exists: ${name}`);
        }
        const index = createHnswIndex(name, tableName, columnName, vectors, metric, m, efConstruction);
        this.indexes.set(name.toLowerCase(), index);
    }

    get(name: string): VectorIndex | undefined {
        return this.indexes.get(name.toLowerCase());
    }

    drop(name: string): boolean {
        return this.indexes.delete(name.toLowerCase());
    }

    // Find a valid index for the given table and column
    findIndex(tableName: string, columnName: string, metric: 'cosine' | 'euclidean'): VectorIndex | undefined {
        for (const idx of this.indexes.values()) {
            if (idx.tableName.toLowerCase() === tableName.toLowerCase() &&
                idx.columnName.toLowerCase() === columnName.toLowerCase() &&
                idx.metric === metric &&
                idx.valid) {
                return idx;
            }
        }
        return undefined;
    }

    // Invalidate all indexes for a given table
    invalidateForTable(tableName: string): void {
        for (const idx of this.indexes.values()) {
            if (idx.tableName.toLowerCase() === tableName.toLowerCase()) {
                idx.valid = false;
            }
        }
    }

    has(name: string): boolean {
        return this.indexes.has(name.toLowerCase());
    }

    list(): string[] {
        return Array.from(this.indexes.keys());
    }
}
