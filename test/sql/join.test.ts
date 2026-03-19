import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { Context } from '../../lib';

const ORDERS = path.join(__dirname, '..', 'fixtures', 'orders.csv');
const CUSTOMERS = path.join(__dirname, '..', 'fixtures', 'customers.csv');
const SMALL = path.join(__dirname, '..', 'fixtures', 'small.csv');
const SALES = path.join(__dirname, '..', 'fixtures', 'sales.csv');

describe('SQL JOINs', () => {
    let ctx: Context;

    beforeEach(() => {
        ctx = new Context();
        ctx.registerTable('orders', ctx.readCsvSync(ORDERS));
        ctx.registerTable('customers', ctx.readCsvSync(CUSTOMERS));
    });

    afterEach(() => {
        ctx.destroy();
    });

    describe('INNER JOIN', () => {
        it('joins matching rows', () => {
            const result = ctx.executeSync(
                'SELECT o.order_id, o.amount, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.id'
            )!;
            // Orders 1,2,3,4,5 match customers 1,2,3; order 6 (customer_id=4) has no match
            expect(result.nRows).toBe(5);
        });

        it('filters with WHERE after join', () => {
            const result = ctx.executeSync(
                'SELECT o.order_id, o.amount, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.id WHERE o.amount > 70'
            )!;
            // amounts > 70: 100 (order 1), 75.5 (order 3), 200 (order 4) = 3 rows
            expect(result.nRows).toBe(3);
        });

        it('supports ORDER BY on joined result', () => {
            const result = ctx.executeSync(
                'SELECT o.order_id, o.amount FROM orders o INNER JOIN customers c ON o.customer_id = c.id ORDER BY o.amount DESC LIMIT 2'
            )!;
            expect(result.nRows).toBe(2);
            const amounts = result.col('amount').data;
            expect(amounts[0]).toBeCloseTo(200.0);
            expect(amounts[1]).toBeCloseTo(100.0);
        });
    });

    describe('LEFT JOIN', () => {
        it('includes unmatched left rows', () => {
            const result = ctx.executeSync(
                'SELECT o.order_id, o.amount FROM orders o LEFT JOIN customers c ON o.customer_id = c.id'
            )!;
            // All 6 orders should appear (order 6 has no matching customer)
            expect(result.nRows).toBe(6);
        });
    });

    describe('CROSS JOIN', () => {
        it('produces cartesian product', () => {
            const result = ctx.executeSync(
                'SELECT * FROM orders CROSS JOIN customers'
            )!;
            // 6 orders * 3 customers = 18 rows
            expect(result.nRows).toBe(18);
        });
    });
});

describe('SQL Subqueries', () => {
    let ctx: Context;

    beforeEach(() => {
        ctx = new Context();
        ctx.registerTable('orders', ctx.readCsvSync(ORDERS));
        ctx.registerTable('customers', ctx.readCsvSync(CUSTOMERS));
        ctx.registerTable('data', ctx.readCsvSync(SMALL));
    });

    afterEach(() => {
        ctx.destroy();
    });

    describe('IN subquery', () => {
        it('filters using subquery results', () => {
            const result = ctx.executeSync(
                "SELECT * FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE city = 'NYC')"
            )!;
            // NYC customers: Alice (id=1), Charlie (id=3)
            // Orders with customer_id 1: orders 1,3; customer_id 3: order 4 → 3 rows
            expect(result.nRows).toBe(3);
        });

        it('NOT IN subquery', () => {
            const result = ctx.executeSync(
                "SELECT * FROM orders WHERE customer_id NOT IN (SELECT id FROM customers WHERE city = 'NYC')"
            )!;
            // Non-NYC customer IDs that appear in orders: 2 (Bob, LA), 4 (no match in customers)
            // Orders with customer_id 2: orders 2,5; customer_id 4: order 6 → 3 rows
            expect(result.nRows).toBe(3);
        });
    });

    describe('FROM subquery', () => {
        it('executes subquery as table source', () => {
            const result = ctx.executeSync(
                'SELECT * FROM (SELECT * FROM data WHERE id > 1) sub'
            )!;
            // data has ids 1,2,3; id > 1 means 2,3 → 2 rows
            expect(result.nRows).toBe(2);
        });
    });
});

describe('SQL Set Operations', () => {
    let ctx: Context;

    beforeEach(() => {
        ctx = new Context();
        ctx.registerTable('data', ctx.readCsvSync(SMALL));
        ctx.registerTable('sales', ctx.readCsvSync(SALES));
    });

    afterEach(() => {
        ctx.destroy();
    });

    describe('UNION ALL', () => {
        it('combines all rows including duplicates', () => {
            const result = ctx.executeSync(
                'SELECT id FROM data UNION ALL SELECT id FROM data'
            )!;
            // 3 + 3 = 6 rows
            expect(result.nRows).toBe(6);
        });
    });

    describe('UNION', () => {
        it('combines rows with deduplication', () => {
            const result = ctx.executeSync(
                'SELECT id FROM data UNION SELECT id FROM data'
            )!;
            // 3 unique ids
            expect(result.nRows).toBe(3);
        });
    });

    describe('EXCEPT', () => {
        it('returns rows in left but not right', () => {
            const result = ctx.executeSync(
                'SELECT id FROM data EXCEPT SELECT id FROM data WHERE id = 1'
            )!;
            // data ids: 1,2,3; right: 1 → result: 2,3
            expect(result.nRows).toBe(2);
        });
    });

    describe('INTERSECT', () => {
        it('returns common rows', () => {
            const result = ctx.executeSync(
                'SELECT id FROM data INTERSECT SELECT id FROM data WHERE id > 1'
            )!;
            // left: 1,2,3; right: 2,3 → intersection: 2,3
            expect(result.nRows).toBe(2);
        });
    });
});

describe('SQL Window Functions', () => {
    let ctx: Context;

    beforeEach(() => {
        ctx = new Context();
        ctx.registerTable('data', ctx.readCsvSync(SMALL));
        ctx.registerTable('sales', ctx.readCsvSync(SALES));
    });

    afterEach(() => {
        ctx.destroy();
    });

    describe('ROW_NUMBER', () => {
        it('assigns sequential numbers', () => {
            const result = ctx.executeSync(
                'SELECT id, ROW_NUMBER() OVER (ORDER BY id) as rn FROM data'
            )!;
            expect(result.nRows).toBe(3);
            const rn = result.col('rn').data;
            // Should be 1, 2, 3 (ordered by id)
            expect(rn[0]).toBe(1);
            expect(rn[1]).toBe(2);
            expect(rn[2]).toBe(3);
        });
    });

    describe('RANK', () => {
        it('assigns ranks with gaps for ties', () => {
            const result = ctx.executeSync(
                'SELECT quantity, RANK() OVER (ORDER BY quantity) as rnk FROM sales'
            )!;
            expect(result.nRows).toBe(9);
            const rnk = result.col('rnk').data;
            // All quantities are unique so ranks = 1..9
            // Sorted by quantity: 10,15,25,40,80,100,120,150,200
            // Since the rows maintain their original order but ranks are computed
            // based on sorted position, each row gets a unique rank
            const sortedRanks = Array.from(rnk).sort((a, b) => a - b);
            expect(sortedRanks[0]).toBe(1);
            expect(sortedRanks[8]).toBe(9);
        });
    });

    describe('DENSE_RANK', () => {
        it('assigns dense ranks without gaps', () => {
            const result = ctx.executeSync(
                'SELECT quantity, DENSE_RANK() OVER (ORDER BY quantity) as drnk FROM sales'
            )!;
            expect(result.nRows).toBe(9);
            const drnk = result.col('drnk').data;
            // All unique quantities → dense_rank same as rank
            const sortedRanks = Array.from(drnk).sort((a, b) => a - b);
            expect(sortedRanks[0]).toBe(1);
            expect(sortedRanks[8]).toBe(9);
        });
    });

    describe('NTILE', () => {
        it('distributes rows into buckets', () => {
            const result = ctx.executeSync(
                'SELECT id, NTILE(2) OVER (ORDER BY id) as bucket FROM data'
            )!;
            expect(result.nRows).toBe(3);
            const buckets = result.col('bucket').data;
            // 3 rows into 2 buckets: [1,1,2] or [1,2,2]
            const uniqueBuckets = new Set(Array.from(buckets));
            expect(uniqueBuckets.size).toBe(2);
        });
    });

    describe('window with PARTITION BY', () => {
        it('computes row numbers within partitions', () => {
            const result = ctx.executeSync(
                'SELECT price, ROW_NUMBER() OVER (PARTITION BY category ORDER BY price) as rn FROM sales'
            )!;
            expect(result.nRows).toBe(9);
            const rn = result.col('rn').data;
            // Each category has 3 items, so row numbers within each partition are 1,2,3
            const rnArray = Array.from(rn);
            // Count how many times each rank appears
            const rankCounts = new Map<number, number>();
            for (const r of rnArray) {
                rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
            }
            // With 3 categories of 3 items each, we expect: rank 1 appears 3 times, rank 2 appears 3 times, rank 3 appears 3 times
            expect(rankCounts.get(1)).toBe(3);
            expect(rankCounts.get(2)).toBe(3);
            expect(rankCounts.get(3)).toBe(3);
        });
    });
});
