import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { Context } from '../../lib';

const SALES = path.join(__dirname, '..', 'fixtures', 'sales.csv');

describe('SQL DDL & DML', () => {
    let ctx: Context;

    beforeEach(() => {
        ctx = new Context();
    });

    afterEach(() => {
        ctx.destroy();
    });

    // ─── CREATE TABLE ───────────────────────────────────────────────────

    describe('CREATE TABLE', () => {
        it('creates a table with schema definition', () => {
            ctx.executeSync('CREATE TABLE users (id INT, name VARCHAR(100), age INT)');
            const result = ctx.executeSync('SELECT * FROM users')!;
            expect(result.nRows).toBe(0);
            expect(result.columns).toContain('id');
            expect(result.columns).toContain('name');
            expect(result.columns).toContain('age');
        });

        it('CREATE TABLE IF NOT EXISTS skips when table exists', () => {
            ctx.executeSync('CREATE TABLE t1 (id INT)');
            // Should not throw
            ctx.executeSync('CREATE TABLE IF NOT EXISTS t1 (id INT, extra INT)');
            const result = ctx.executeSync('SELECT * FROM t1')!;
            // Original schema preserved (no extra column)
            expect(result.columns).toContain('id');
        });

        it('CREATE TABLE throws when table already exists', () => {
            ctx.executeSync('CREATE TABLE t1 (id INT)');
            expect(() => ctx.executeSync('CREATE TABLE t1 (id INT)')).toThrow('already exists');
        });

        it('CREATE TABLE AS SELECT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            ctx.executeSync('CREATE TABLE expensive AS SELECT * FROM sales WHERE price > 100');
            const result = ctx.executeSync('SELECT * FROM expensive')!;
            // electronics items: laptop(999.99), phone(699.99), tablet(449.99) are > 100
            expect(result.nRows).toBe(3);
        });
    });

    // ─── DROP TABLE ─────────────────────────────────────────────────────

    describe('DROP TABLE', () => {
        it('drops an existing table', () => {
            ctx.executeSync('CREATE TABLE t1 (id INT)');
            ctx.executeSync('DROP TABLE t1');
            expect(() => ctx.executeSync('SELECT * FROM t1')).toThrow('not found');
        });

        it('DROP TABLE IF EXISTS does not throw for missing table', () => {
            // Should not throw
            ctx.executeSync('DROP TABLE IF EXISTS nonexistent');
        });

        it('DROP TABLE throws for missing table', () => {
            expect(() => ctx.executeSync('DROP TABLE nonexistent')).toThrow('not found');
        });
    });

    // ─── INSERT INTO ────────────────────────────────────────────────────

    describe('INSERT INTO', () => {
        it('INSERT INTO ... VALUES with all columns', () => {
            ctx.executeSync('CREATE TABLE users (id INT, name VARCHAR(50), age INT)');
            ctx.executeSync("INSERT INTO users (id, name, age) VALUES (1, 'Alice', 30)");
            const result = ctx.executeSync('SELECT * FROM users')!;
            expect(result.nRows).toBe(1);
            expect(result.col('name').dictionary).toContain('Alice');
        });

        it('INSERT INTO ... VALUES with multiple rows', () => {
            ctx.executeSync('CREATE TABLE users (id INT, name VARCHAR(50), age INT)');
            ctx.executeSync(
                "INSERT INTO users (id, name, age) VALUES (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Charlie', 35)"
            );
            const result = ctx.executeSync('SELECT * FROM users')!;
            expect(result.nRows).toBe(3);
        });

        it('INSERT INTO accumulates rows', () => {
            ctx.executeSync('CREATE TABLE users (id INT, name VARCHAR(50), age INT)');
            ctx.executeSync("INSERT INTO users (id, name, age) VALUES (1, 'Alice', 30)");
            ctx.executeSync("INSERT INTO users (id, name, age) VALUES (2, 'Bob', 25)");
            const result = ctx.executeSync('SELECT * FROM users')!;
            expect(result.nRows).toBe(2);
        });

        it('INSERT INTO ... SELECT', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            ctx.executeSync('CREATE TABLE copy (category VARCHAR(50), product VARCHAR(50), price FLOAT, quantity INT)');
            ctx.executeSync('INSERT INTO copy SELECT * FROM sales');
            const result = ctx.executeSync('SELECT * FROM copy')!;
            expect(result.nRows).toBe(9);
        });
    });

    // ─── UPDATE ─────────────────────────────────────────────────────────

    describe('UPDATE', () => {
        it('UPDATE with WHERE clause', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            ctx.executeSync("UPDATE sales SET price = 999 WHERE product = 'laptop'");
            const result = ctx.executeSync('SELECT * FROM sales')!;
            expect(result.nRows).toBe(9);
            // Verify the price was updated for laptop
            const prices = result.col('price').data;
            const products = result.col('product');
            const dict = products.dictionary;
            const indices = products.indices;
            for (let i = 0; i < result.nRows; i++) {
                if (dict[indices[i]] === 'laptop') {
                    expect(Number(prices[i])).toBe(999);
                }
            }
        });

        it('UPDATE all rows (no WHERE)', () => {
            ctx.executeSync('CREATE TABLE scores (name VARCHAR(50), score INT)');
            ctx.executeSync("INSERT INTO scores (name, score) VALUES ('Alice', 80), ('Bob', 90)");
            ctx.executeSync('UPDATE scores SET score = 100');
            const result = ctx.executeSync('SELECT * FROM scores')!;
            const scores = result.col('score').data;
            for (let i = 0; i < result.nRows; i++) {
                expect(Number(scores[i])).toBe(100);
            }
        });

        it('UPDATE with expression in SET', () => {
            ctx.executeSync('CREATE TABLE items (name VARCHAR(50), price INT)');
            ctx.executeSync("INSERT INTO items (name, price) VALUES ('a', 10), ('b', 20)");
            ctx.executeSync('UPDATE items SET price = price * 2');
            const result = ctx.executeSync('SELECT * FROM items')!;
            const prices = result.col('price').data;
            expect(Number(prices[0])).toBe(20);
            expect(Number(prices[1])).toBe(40);
        });

        it('UPDATE with comparison WHERE', () => {
            ctx.executeSync('CREATE TABLE items (name VARCHAR(50), price INT)');
            ctx.executeSync("INSERT INTO items (name, price) VALUES ('a', 10), ('b', 20), ('c', 30)");
            ctx.executeSync('UPDATE items SET price = 0 WHERE price > 15');
            const result = ctx.executeSync('SELECT * FROM items')!;
            const prices = result.col('price').data;
            expect(Number(prices[0])).toBe(10); // unchanged
            expect(Number(prices[1])).toBe(0);  // was 20
            expect(Number(prices[2])).toBe(0);  // was 30
        });
    });

    // ─── DELETE ──────────────────────────────────────────────────────────

    describe('DELETE', () => {
        it('DELETE with WHERE clause', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            ctx.executeSync('DELETE FROM sales WHERE price < 10');
            const result = ctx.executeSync('SELECT * FROM sales')!;
            // Removes food items: bread(3.99), milk(4.99), cheese(7.99)
            expect(result.nRows).toBe(6);
        });

        it('DELETE all rows (no WHERE)', () => {
            ctx.executeSync('CREATE TABLE t1 (id INT)');
            ctx.executeSync("INSERT INTO t1 (id) VALUES (1), (2), (3)");
            ctx.executeSync('DELETE FROM t1');
            const result = ctx.executeSync('SELECT * FROM t1')!;
            expect(result.nRows).toBe(0);
        });

        it('DELETE with string comparison', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            ctx.executeSync("DELETE FROM sales WHERE category = 'food'");
            const result = ctx.executeSync('SELECT * FROM sales')!;
            // 9 total - 3 food = 6
            expect(result.nRows).toBe(6);
        });

        it('DELETE with AND condition', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);
            ctx.executeSync("DELETE FROM sales WHERE category = 'electronics' AND price > 500");
            const result = ctx.executeSync('SELECT * FROM sales')!;
            // Removes laptop(999.99) and phone(699.99) = 2 removed, 7 remaining
            expect(result.nRows).toBe(7);
        });
    });

    // ─── Combined DDL/DML workflows ─────────────────────────────────────

    describe('combined workflows', () => {
        it('create, insert, query, update, delete cycle', () => {
            ctx.executeSync('CREATE TABLE employees (name VARCHAR(100), salary INT, dept VARCHAR(50))');
            ctx.executeSync(
                "INSERT INTO employees (name, salary, dept) VALUES ('Alice', 80000, 'eng'), ('Bob', 90000, 'eng'), ('Charlie', 70000, 'sales')"
            );

            // Query
            let result = ctx.executeSync('SELECT * FROM employees')!;
            expect(result.nRows).toBe(3);

            // Update
            ctx.executeSync("UPDATE employees SET salary = 85000 WHERE name = 'Alice'");
            result = ctx.executeSync('SELECT * FROM employees')!;
            expect(result.nRows).toBe(3);

            // Delete
            ctx.executeSync("DELETE FROM employees WHERE dept = 'sales'");
            result = ctx.executeSync('SELECT * FROM employees')!;
            expect(result.nRows).toBe(2);

            // Drop
            ctx.executeSync('DROP TABLE employees');
            expect(() => ctx.executeSync('SELECT * FROM employees')).toThrow('not found');
        });

        it('CTAS followed by DML', () => {
            const df = ctx.readCsvSync(SALES);
            ctx.registerTable('sales', df);

            // Create a subset table
            ctx.executeSync('CREATE TABLE electronics AS SELECT * FROM sales WHERE price > 100');
            const result = ctx.executeSync('SELECT * FROM electronics')!;
            expect(result.nRows).toBe(3);

            // Insert more data
            ctx.executeSync("INSERT INTO electronics (category, product, price, quantity) VALUES ('electronics', 'monitor', 399.99, 20)");
            const result2 = ctx.executeSync('SELECT * FROM electronics')!;
            expect(result2.nRows).toBe(4);
        });
    });
});
