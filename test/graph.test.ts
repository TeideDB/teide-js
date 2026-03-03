import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Context, Rel, Graph } from '../lib';

const EDGES = path.join(__dirname, 'fixtures', 'edges.csv');
const NODES = path.join(__dirname, 'fixtures', 'nodes.csv');

describe('Rel', () => {
    it('fromEdgesSync builds CSR from edge table', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });
            expect(rel).toBeDefined();
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('fromEdges async builds CSR', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = await Rel.fromEdges(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });
            expect(rel).toBeDefined();
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('save/load roundtrip', () => {
        const ctx = new Context();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-rel-'));
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            rel.saveSync(dir);

            const rel2 = Rel.loadSync(ctx, dir);

            // Verify by expanding from node 0
            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.expandSync('node', rel2, 'fwd');
            expect(result.nRows).toBe(2);

            rel.destroy();
            rel2.destroy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            ctx.destroy();
        }
    });

    it('save/load async roundtrip', async () => {
        const ctx = new Context();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-rel-'));
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = await Rel.fromEdges(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            await rel.save(dir);

            const rel2 = await Rel.load(ctx, dir);

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.expand('node', rel2, 'fwd');
            expect(result.nRows).toBe(2);

            rel.destroy();
            rel2.destroy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            ctx.destroy();
        }
    });

    it('mmap loads relationship', () => {
        const ctx = new Context();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-rel-'));
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            rel.saveSync(dir);

            const rel2 = Rel.mmapSync(ctx, dir);

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.expandSync('node', rel2, 'fwd');
            expect(result.nRows).toBe(2);

            rel.destroy();
            rel2.destroy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            ctx.destroy();
        }
    });

    it('Symbol.dispose cleans up', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            {
                const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5 });
                rel[Symbol.dispose]();
            }
            // Should not crash
        } finally {
            ctx.destroy();
        }
    });
});

describe('Graph - expand', () => {
    it('expand forward from node 0 finds 2 neighbors', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.expandSync('node', rel, 'fwd');

            // Node 0 has outgoing edges to 1 and 2
            expect(result.nRows).toBe(2);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('expand async forward from node 0', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.expand('node', rel, 'fwd');

            expect(result.nRows).toBe(2);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('expand reverse from node 3 finds 2 sources', () => {
        const ctx = new Context();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-node3-'));
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            // Node 3 has incoming edges from 1 and 2
            const csvPath = path.join(dir, 'node3.csv');
            fs.writeFileSync(csvPath, 'node\n3\n');
            const node3 = ctx.readCsvSync(csvPath);

            const g = ctx.graph(node3);
            const result = g.expandSync('node', rel, 'rev');

            expect(result.nRows).toBe(2);
            rel.destroy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            ctx.destroy();
        }
    });
});

describe('Graph - varExpand', () => {
    it('variable-length BFS depth 1-3 from node 0', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.varExpandSync('node', rel, 'fwd', { minDepth: 1, maxDepth: 3 });

            // Node 0 can reach: depth 1 -> {1,2}, depth 2 -> {3}, depth 3 -> {4}
            // 4 distinct (node, depth) pairs
            expect(result.nRows).toBe(4);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('varExpand async', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.varExpand('node', rel, 'fwd', { minDepth: 1, maxDepth: 3 });

            expect(result.nRows).toBe(4);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });
});

describe('Graph - shortestPath', () => {
    it('finds path from 0 to 4', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.shortestPathSync(0, 4, rel, { maxDepth: 10 });

            // Path has 4 nodes (e.g. 0->1->3->4), result table has _node and _depth columns
            expect(result.nRows).toBe(4);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('shortestPath async', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.shortestPath(0, 4, rel, { maxDepth: 10 });

            expect(result.nRows).toBe(4);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });
});

describe('Graph - wcoJoin', () => {
    it('triangle detection with sorted rels', () => {
        const ctx = new Context();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-tri-'));
        try {
            // For WCO join, we need a graph with triangles and sorted adjacency lists
            // Triangle: 0->1, 1->2, 0->2
            const triPath = path.join(dir, 'tri.csv');
            fs.writeFileSync(triPath, 'src,dst\n0,1\n0,2\n1,2\n');
            const triEdges = ctx.readCsvSync(triPath);

            const rel = Rel.fromEdgesSync(triEdges, 'src', 'dst', { nSrc: 3, nDst: 3, sort: true });

            // Use a node table that covers all 3 triangle vertices
            const nodesPath = path.join(dir, 'tri_nodes.csv');
            fs.writeFileSync(nodesPath, 'node\n0\n1\n2\n');
            const triNodes = ctx.readCsvSync(nodesPath);

            const g = ctx.graph(triNodes);
            const result = g.wcoJoinSync([rel, rel, rel], { nVars: 3 });

            // Exactly one triangle: (0, 1, 2)
            expect(result.nRows).toBe(1);
            rel.destroy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            ctx.destroy();
        }
    });
});
