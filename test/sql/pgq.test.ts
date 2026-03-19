import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '../../lib';
import { parsePgq } from '../../lib/sql/pgq-parser';
import { Session } from '../../lib/sql/session';
import {
    pagerank,
    connectedComponents,
    louvainCommunity,
    clusteringCoefficient,
    dijkstra,
} from '../../lib/sql/pgq';

function createSocialGraph(ctx: Context) {
    ctx.executeSync(`CREATE TABLE persons (id INT, name VARCHAR(50), age INT)`);
    ctx.executeSync(`INSERT INTO persons VALUES (1, 'Alice', 30)`);
    ctx.executeSync(`INSERT INTO persons VALUES (2, 'Bob', 25)`);
    ctx.executeSync(`INSERT INTO persons VALUES (3, 'Carol', 35)`);
    ctx.executeSync(`INSERT INTO persons VALUES (4, 'Dave', 28)`);
    ctx.executeSync(`INSERT INTO persons VALUES (5, 'Eve', 32)`);

    ctx.executeSync(`CREATE TABLE friendships (person1_id INT, person2_id INT, since INT)`);
    ctx.executeSync(`INSERT INTO friendships VALUES (1, 2, 2020)`);
    ctx.executeSync(`INSERT INTO friendships VALUES (1, 3, 2019)`);
    ctx.executeSync(`INSERT INTO friendships VALUES (2, 4, 2021)`);
    ctx.executeSync(`INSERT INTO friendships VALUES (3, 5, 2022)`);
    ctx.executeSync(`INSERT INTO friendships VALUES (4, 5, 2023)`);
}

function createPropertyGraph(ctx: Context) {
    ctx.executeSync(`
        CREATE PROPERTY GRAPH social
        VERTEX TABLES (persons KEY (id))
        EDGE TABLES (
            friendships SOURCE KEY (person1_id) REFERENCES persons
            DESTINATION KEY (person2_id) REFERENCES persons
        )
    `);
}

function buildGraphForAlgorithms(ctx: Context): Session {
    const session = new Session();
    const persons = ctx.executeSync('SELECT * FROM persons')!;
    const friendships = ctx.executeSync('SELECT * FROM friendships')!;
    session.register('persons', persons);
    session.register('friendships', friendships);

    session.graphCatalog.createGraph({
        type: 'create_property_graph',
        orReplace: false,
        ifNotExists: false,
        name: 'social',
        vertexTables: [{ table: 'persons', keyColumn: 'id', properties: { mode: 'all' as const } }],
        edgeTables: [{
            table: 'friendships',
            sourceTable: 'persons',
            sourceKeyColumn: 'person1_id',
            destTable: 'persons',
            destKeyColumn: 'person2_id',
            properties: { mode: 'all' as const },
        }],
    }, session);

    return session;
}

describe('SQL Property Graphs (PGQ)', () => {
    let ctx: Context;

    beforeEach(() => {
        ctx = new Context();
        createSocialGraph(ctx);
    });

    afterEach(() => {
        ctx.destroy();
    });

    // ─── CREATE / DROP PROPERTY GRAPH ───────────────────────────────────

    describe('CREATE PROPERTY GRAPH', () => {
        it('creates a property graph with vertex and edge tables', () => {
            createPropertyGraph(ctx);
            // Graph exists (no error on second IF NOT EXISTS)
            ctx.executeSync(`
                CREATE PROPERTY GRAPH IF NOT EXISTS social
                VERTEX TABLES (persons KEY (id))
                EDGE TABLES (
                    friendships SOURCE KEY (person1_id) REFERENCES persons
                    DESTINATION KEY (person2_id) REFERENCES persons
                )
            `);
        });

        it('throws when graph already exists without IF NOT EXISTS', () => {
            createPropertyGraph(ctx);
            expect(() => createPropertyGraph(ctx)).toThrow(/already exists/);
        });

        it('CREATE OR REPLACE replaces existing graph', () => {
            createPropertyGraph(ctx);
            ctx.executeSync(`
                CREATE OR REPLACE PROPERTY GRAPH social
                VERTEX TABLES (persons KEY (id))
                EDGE TABLES (
                    friendships SOURCE KEY (person1_id) REFERENCES persons
                    DESTINATION KEY (person2_id) REFERENCES persons
                )
            `);
        });
    });

    describe('DROP PROPERTY GRAPH', () => {
        it('drops an existing property graph', () => {
            createPropertyGraph(ctx);
            ctx.executeSync('DROP PROPERTY GRAPH social');
        });

        it('DROP IF EXISTS does not throw for missing graph', () => {
            ctx.executeSync('DROP PROPERTY GRAPH IF EXISTS nonexistent');
        });

        it('DROP throws for missing graph without IF EXISTS', () => {
            expect(() => ctx.executeSync('DROP PROPERTY GRAPH nonexistent')).toThrow(/not found/);
        });
    });

    // ─── GRAPH_TABLE with MATCH ─────────────────────────────────────────

    describe('GRAPH_TABLE with MATCH', () => {
        beforeEach(() => {
            createPropertyGraph(ctx);
        });

        it('matches single-hop directed pattern', () => {
            const result = ctx.executeSync(`
                SELECT * FROM GRAPH_TABLE(social,
                    MATCH (a:persons)->(b:persons)
                    COLUMNS (a.name AS src_name, b.name AS dst_name)
                )
            `)!;

            expect(result.nRows).toBe(5); // 5 directed edges
            expect(result.columns).toContain('src_name');
            expect(result.columns).toContain('dst_name');
        });

        it('matches pattern returning node properties', () => {
            const result = ctx.executeSync(`
                SELECT * FROM GRAPH_TABLE(social,
                    MATCH (a:persons)->(b:persons)
                    COLUMNS (a.name AS person1, b.age AS person2_age)
                )
            `)!;

            expect(result.nRows).toBe(5);
            expect(result.columns).toContain('person1');
            expect(result.columns).toContain('person2_age');
        });
    });

    // ─── Path Traversal ─────────────────────────────────────────────────

    describe('Path traversal', () => {
        beforeEach(() => {
            createPropertyGraph(ctx);
        });

        it('variable-length path with quantifier {1,3}', () => {
            const result = ctx.executeSync(`
                SELECT * FROM GRAPH_TABLE(social,
                    MATCH (a:persons)->{1,3}(b:persons)
                    COLUMNS (a.name AS start_name, b.name AS end_name)
                )
            `)!;

            // Should find paths of length 1-3
            // Direct edges (5) + 2-hop paths + 3-hop paths
            expect(result.nRows).toBeGreaterThanOrEqual(5);
        });
    });

    // ─── Graph Algorithms ───────────────────────────────────────────────

    describe('Graph Algorithms', () => {
        it('PageRank computes centrality scores', () => {
            const session = buildGraphForAlgorithms(ctx);
            const graph = session.graphCatalog.getGraph('social')!;
            const ranks = pagerank(graph);
            expect(ranks.size).toBe(5);
            let total = 0;
            for (const [, rank] of ranks) {
                expect(rank).toBeGreaterThan(0);
                total += rank;
            }
            expect(total).toBeCloseTo(1.0, 1);
        });

        it('Connected Components finds all nodes in one component', () => {
            const session = buildGraphForAlgorithms(ctx);
            const graph = session.graphCatalog.getGraph('social')!;
            const comps = connectedComponents(graph);
            expect(comps.size).toBe(5);
            const compValues = new Set(comps.values());
            expect(compValues.size).toBe(1);
        });

        it('Louvain Community detection assigns communities', () => {
            const session = buildGraphForAlgorithms(ctx);
            const graph = session.graphCatalog.getGraph('social')!;
            const comms = louvainCommunity(graph);
            expect(comms.size).toBe(5);
            for (const [, comm] of comms) {
                expect(comm).toBeGreaterThanOrEqual(0);
            }
        });

        it('Clustering Coefficient computes local clustering', () => {
            const session = buildGraphForAlgorithms(ctx);
            const graph = session.graphCatalog.getGraph('social')!;
            const coeffs = clusteringCoefficient(graph);
            expect(coeffs.size).toBe(5);
            for (const [, coeff] of coeffs) {
                expect(coeff).toBeGreaterThanOrEqual(0);
                expect(coeff).toBeLessThanOrEqual(1);
            }
        });

        it('Dijkstra computes shortest distances', () => {
            const session = buildGraphForAlgorithms(ctx);
            const graph = session.graphCatalog.getGraph('social')!;
            // Alice (node 0) to all others
            const distances = dijkstra(graph, 0);
            expect(distances.get(0)).toBe(0); // Distance to self
            expect(distances.get(1)).toBe(1); // Alice -> Bob (direct)
            expect(distances.get(2)).toBe(1); // Alice -> Carol (direct)
            expect(distances.get(3)).toBe(2); // Alice -> Bob -> Dave
            expect(distances.get(4)).toBe(2); // Alice -> Carol -> Eve
        });
    });

    // ─── Graph invalidation on table mutation ───────────────────────────

    describe('Graph invalidation', () => {
        it('invalidates graph when underlying table is dropped', () => {
            createPropertyGraph(ctx);
            ctx.executeSync('DROP TABLE persons');

            // Recreate table and graph (old graph was invalidated)
            ctx.executeSync('CREATE TABLE persons (id INT, name VARCHAR(50), age INT)');
            ctx.executeSync(`INSERT INTO persons VALUES (1, 'Alice', 30)`);

            // This should succeed because the old graph was invalidated
            ctx.executeSync(`
                CREATE PROPERTY GRAPH social
                VERTEX TABLES (persons KEY (id))
                EDGE TABLES (
                    friendships SOURCE KEY (person1_id) REFERENCES persons
                    DESTINATION KEY (person2_id) REFERENCES persons
                )
            `);
        });
    });

    // ─── PGQ Pre-parser unit tests ──────────────────────────────────────

    describe('PGQ Pre-parser', () => {
        it('returns null for standard SQL', () => {
            expect(parsePgq('SELECT * FROM users')).toBeNull();
            expect(parsePgq('INSERT INTO users VALUES (1)')).toBeNull();
            expect(parsePgq('CREATE TABLE users (id INT)')).toBeNull();
        });

        it('parses CREATE PROPERTY GRAPH', () => {
            const result = parsePgq(`
                CREATE PROPERTY GRAPH social
                VERTEX TABLES (persons KEY (id) LABEL Person)
                EDGE TABLES (
                    friendships
                        SOURCE KEY (person1_id) REFERENCES persons
                        DESTINATION KEY (person2_id) REFERENCES persons
                        LABEL knows
                )
            `)!;
            expect(result).not.toBeNull();
            expect(result.type).toBe('create_property_graph');
            if (result.type === 'create_property_graph') {
                expect(result.name).toBe('social');
                expect(result.vertexTables).toHaveLength(1);
                expect(result.vertexTables[0].table).toBe('persons');
                expect(result.vertexTables[0].keyColumn).toBe('id');
                expect(result.vertexTables[0].label).toBe('Person');
                expect(result.edgeTables).toHaveLength(1);
                expect(result.edgeTables[0].table).toBe('friendships');
                expect(result.edgeTables[0].sourceKeyColumn).toBe('person1_id');
                expect(result.edgeTables[0].destKeyColumn).toBe('person2_id');
                expect(result.edgeTables[0].label).toBe('knows');
            }
        });

        it('parses DROP PROPERTY GRAPH', () => {
            const result = parsePgq('DROP PROPERTY GRAPH social')!;
            expect(result).not.toBeNull();
            expect(result.type).toBe('drop_property_graph');
            if (result.type === 'drop_property_graph') {
                expect(result.name).toBe('social');
                expect(result.ifExists).toBe(false);
            }
        });

        it('parses DROP PROPERTY GRAPH IF EXISTS', () => {
            const result = parsePgq('DROP PROPERTY GRAPH IF EXISTS social')!;
            expect(result.type).toBe('drop_property_graph');
            if (result.type === 'drop_property_graph') {
                expect(result.ifExists).toBe(true);
            }
        });

        it('detects GRAPH_TABLE in SELECT', () => {
            const result = parsePgq(`
                SELECT * FROM GRAPH_TABLE(social,
                    MATCH (a:Person)->(b:Person)
                    COLUMNS (a.name AS person1, b.name AS person2)
                )
            `)!;
            expect(result).not.toBeNull();
            expect(result.type).toBe('graph_table_rewrite');
            if (result.type === 'graph_table_rewrite') {
                expect(result.graphTableRefs).toHaveLength(1);
                expect(result.graphTableRefs[0].graphName).toBe('social');
            }
        });
    });
});
