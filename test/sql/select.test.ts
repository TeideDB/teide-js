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
            const result = ctx.executeSync('SELECT category, price FROM sales')!;
            expect(result.nRows).toBe(9);
            expect(result.columns).toEqual(['category', 'price']);
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
            // Verify actual aggregate values (electronics=50, clothing=220, food=470)
            const totals = Array.from(result.col('total_qty').data).sort((a, b) => a - b);
            expect(totals).toEqual([50, 220, 470]);
        });

        it('GROUP BY with AVG', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, AVG(price) as avg_price FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3);
            // Verify aggregate values: food~5.66, clothing~56.66, electronics~716.66
            const avgs = Array.from(result.col('avg_price').data).sort((a, b) => a - b);
            expect(avgs[0]).toBeCloseTo(5.66, 0);
            expect(avgs[2]).toBeCloseTo(716.66, 0);
        });

        it('GROUP BY with MIN and MAX', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, MIN(price) as min_p, MAX(price) as max_p FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3);
            // Verify: food min=3.99, clothing min=29.99, electronics min=449.99
            const mins = Array.from(result.col('min_p').data).sort((a, b) => a - b);
            expect(mins[0]).toBeCloseTo(3.99, 1);
            const maxes = Array.from(result.col('max_p').data).sort((a, b) => a - b);
            expect(maxes[2]).toBeCloseTo(999.99, 1);
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

    describe('expression-valued aggregates', () => {
        it('composite expression wrapping aggregate', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, SUM(price * quantity) + 1 AS adjusted FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3);
            expect(result.columns).toContain('adjusted');
        });

        it('multiple composite aggregates', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, COUNT(*) + 1 AS adj_count, SUM(price * quantity) + 10 AS adj_total FROM sales GROUP BY category'
            )!;
            expect(result.nRows).toBe(3);
            expect(result.columns).toEqual(['category', 'adj_count', 'adj_total']);
        });

        it('distinct expression-based aggregates are not collapsed', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            // SUM(price * quantity) and SUM(price + quantity) must produce different results
            const combined = ctx.executeSync(
                'SELECT category, SUM(price * quantity) + SUM(price + quantity) AS total FROM sales GROUP BY category ORDER BY category'
            )!;
            expect(combined.nRows).toBe(3);
            expect(combined.columns).toContain('total');
            // Verify the values are computed from two distinct sums, not the same one doubled
            const separate = ctx.executeSync(
                'SELECT category, SUM(price * quantity) AS s1, SUM(price + quantity) AS s2 FROM sales GROUP BY category ORDER BY category'
            )!;
            // Access via native col().data typed arrays
            const totalData = Array.from(combined.col('total').data as Float64Array);
            const s1Data = Array.from(separate.col('s1').data as Float64Array);
            const s2Data = Array.from(separate.col('s2').data as Float64Array);
            for (let i = 0; i < combined.nRows; i++) {
                expect(totalData[i]).toBeCloseTo(s1Data[i] + s2Data[i], 5);
            }
        });
    });

    describe('ORDER BY on aggregate aliases', () => {
        it('ORDER BY alias of SUM aggregate', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, SUM(quantity) AS total FROM sales GROUP BY category ORDER BY total DESC'
            )!;
            expect(result.nRows).toBe(3);
            expect(result.columns).toEqual(['category', 'total']);
        });

        it('ORDER BY alias of COUNT aggregate with LIMIT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT category, COUNT(*) AS cnt FROM sales GROUP BY category ORDER BY cnt DESC LIMIT 2'
            )!;
            expect(result.nRows).toBe(2);
            expect(result.columns).toEqual(['category', 'cnt']);
        });
    });

    describe('ORDER BY with aliased columns', () => {
        it('ORDER BY source column aliased in SELECT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            const result = ctx.executeSync(
                'SELECT UPPER(product) AS p, price AS cost FROM sales ORDER BY p, price'
            )!;
            expect(result.nRows).toBe(9);
            expect(result.columns).toEqual(['p', 'cost']);
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
