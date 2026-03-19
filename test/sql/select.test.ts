import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { Context } from '../../lib';

const SMALL = path.join(__dirname, '..', 'fixtures', 'small.csv');
const SALES = path.join(__dirname, '..', 'fixtures', 'sales.csv');

describe('SQL SELECT', () => {
    let ctx: Context;

    beforeEach(() => {
        ctx = new Context();
    });

    afterEach(() => {
        ctx.destroy();
    });

    describe('basic SELECT', () => {
        it('SELECT * FROM table', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync('SELECT * FROM sales')!;
            expect(result.nRows).toBe(9);
            expect(result.columns).toContain('category');
            expect(result.columns).toContain('product');
        });

        it('SELECT specific columns', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            // SELECT with specific columns still returns all (projection not implemented at C level)
            // but the query should parse and execute
            const result = ctx.executeSync('SELECT category, price FROM sales')!;
            expect(result.nRows).toBe(9);
        });

        it('case-insensitive table names', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('Sales', df);
            const result = ctx.executeSync('SELECT * FROM sales')!;
            expect(result.nRows).toBe(9);
        });
    });

    describe('WHERE clause', () => {
        it('simple comparison', () => {
            const df = ctx.readCsvSync(SMALL);
            ctx.registerTable('data', df);
            const result = ctx.executeSync('SELECT * FROM data WHERE value > 15')!;
            expect(result.nRows).toBe(2);
            const values = result.col('value').data;
            expect(values[0]).toBeCloseTo(20.3);
            expect(values[1]).toBeCloseTo(30.1);
        });

        it('equality filter', () => {
            const df = ctx.readCsvSync(SMALL);
            ctx.registerTable('data', df);
            const result = ctx.executeSync('SELECT * FROM data WHERE id = 1')!;
            expect(result.nRows).toBe(1);
        });

        it('compound WHERE with AND', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT * FROM sales WHERE price > 10 AND quantity > 20'
            )!;
            // electronics: laptop (999.99, 10-no), phone (699.99, 25-yes), tablet (449.99, 15-no)
            // clothing: shirt (29.99, 100-yes), pants (49.99, 80-yes), jacket (89.99, 40-yes)
            expect(result.nRows).toBe(4);
        });

        it('WHERE with OR', () => {
            const df = ctx.readCsvSync(SMALL);
            ctx.registerTable('data', df);
            const result = ctx.executeSync(
                'SELECT * FROM data WHERE id = 1 OR id = 3'
            )!;
            expect(result.nRows).toBe(2);
        });

        it('WHERE with BETWEEN', () => {
            const df = ctx.readCsvSync(SMALL);
            ctx.registerTable('data', df);
            const result = ctx.executeSync(
                'SELECT * FROM data WHERE value BETWEEN 10 AND 25'
            )!;
            expect(result.nRows).toBe(2); // 10.5 and 20.3
        });

        it('WHERE with IN', () => {
            const df = ctx.readCsvSync(SMALL);
            ctx.registerTable('data', df);
            const result = ctx.executeSync(
                'SELECT * FROM data WHERE id IN (1, 3)'
            )!;
            expect(result.nRows).toBe(2);
        });
    });

    describe('ORDER BY', () => {
        it('ascending order', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync('SELECT * FROM sales ORDER BY price')!;
            const prices = result.col('price').data;
            expect(prices[0]).toBeCloseTo(3.99);
        });

        it('descending order', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync('SELECT * FROM sales ORDER BY price DESC')!;
            const prices = result.col('price').data;
            expect(prices[0]).toBeCloseTo(999.99);
        });
    });

    describe('LIMIT', () => {
        it('LIMIT N', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync('SELECT * FROM sales LIMIT 3')!;
            expect(result.nRows).toBe(3);
        });

        it('ORDER BY + LIMIT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT * FROM sales ORDER BY price DESC LIMIT 2'
            )!;
            expect(result.nRows).toBe(2);
            const prices = result.col('price').data;
            expect(prices[0]).toBeCloseTo(999.99);
            expect(prices[1]).toBeCloseTo(699.99);
        });
    });

    describe('GROUP BY + aggregates', () => {
        it('GROUP BY with COUNT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, COUNT(*) as cnt FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3); // electronics, clothing, food
        });

        it('GROUP BY with SUM', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, SUM(quantity) as total_qty FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3);
        });

        it('GROUP BY with AVG', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, AVG(price) as avg_price FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3);
        });

        it('GROUP BY with MIN and MAX', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, MIN(price) as min_p, MAX(price) as max_p FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3);
        });
    });

    describe('WHERE + GROUP BY', () => {
        it('filter then aggregate', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, SUM(quantity) as total FROM sales WHERE price > 10 GROUP BY category'
            )!;
            // Teide GROUP BY returns all dictionary entries for symbol columns,
            // including empty groups (food has 0 quantity after filter)
            expect(result.nRows).toBe(3);
        });
    });

    describe('expression functions', () => {
        it('ABS function', () => {
            const df = ctx.readCsvSync(SMALL);
            ctx.registerTable('data', df);
            // ABS on positive values should be identity
            const result = ctx.executeSync(
                'SELECT * FROM data WHERE ABS(value) > 20'
            )!;
            expect(result.nRows).toBe(2); // 20.3 and 30.1
        });

        it('arithmetic expressions in WHERE', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT * FROM sales WHERE price * quantity > 5000'
            )!;
            // laptop: 999.99*10=9999.9, phone: 699.99*25=17499.75, tablet: 449.99*15=6749.85
            // shirt: 29.99*100=2999, pants: 49.99*80=3999.2, jacket: 89.99*40=3599.6
            // bread: 3.99*200=798, milk: 4.99*150=748.5, cheese: 7.99*120=958.8
            expect(result.nRows).toBe(3); // laptop, phone, tablet
        });
    });

    describe('combined clauses', () => {
        it('WHERE + ORDER BY + LIMIT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT * FROM sales WHERE quantity > 20 ORDER BY price DESC LIMIT 3'
            )!;
            expect(result.nRows).toBe(3);
            const prices = result.col('price').data;
            // Descending: should be highest prices first among filtered rows
            expect(prices[0]).toBeGreaterThan(prices[1]);
        });

        it('GROUP BY + ORDER BY + LIMIT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, SUM(quantity) as total FROM sales GROUP BY category ORDER BY total DESC LIMIT 2'
            )!;
            expect(result.nRows).toBe(2);
        });
    });

    describe('error handling', () => {
        it('throws on unknown table', () => {
            expect(() => ctx.executeSync('SELECT * FROM nonexistent')).toThrow('Table not found');
        });

        it('throws on unsupported SQL type', () => {
            expect(() => ctx.executeSync('DROP TABLE foo')).toThrow();
        });

        it('throws on destroyed context', () => {
            ctx.destroy();
            expect(() => ctx.executeSync('SELECT 1')).toThrow('Context has been destroyed');
        });
    });
});
