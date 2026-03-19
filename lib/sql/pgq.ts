// Property Graph support: CSR construction, MATCH execution, graph algorithms.

import { Table } from '../table';
import { Session, StoredTable } from './session';
import { extractRows, materializeTable, RowData } from './js-table';
import {
    PgqCreateGraph, PgqDropGraph, GraphTableRef, VertexTableDef, EdgeTableDef,
    PatternElement, MatchPattern,
} from './pgq-parser';
import { GraphCatalog, PropertyGraph, CSR, setGraphBuilder } from './graph-catalog';

export { GraphCatalog, PropertyGraph, CSR } from './graph-catalog';

function buildCSR(edges: [number, number][], nodeCount: number, weights?: number[], originalEdgeIds?: number[]): CSR {
    // Count outgoing edges per node
    const degree = new Array(nodeCount).fill(0);
    for (const [src] of edges) {
        degree[src]++;
    }

    // Build offsets
    const offsets = new Array(nodeCount + 1);
    offsets[0] = 0;
    for (let i = 0; i < nodeCount; i++) {
        offsets[i + 1] = offsets[i] + degree[i];
    }

    // Fill targets and edgeIds (maps CSR slot -> original edge insertion index)
    const targets = new Array(offsets[nodeCount]);
    const edgeIds = new Array(offsets[nodeCount]);
    const edgeWeights = weights ? new Array(offsets[nodeCount]) : undefined;
    const pos = new Array(nodeCount).fill(0);
    for (let e = 0; e < edges.length; e++) {
        const [src, dst] = edges[e];
        const idx = offsets[src] + pos[src];
        targets[idx] = dst;
        edgeIds[idx] = originalEdgeIds ? originalEdgeIds[e] : e;
        if (edgeWeights && weights) edgeWeights[idx] = weights[e];
        pos[src]++;
    }

    return { nodeCount, offsets, targets, weights: edgeWeights, edgeIds };
}

function buildUndirectedCSR(edges: [number, number][], nodeCount: number, weights?: number[]): CSR {
    // Add reverse edges
    const biEdges: [number, number][] = [];
    const biWeights: number[] = [];
    const biEdgeIds: number[] = [];
    for (let i = 0; i < edges.length; i++) {
        biEdges.push(edges[i]);
        biEdges.push([edges[i][1], edges[i][0]]);
        biEdgeIds.push(i);
        biEdgeIds.push(i); // Reverse edge maps to same original edge
        if (weights) {
            biWeights.push(weights[i]);
            biWeights.push(weights[i]);
        }
    }
    return buildCSR(biEdges, nodeCount, weights ? biWeights : undefined, biEdgeIds);
}

// ─── Property Graph ─────────────────────────────────────────────────────────

function buildPropertyGraph(def: PgqCreateGraph, session: Session): PropertyGraph {
    const nodeIndex = new Map<string, Map<string | number, number>>();
    const nodeInfo = new Map<number, { label: string; tableName: string; key: string | number; row: any[]; columns: string[] }>();
    let nextNodeId = 0;

    // Build vertex tables
    for (const vtDef of def.vertexTables) {
        const stored = session.get(vtDef.table);
        if (!stored) throw new Error(`Vertex table not found: ${vtDef.table}`);

        const data = extractRows(stored.table);
        const label = vtDef.label || vtDef.table;
        const keyColIdx = data.columns.indexOf(vtDef.keyColumn);
        if (keyColIdx === -1) throw new Error(`Key column '${vtDef.keyColumn}' not found in ${vtDef.table}`);

        const labelMap = new Map<string | number, number>();
        for (const row of data.rows) {
            const key = row[keyColIdx];
            const nodeId = nextNodeId++;
            labelMap.set(key, nodeId);
            nodeInfo.set(nodeId, { label, tableName: vtDef.table, key, row, columns: data.columns });
        }
        nodeIndex.set(label.toLowerCase(), labelMap);
        // Also index by table name so edge REFERENCES can find vertices by either
        if (vtDef.label && vtDef.table.toLowerCase() !== label.toLowerCase()) {
            nodeIndex.set(vtDef.table.toLowerCase(), labelMap);
        }
    }

    const nodeCount = nextNodeId;

    // Build edge tables
    const edges: [number, number][] = [];
    const edgeInfo = new Map<number, { label: string; row: any[]; columns: string[] }>();

    for (const etDef of def.edgeTables) {
        const stored = session.get(etDef.table);
        if (!stored) throw new Error(`Edge table not found: ${etDef.table}`);

        const data = extractRows(stored.table);
        const srcColIdx = data.columns.indexOf(etDef.sourceKeyColumn);
        const dstColIdx = data.columns.indexOf(etDef.destKeyColumn);
        if (srcColIdx === -1) throw new Error(`Source key column '${etDef.sourceKeyColumn}' not found in ${etDef.table}`);
        if (dstColIdx === -1) throw new Error(`Dest key column '${etDef.destKeyColumn}' not found in ${etDef.table}`);

        const srcLabel = (etDef.sourceTable || def.vertexTables[0]?.table || '').toLowerCase();
        const dstLabel = (etDef.destTable || def.vertexTables[0]?.table || '').toLowerCase();
        const srcMap = nodeIndex.get(srcLabel);
        const dstMap = nodeIndex.get(dstLabel);
        if (!srcMap) throw new Error(`Source vertex table not found: ${etDef.sourceTable}`);
        if (!dstMap) throw new Error(`Dest vertex table not found: ${etDef.destTable}`);

        const label = etDef.label || etDef.table;

        for (const row of data.rows) {
            const srcKey = row[srcColIdx];
            const dstKey = row[dstColIdx];
            const srcId = srcMap.get(srcKey);
            const dstId = dstMap.get(dstKey);
            if (srcId === undefined || dstId === undefined) continue; // Skip dangling edges

            const edgeIdx = edges.length;
            edges.push([srcId, dstId]);
            edgeInfo.set(edgeIdx, { label, row, columns: data.columns });
        }
    }

    const csr = buildCSR(edges, nodeCount);
    const undirectedCsr = buildUndirectedCSR(edges, nodeCount);

    return {
        name: def.name,
        vertexTables: def.vertexTables,
        edgeTables: def.edgeTables,
        nodeIndex,
        nodeInfo,
        csr,
        undirectedCsr,
        nodeCount,
        edgeInfo,
    };
}

// ─── MATCH pattern execution ────────────────────────────────────────────────

export interface MatchResult {
    bindings: Map<string, number>[];  // variable -> node/edge ID for each match
    // Edge variable names are stored with '__edge__' prefix to distinguish from node IDs
    // (node and edge IDs both start at 0 and can overlap)
}

export function executeMatch(graph: PropertyGraph, pattern: MatchPattern): MatchResult {
    const elements = pattern.elements;
    if (elements.length === 0) return { bindings: [] };

    // Start with the first node element
    const firstNode = elements[0];
    if (firstNode.type !== 'node') throw new Error('Pattern must start with a node');

    // Get candidate start nodes
    const startCandidates = getCandidateNodes(graph, firstNode);

    let bindings: Map<string, number>[] = startCandidates.map(nodeId => {
        const b = new Map<string, number>();
        if (firstNode.variable) b.set(firstNode.variable, nodeId);
        b.set('_pos', 0); // track current node position
        b.set('_node', nodeId); // track current node
        return b;
    });

    // Process remaining elements (edges and nodes alternating)
    for (let i = 1; i < elements.length; i++) {
        const elem = elements[i];
        if (elem.type === 'edge') {
            const nextNode = elements[i + 1]; // The target node pattern
            bindings = expandEdge(graph, bindings, elem, nextNode, pattern.pathMode);
            i++; // skip the next node (already handled)
        }
    }

    // If shortest path mode, filter to shortest paths
    if (pattern.pathMode === 'any_shortest') {
        bindings = filterAnyShortest(bindings, elements);
    } else if (pattern.pathMode === 'all_shortest') {
        bindings = filterAllShortest(bindings, elements);
    }

    // Clean up internal tracking keys
    for (const b of bindings) {
        b.delete('_pos');
        b.delete('_node');
        b.delete('_depth');
    }

    return { bindings };
}

function getCandidateNodes(graph: PropertyGraph, nodePattern: PatternElement): number[] {
    if (nodePattern.labels && nodePattern.labels.length > 0) {
        const seen = new Set<number>();
        const candidates: number[] = [];
        for (const label of nodePattern.labels) {
            const labelMap = graph.nodeIndex.get(label.toLowerCase());
            if (labelMap) {
                for (const nodeId of labelMap.values()) {
                    if (!seen.has(nodeId)) {
                        seen.add(nodeId);
                        candidates.push(nodeId);
                    }
                }
            }
        }
        return candidates;
    }
    // No label filter - all nodes
    return Array.from({ length: graph.nodeCount }, (_, i) => i);
}

function expandEdge(
    graph: PropertyGraph,
    currentBindings: Map<string, number>[],
    edgePattern: PatternElement,
    targetNodePattern: PatternElement | undefined,
    pathMode?: string,
): Map<string, number>[] {
    const results: Map<string, number>[] = [];
    const quantifier = edgePattern.quantifier;

    for (const binding of currentBindings) {
        const currentNode = binding.get('_node')!;

        if (quantifier) {
            // Variable-length path
            const paths = expandVariableLengthPath(
                graph, currentNode, edgePattern, targetNodePattern, quantifier.min, quantifier.max, pathMode,
            );
            for (const { endNode, depth } of paths) {
                // Enforce already-bound variable: if variable was previously bound,
                // the end node must match the existing binding (e.g., (n)-[*]->(n) = cycles only)
                if (targetNodePattern?.variable) {
                    const existing = binding.get(targetNodePattern.variable);
                    if (existing !== undefined && existing !== endNode) continue;
                }
                const newBinding = new Map(binding);
                if (targetNodePattern?.variable) newBinding.set(targetNodePattern.variable, endNode);
                newBinding.set('_node', endNode);
                newBinding.set('_depth', depth);
                results.push(newBinding);
            }
        } else {
            // Single hop - iterate CSR entries directly to handle multigraphs correctly
            const entries = getCSREntries(graph, currentNode, edgePattern.direction || '->');
            for (const { target: neighbor, edgeId: edgeIdx } of entries) {
                // Check target node label (matches against both label and table name)
                if (targetNodePattern && targetNodePattern.labels) {
                    if (!matchesLabel(graph, neighbor, targetNodePattern.labels)) {
                        continue;
                    }
                }
                // Check edge label if specified in the pattern
                if (edgePattern.labels && edgePattern.labels.length > 0) {
                    const edgeData = graph.edgeInfo.get(edgeIdx);
                    if (!edgeData || !edgePattern.labels.some(l => l.toLowerCase() === edgeData.label.toLowerCase())) {
                        continue;
                    }
                }
                // Enforce already-bound variables: (n)-[:E]->(n) should only match self-loops
                if (edgePattern.variable) {
                    const existing = binding.get(`__edge__${edgePattern.variable}`);
                    if (existing !== undefined && existing !== edgeIdx) continue;
                }
                if (targetNodePattern?.variable) {
                    const existing = binding.get(targetNodePattern.variable);
                    if (existing !== undefined && existing !== neighbor) continue;
                }
                const newBinding = new Map(binding);
                if (edgePattern.variable) {
                    newBinding.set(`__edge__${edgePattern.variable}`, edgeIdx);
                }
                if (targetNodePattern?.variable) newBinding.set(targetNodePattern.variable, neighbor);
                newBinding.set('_node', neighbor);
                results.push(newBinding);
            }
        }
    }

    return results;
}

interface CSREntry {
    target: number;
    edgeId: number;
}

function getCSREntries(graph: PropertyGraph, nodeId: number, direction: string): CSREntry[] {
    if (direction === '->' || direction === '-') {
        const csr = direction === '-' ? graph.undirectedCsr : graph.csr;
        const start = csr.offsets[nodeId];
        const end = csr.offsets[nodeId + 1];
        const entries: CSREntry[] = [];
        for (let i = start; i < end; i++) {
            entries.push({ target: csr.targets[i], edgeId: csr.edgeIds ? csr.edgeIds[i] : i });
        }
        return entries;
    }
    if (direction === '<-') {
        const entries: CSREntry[] = [];
        for (let src = 0; src < graph.csr.nodeCount; src++) {
            const start = graph.csr.offsets[src];
            const end = graph.csr.offsets[src + 1];
            for (let j = start; j < end; j++) {
                if (graph.csr.targets[j] === nodeId) {
                    entries.push({ target: src, edgeId: graph.csr.edgeIds ? graph.csr.edgeIds[j] : j });
                }
            }
        }
        return entries;
    }
    if (direction === '<->') {
        const forward = getCSREntries(graph, nodeId, '->');
        const reverse = getCSREntries(graph, nodeId, '<-');
        return [...forward, ...reverse];
    }
    return [];
}

function findEdgeIndex(graph: PropertyGraph, src: number, dst: number): number | undefined {
    const start = graph.csr.offsets[src];
    const end = graph.csr.offsets[src + 1];
    for (let i = start; i < end; i++) {
        if (graph.csr.targets[i] === dst) {
            // Return the original edge insertion index, not the CSR slot
            return graph.csr.edgeIds ? graph.csr.edgeIds[i] : i;
        }
    }
    return undefined;
}

interface PathResult {
    endNode: number;
    depth: number;
}

function expandVariableLengthPath(
    graph: PropertyGraph,
    startNode: number,
    edgePattern: PatternElement,
    targetNodePattern: PatternElement | undefined,
    minDepth: number,
    maxDepth: number,
    pathMode?: string,
): PathResult[] {
    const results: PathResult[] = [];
    const maxSteps = Math.min(maxDepth, 100); // Safety cap
    const MAX_RESULTS = 10000; // Prevent unbounded memory growth
    const MAX_QUEUE_SIZE = 100000; // Prevent unbounded frontier growth in WALK mode
    const direction = edgePattern.direction || '->';
    const isWalk = pathMode === 'walk';

    // BFS - WALK mode allows revisiting nodes; simple path mode tracks visited set
    const queue: { node: number; depth: number; visited: Set<number> | null }[] = [
        { node: startNode, depth: 0, visited: isWalk ? null : new Set([startNode]) },
    ];
    let queueHead = 0; // Index pointer instead of shift() for O(1) dequeue

    let truncated = false;
    while (queueHead < queue.length) {
        if (results.length >= MAX_RESULTS) { truncated = true; break; }
        const { node, depth, visited } = queue[queueHead++];

        if (depth >= minDepth) {
            // Check if node matches target pattern
            if (!targetNodePattern?.labels || matchesLabel(graph, node, targetNodePattern.labels)) {
                results.push({ endNode: node, depth });
            }
        }

        if (depth >= maxSteps) continue;

        const entries = getCSREntries(graph, node, direction);
        for (const { target: neighbor, edgeId } of entries) {
            // In simple path mode, reject revisits; in WALK mode, allow all
            if (visited && visited.has(neighbor)) continue;

            // Check edge label if specified in the pattern
            if (edgePattern.labels && edgePattern.labels.length > 0) {
                const edgeData = graph.edgeInfo.get(edgeId);
                if (!edgeData || !edgePattern.labels.some(l => l.toLowerCase() === edgeData.label.toLowerCase())) {
                    continue;
                }
            }
            if (queue.length - queueHead >= MAX_QUEUE_SIZE) { truncated = true; break; }
            const newVisited = visited ? new Set(visited) : null;
            if (newVisited) newVisited.add(neighbor);
            queue.push({ node: neighbor, depth: depth + 1, visited: newVisited });
        }
    }

    if (truncated) {
        console.warn(
            `[teide] variable-length path expansion truncated: results may be incomplete ` +
            `(hit ${results.length >= MAX_RESULTS ? 'MAX_RESULTS' : 'MAX_QUEUE_SIZE'} limit)`
        );
    }
    return results;
}

function matchesLabel(graph: PropertyGraph, nodeId: number, labels: string[]): boolean {
    const info = graph.nodeInfo.get(nodeId);
    if (!info) return false;
    return labels.some(l => {
        const lower = l.toLowerCase();
        return lower === info.label.toLowerCase() || lower === info.tableName.toLowerCase();
    });
}

function filterAnyShortest(bindings: Map<string, number>[], elements: PatternElement[]): Map<string, number>[] {
    if (bindings.length === 0) return bindings;

    const startVar = elements[0].variable;
    const endVar = elements[elements.length - 1]?.variable;
    if (!startVar || !endVar) return bindings;

    // Group by (start, end) pair, keep only shortest
    const groups = new Map<string, Map<string, number>[]>();
    for (const b of bindings) {
        const key = `${b.get(startVar)}-${b.get(endVar)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(b);
    }

    const result: Map<string, number>[] = [];
    for (const group of groups.values()) {
        const minDepth = Math.min(...group.map(b => b.get('_depth') ?? 1));
        const shortest = group.filter(b => (b.get('_depth') ?? 1) === minDepth);
        result.push(shortest[0]); // ANY = just one
    }

    return result;
}

function filterAllShortest(bindings: Map<string, number>[], elements: PatternElement[]): Map<string, number>[] {
    if (bindings.length === 0) return bindings;

    const startVar = elements[0].variable;
    const endVar = elements[elements.length - 1]?.variable;
    if (!startVar || !endVar) return bindings;

    const groups = new Map<string, Map<string, number>[]>();
    for (const b of bindings) {
        const key = `${b.get(startVar)}-${b.get(endVar)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(b);
    }

    const result: Map<string, number>[] = [];
    for (const group of groups.values()) {
        const minDepth = Math.min(...group.map(b => b.get('_depth') ?? 1));
        result.push(...group.filter(b => (b.get('_depth') ?? 1) === minDepth));
    }

    return result;
}

// ─── GRAPH_TABLE execution ──────────────────────────────────────────────────

export function executeGraphTable(
    ref: GraphTableRef,
    graphCatalog: GraphCatalog,
    session: Session,
    ctx: any,
): Table {
    const graph = graphCatalog.getGraph(ref.graphName);
    if (!graph) throw new Error(`Property graph not found: ${ref.graphName}`);

    const matchResult = executeMatch(graph, ref.matchPattern);

    // Build result columns from COLUMNS clause
    const columns: string[] = [];
    const colData: any[][] = [];

    if (ref.columns.length === 0) {
        // Default: return all bound variables with their keys
        for (const binding of matchResult.bindings) {
            // Just return the binding keys for now
        }
        // Return empty table if no columns specified
        return materializeTable({ columns: ['node_id'], rows: matchResult.bindings.map(b => [b.values().next().value ?? 0]) }, ctx);
    }

    for (const col of ref.columns) {
        const alias = col.alias || `${col.variable}_${col.property}`;
        columns.push(alias);
        const values: any[] = [];

        for (const binding of matchResult.bindings) {
            // Check for edge variable first (stored with __edge__ prefix)
            const edgeId = binding.get(`__edge__${col.variable}`);
            if (edgeId !== undefined) {
                const edgeData = graph.edgeInfo.get(edgeId);
                if (edgeData) {
                    const propIdx = edgeData.columns.indexOf(col.property);
                    values.push(propIdx >= 0 ? edgeData.row[propIdx] : '');
                } else {
                    values.push('');
                }
                continue;
            }

            // Node variable
            const id = binding.get(col.variable);
            if (id === undefined) {
                values.push('');
                continue;
            }

            const info = graph.nodeInfo.get(id);
            if (info) {
                const propIdx = info.columns.indexOf(col.property);
                values.push(propIdx >= 0 ? info.row[propIdx] : '');
            } else {
                values.push('');
            }
        }

        colData.push(values);
    }

    // Build rows
    const nRows = matchResult.bindings.length;
    const rows: any[][] = [];
    for (let i = 0; i < nRows; i++) {
        rows.push(columns.map((_, c) => colData[c][i]));
    }

    return materializeTable({ columns, rows }, ctx);
}

// ─── Graph Algorithms ───────────────────────────────────────────────────────

export function pagerank(graph: PropertyGraph, damping = 0.85, iterations = 20): Map<number, number> {
    const n = graph.nodeCount;
    if (n === 0) return new Map();

    let ranks = new Array(n).fill(1.0 / n);
    const csr = graph.csr;

    for (let iter = 0; iter < iterations; iter++) {
        const newRanks = new Array(n).fill((1 - damping) / n);

        for (let src = 0; src < n; src++) {
            const outDegree = csr.offsets[src + 1] - csr.offsets[src];
            if (outDegree === 0) {
                // Dangling node: distribute rank equally
                const share = damping * ranks[src] / n;
                for (let j = 0; j < n; j++) newRanks[j] += share;
            } else {
                const share = damping * ranks[src] / outDegree;
                for (let j = csr.offsets[src]; j < csr.offsets[src + 1]; j++) {
                    newRanks[csr.targets[j]] += share;
                }
            }
        }

        ranks = newRanks;
    }

    const result = new Map<number, number>();
    for (let i = 0; i < n; i++) result.set(i, ranks[i]);
    return result;
}

export function connectedComponents(graph: PropertyGraph): Map<number, number> {
    const n = graph.nodeCount;
    const component = new Array(n).fill(-1);
    let compId = 0;
    const csr = graph.undirectedCsr;

    for (let start = 0; start < n; start++) {
        if (component[start] !== -1) continue;

        // BFS
        const queue = [start];
        component[start] = compId;
        let head = 0;

        while (head < queue.length) {
            const node = queue[head++];
            for (let j = csr.offsets[node]; j < csr.offsets[node + 1]; j++) {
                const neighbor = csr.targets[j];
                if (component[neighbor] === -1) {
                    component[neighbor] = compId;
                    queue.push(neighbor);
                }
            }
        }
        compId++;
    }

    const result = new Map<number, number>();
    for (let i = 0; i < n; i++) result.set(i, component[i]);
    return result;
}

export function louvainCommunity(graph: PropertyGraph): Map<number, number> {
    const n = graph.nodeCount;
    const csr = graph.undirectedCsr;

    // Initialize each node in its own community
    const community = new Array(n);
    for (let i = 0; i < n; i++) community[i] = i;

    // Total weight (number of edges * 2 for undirected)
    const m = csr.targets.length;
    if (m === 0) {
        const result = new Map<number, number>();
        for (let i = 0; i < n; i++) result.set(i, i);
        return result;
    }

    // Degree of each node
    const degree = new Array(n);
    for (let i = 0; i < n; i++) {
        degree[i] = csr.offsets[i + 1] - csr.offsets[i];
    }

    // Iterate until no improvement
    let improved = true;
    let iterations = 0;
    while (improved && iterations < 100) {
        improved = false;
        iterations++;

        for (let node = 0; node < n; node++) {
            const currentComm = community[node];

            // Count edges to each neighboring community
            const commEdges = new Map<number, number>();
            for (let j = csr.offsets[node]; j < csr.offsets[node + 1]; j++) {
                const neighbor = csr.targets[j];
                const nComm = community[neighbor];
                commEdges.set(nComm, (commEdges.get(nComm) || 0) + 1);
            }

            // Find best community
            let bestComm = currentComm;
            let bestGain = 0;

            for (const [comm, edgesToComm] of commEdges) {
                if (comm === currentComm) continue;

                // Simplified modularity gain
                const gain = edgesToComm - degree[node] * communityDegree(community, degree, comm) / m;
                if (gain > bestGain) {
                    bestGain = gain;
                    bestComm = comm;
                }
            }

            if (bestComm !== currentComm) {
                community[node] = bestComm;
                improved = true;
            }
        }
    }

    // Renumber communities to be contiguous
    const renumber = new Map<number, number>();
    let nextId = 0;
    const result = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        const c = community[i];
        if (!renumber.has(c)) renumber.set(c, nextId++);
        result.set(i, renumber.get(c)!);
    }
    return result;
}

function communityDegree(community: number[], degree: number[], commId: number): number {
    let total = 0;
    for (let i = 0; i < community.length; i++) {
        if (community[i] === commId) total += degree[i];
    }
    return total;
}

export function clusteringCoefficient(graph: PropertyGraph): Map<number, number> {
    const n = graph.nodeCount;
    const csr = graph.undirectedCsr;
    const result = new Map<number, number>();

    for (let node = 0; node < n; node++) {
        const start = csr.offsets[node];
        const end = csr.offsets[node + 1];
        const neighbors = csr.targets.slice(start, end);
        const k = neighbors.length;

        if (k < 2) {
            result.set(node, 0);
            continue;
        }

        // Count edges between neighbors
        const neighborSet = new Set(neighbors);
        let triangles = 0;
        for (const u of neighbors) {
            const uStart = csr.offsets[u];
            const uEnd = csr.offsets[u + 1];
            for (let j = uStart; j < uEnd; j++) {
                if (neighborSet.has(csr.targets[j])) {
                    triangles++;
                }
            }
        }

        // Each triangle is counted twice (from each neighbor's perspective)
        result.set(node, triangles / (k * (k - 1)));
    }

    return result;
}

export function dijkstra(
    graph: PropertyGraph,
    sourceId: number,
    targetId?: number,
    weightColumn?: string,
): Map<number, number> {
    const n = graph.nodeCount;
    const csr = graph.csr;

    // Resolve edge weight lookup: if a weight column is specified, look up
    // weights from edgeInfo rows via the CSR edgeIds mapping.
    let edgeWeightColIdx: number | undefined;
    if (weightColumn && graph.edgeInfo.size > 0) {
        const firstEdge = graph.edgeInfo.values().next().value;
        if (firstEdge) {
            edgeWeightColIdx = firstEdge.columns.indexOf(weightColumn);
            if (edgeWeightColIdx === -1) edgeWeightColIdx = undefined;
        }
    }

    const dist = new Array(n).fill(Infinity);
    dist[sourceId] = 0;
    const visited = new Set<number>();

    // Simple priority queue (array-based for small graphs)
    const pq: { node: number; dist: number }[] = [{ node: sourceId, dist: 0 }];

    while (pq.length > 0) {
        // Extract min
        pq.sort((a, b) => a.dist - b.dist);
        const { node: u, dist: d } = pq.shift()!;

        if (visited.has(u)) continue;
        visited.add(u);

        if (d > dist[u]) continue;
        if (targetId !== undefined && u === targetId) break;

        for (let j = csr.offsets[u]; j < csr.offsets[u + 1]; j++) {
            const v = csr.targets[j];
            let w = csr.weights ? csr.weights[j] : 1;
            // Override with edge-row weight when a weight column is specified
            if (edgeWeightColIdx !== undefined && csr.edgeIds) {
                const edgeId = csr.edgeIds[j];
                const info = graph.edgeInfo.get(edgeId);
                if (info) {
                    const val = info.row[edgeWeightColIdx];
                    if (typeof val === 'number') w = val;
                }
            }
            const newDist = dist[u] + w;

            if (newDist < dist[v]) {
                dist[v] = newDist;
                pq.push({ node: v, dist: newDist });
            }
        }
    }

    const result = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        if (dist[i] < Infinity) result.set(i, dist[i]);
    }
    return result;
}

// ─── Algorithm SQL function execution ───────────────────────────────────────

export function executeGraphAlgorithm(
    funcName: string,
    graphName: string,
    graphCatalog: GraphCatalog,
    session: Session,
    ctx: any,
    args?: any[],
): Table {
    const graph = graphCatalog.getGraph(graphName);
    if (!graph) throw new Error(`Property graph not found: ${graphName}`);

    switch (funcName.toUpperCase()) {
        case 'PAGERANK': {
            const ranks = pagerank(graph);
            return algorithmResultToTable(graph, ranks, 'node_key', 'pagerank', ctx);
        }
        case 'CONNECTED_COMPONENT':
        case 'COMPONENT': {
            const comps = connectedComponents(graph);
            return algorithmResultToTable(graph, comps, 'node_key', 'component', ctx);
        }
        case 'COMMUNITY':
        case 'LOUVAIN': {
            const comms = louvainCommunity(graph);
            return algorithmResultToTable(graph, comms, 'node_key', 'community', ctx);
        }
        case 'CLUSTERING_COEFFICIENT': {
            const coeffs = clusteringCoefficient(graph);
            return algorithmResultToTable(graph, coeffs, 'node_key', 'clustering_coefficient', ctx);
        }
        case 'SHORTEST_DISTANCE':
        case 'DIJKSTRA': {
            const srcArg = args?.[0];
            const dstArg = args?.[1];
            const weightCol = args?.[2];
            if (srcArg === undefined) throw new Error(`${funcName} requires source node argument`);
            const srcId = resolveNodeId(graph, srcArg);
            const dstId = dstArg !== undefined ? resolveNodeId(graph, dstArg) : undefined;
            const weightColumn = typeof weightCol === 'string' ? weightCol : undefined;
            const distances = dijkstra(graph, srcId, dstId, weightColumn);
            // When a specific destination is requested, return only that row
            if (dstId !== undefined) {
                const filtered = new Map<number, number>();
                if (distances.has(dstId)) filtered.set(dstId, distances.get(dstId)!);
                return algorithmResultToTable(graph, filtered, 'node_key', 'distance', ctx);
            }
            return algorithmResultToTable(graph, distances, 'node_key', 'distance', ctx);
        }
        default:
            throw new Error(`Unknown graph algorithm: ${funcName}`);
    }
}

function resolveNodeId(graph: PropertyGraph, arg: any): number {
    // Always look up by key across all vertex tables first (handles both
    // string and numeric business keys correctly).
    for (const [, labelMap] of graph.nodeIndex) {
        const id = labelMap.get(arg);
        if (id !== undefined) return id;
    }
    // Fallback for numeric args: treat as internal node ID if within range
    if (typeof arg === 'number' && Number.isInteger(arg) && arg >= 0 && arg < graph.nodeCount) {
        return arg;
    }
    throw new Error(`Node not found: ${arg}`);
}

function algorithmResultToTable(
    graph: PropertyGraph,
    values: Map<number, number>,
    keyCol: string,
    valueCol: string,
    ctx: any,
): Table {
    const columns = [keyCol, valueCol];
    const rows: any[][] = [];

    for (const [nodeId, value] of values) {
        const info = graph.nodeInfo.get(nodeId);
        const key = info ? info.key : nodeId;
        rows.push([key, value]);
    }

    return materializeTable({ columns, rows }, ctx);
}

// Register the graph builder to break circular dependency
setGraphBuilder(buildPropertyGraph);
