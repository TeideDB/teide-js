import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Context } from '../../lib/context';
import { cosineSimilarity, euclideanDistance, parseVector } from '../../lib/sql/vector';

describe('Vector Similarity', () => {
    let ctx: Context;

    beforeAll(() => {
        ctx = new Context();
        // Create a table with vector embeddings stored as JSON strings
        ctx.executeSync(`CREATE TABLE items (id FLOAT, name VARCHAR, embedding VARCHAR)`);
        ctx.executeSync(`INSERT INTO items VALUES (1, 'apple', '[1.0, 0.0, 0.0]')`);
        ctx.executeSync(`INSERT INTO items VALUES (2, 'banana', '[0.0, 1.0, 0.0]')`);
        ctx.executeSync(`INSERT INTO items VALUES (3, 'cherry', '[0.0, 0.0, 1.0]')`);
        ctx.executeSync(`INSERT INTO items VALUES (4, 'apricot', '[0.9, 0.1, 0.0]')`);
        ctx.executeSync(`INSERT INTO items VALUES (5, 'blueberry', '[0.1, 0.9, 0.1]')`);
    });

    afterAll(() => {
        ctx.destroy();
    });

    // ─── Unit tests for similarity functions ────────────────────────────────

    describe('cosineSimilarity', () => {
        it('should return 1 for identical vectors', () => {
            expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
        });

        it('should return 0 for orthogonal vectors', () => {
            expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
        });

        it('should return -1 for opposite vectors', () => {
            expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
        });

        it('should handle non-unit vectors', () => {
            const sim = cosineSimilarity([2, 0, 0], [3, 0, 0]);
            expect(sim).toBeCloseTo(1.0);
        });

        it('should throw on dimension mismatch', () => {
            expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow('dimension mismatch');
        });
    });

    describe('euclideanDistance', () => {
        it('should return 0 for identical vectors', () => {
            expect(euclideanDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0.0);
        });

        it('should compute correct distance', () => {
            expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5.0);
        });

        it('should throw on dimension mismatch', () => {
            expect(() => euclideanDistance([1, 0], [1, 0, 0])).toThrow('dimension mismatch');
        });
    });

    describe('parseVector', () => {
        it('should parse JSON array string', () => {
            expect(parseVector('[1.0, 2.0, 3.0]')).toEqual([1.0, 2.0, 3.0]);
        });

        it('should parse comma-separated string', () => {
            expect(parseVector('1.0, 2.0, 3.0')).toEqual([1.0, 2.0, 3.0]);
        });

        it('should parse actual array', () => {
            expect(parseVector([1, 2, 3])).toEqual([1, 2, 3]);
        });
    });

    // ─── SQL COSINE_SIMILARITY ──────────────────────────────────────────────

    describe('COSINE_SIMILARITY in SQL', () => {
        it('should compute cosine similarity in SELECT', () => {
            const result = ctx.executeSync(
                `SELECT name, COSINE_SIMILARITY(embedding, (1.0, 0.0, 0.0)) AS sim FROM items ORDER BY sim DESC LIMIT 3`
            )!;
            const names = [];
            const sims = [];
            for (let i = 0; i < result.nRows; i++) {
                names.push(result.col('name').dictionary[result.col('name').indices[i]]);
                sims.push(Number(result.col('sim').data[i]));
            }
            // apple [1,0,0] should be most similar to [1,0,0]
            expect(names[0]).toBe('apple');
            expect(sims[0]).toBeCloseTo(1.0, 2);
            // apricot [0.9,0.1,0] should be second
            expect(names[1]).toBe('apricot');
            expect(sims[1]).toBeGreaterThan(0.9);
        });

        it('should handle all items', () => {
            const result = ctx.executeSync(
                `SELECT name, COSINE_SIMILARITY(embedding, (0.0, 1.0, 0.0)) AS sim FROM items`
            )!;
            expect(result.nRows).toBe(5);
        });
    });

    // ─── SQL EUCLIDEAN_DISTANCE ─────────────────────────────────────────────

    describe('EUCLIDEAN_DISTANCE in SQL', () => {
        it('should compute euclidean distance in SELECT', () => {
            const result = ctx.executeSync(
                `SELECT name, EUCLIDEAN_DISTANCE(embedding, (1.0, 0.0, 0.0)) AS dist FROM items ORDER BY dist LIMIT 2`
            )!;
            const names = [];
            const dists = [];
            for (let i = 0; i < result.nRows; i++) {
                names.push(result.col('name').dictionary[result.col('name').indices[i]]);
                dists.push(Number(result.col('dist').data[i]));
            }
            // apple [1,0,0] should have distance 0
            expect(names[0]).toBe('apple');
            expect(dists[0]).toBeCloseTo(0.0, 2);
            // apricot [0.9,0.1,0] should be second closest
            expect(names[1]).toBe('apricot');
        });
    });

    // ─── KNN fast-path ──────────────────────────────────────────────────────

    describe('KNN fast-path', () => {
        it('should detect and execute KNN with cosine similarity', () => {
            const result = ctx.executeSync(
                `SELECT name, COSINE_SIMILARITY(embedding, (1.0, 0.0, 0.0)) AS sim FROM items ORDER BY sim DESC LIMIT 2`
            )!;
            expect(result.nRows).toBe(2);
            const name0 = result.col('name').dictionary[result.col('name').indices[0]];
            expect(name0).toBe('apple');
        });

        it('should detect and execute KNN with euclidean distance', () => {
            const result = ctx.executeSync(
                `SELECT name, EUCLIDEAN_DISTANCE(embedding, (0.0, 0.0, 1.0)) AS dist FROM items ORDER BY dist ASC LIMIT 2`
            )!;
            expect(result.nRows).toBe(2);
            const name0 = result.col('name').dictionary[result.col('name').indices[0]];
            expect(name0).toBe('cherry');
        });

        it('should return correct k results', () => {
            const result = ctx.executeSync(
                `SELECT name FROM items ORDER BY COSINE_SIMILARITY(embedding, (0.5, 0.5, 0.0)) DESC LIMIT 3`
            )!;
            expect(result.nRows).toBe(3);
        });
    });

    // ─── HNSW Index ─────────────────────────────────────────────────────────

    describe('HNSW Index', () => {
        it('should create and use HNSW index', () => {
            ctx.executeSync(`CREATE VECTOR INDEX items_emb_idx ON items(embedding) USING HNSW(4, 50)`);

            // Query should use the index (result should be same as brute force)
            const result = ctx.executeSync(
                `SELECT name, COSINE_SIMILARITY(embedding, (1.0, 0.0, 0.0)) AS sim FROM items ORDER BY sim DESC LIMIT 2`
            )!;
            expect(result.nRows).toBe(2);
            const name0 = result.col('name').dictionary[result.col('name').indices[0]];
            expect(name0).toBe('apple');
        });

        it('should drop HNSW index', () => {
            // Create the index first so this test is independent
            try { ctx.executeSync(`DROP VECTOR INDEX IF EXISTS items_emb_idx`); } catch {}
            ctx.executeSync(`CREATE VECTOR INDEX items_emb_idx ON items(embedding) USING HNSW(4, 50)`);
            ctx.executeSync(`DROP VECTOR INDEX items_emb_idx`);
            // Should still work without index (brute force)
            const result = ctx.executeSync(
                `SELECT name FROM items ORDER BY COSINE_SIMILARITY(embedding, (1.0, 0.0, 0.0)) DESC LIMIT 1`
            )!;
            expect(result.nRows).toBe(1);
        });

        it('should error on dropping non-existent index', () => {
            expect(() => ctx.executeSync(`DROP VECTOR INDEX nonexistent`)).toThrow('not found');
        });

        it('should handle DROP IF EXISTS for non-existent index', () => {
            expect(() => ctx.executeSync(`DROP VECTOR INDEX IF EXISTS nonexistent`)).not.toThrow();
        });

        it('should error on duplicate index creation', () => {
            ctx.executeSync(`CREATE VECTOR INDEX dup_idx ON items(embedding)`);
            expect(() => ctx.executeSync(`CREATE VECTOR INDEX dup_idx ON items(embedding)`)).toThrow('already exists');
            ctx.executeSync(`DROP VECTOR INDEX dup_idx`);
        });
    });

    // ─── Auto-invalidation on mutation ──────────────────────────────────────

    describe('Auto-invalidation', () => {
        it('should invalidate vector index on INSERT', () => {
            // Create fresh table and index
            ctx.executeSync(`CREATE TABLE vec_test (id FLOAT, vec VARCHAR)`);
            ctx.executeSync(`INSERT INTO vec_test VALUES (1, '[1.0, 0.0]')`);
            ctx.executeSync(`INSERT INTO vec_test VALUES (2, '[0.0, 1.0]')`);
            ctx.executeSync(`CREATE VECTOR INDEX vt_idx ON vec_test(vec)`);

            // Mutate the table
            ctx.executeSync(`INSERT INTO vec_test VALUES (3, '[0.5, 0.5]')`);

            // Index should be invalidated - KNN should still work (falls back to brute force)
            const result = ctx.executeSync(
                `SELECT id FROM vec_test ORDER BY COSINE_SIMILARITY(vec, (1.0, 0.0)) DESC LIMIT 2`
            )!;
            expect(result.nRows).toBe(2);
        });

        it('should invalidate vector index on UPDATE', () => {
            ctx.executeSync(`CREATE TABLE vec_upd (id FLOAT, vec VARCHAR)`);
            ctx.executeSync(`INSERT INTO vec_upd VALUES (1, '[1.0, 0.0]')`);
            ctx.executeSync(`CREATE VECTOR INDEX vu_idx ON vec_upd(vec)`);
            ctx.executeSync(`UPDATE vec_upd SET vec = '[0.0, 1.0]' WHERE id = 1`);

            // Should fall back to brute force after invalidation
            const result = ctx.executeSync(
                `SELECT id FROM vec_upd ORDER BY COSINE_SIMILARITY(vec, (0.0, 1.0)) DESC LIMIT 1`
            )!;
            expect(result.nRows).toBe(1);
        });

        it('should invalidate vector index on DELETE', () => {
            ctx.executeSync(`CREATE TABLE vec_del (id FLOAT, vec VARCHAR)`);
            ctx.executeSync(`INSERT INTO vec_del VALUES (1, '[1.0, 0.0]')`);
            ctx.executeSync(`INSERT INTO vec_del VALUES (2, '[0.0, 1.0]')`);
            ctx.executeSync(`CREATE VECTOR INDEX vd_idx ON vec_del(vec)`);
            ctx.executeSync(`DELETE FROM vec_del WHERE id = 2`);

            const result = ctx.executeSync(
                `SELECT id FROM vec_del ORDER BY COSINE_SIMILARITY(vec, (1.0, 0.0)) DESC LIMIT 1`
            )!;
            expect(result.nRows).toBe(1);
        });
    });
});
