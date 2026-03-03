import { describe, it, expect } from 'vitest';
import path from 'path';
import { Context, col } from '../lib';

const SALES = path.join(__dirname, 'fixtures', 'sales.csv');
const ORDERS = path.join(__dirname, 'fixtures', 'orders.csv');
const TRADES = path.join(__dirname, 'fixtures', 'trades.csv');
const QUOTES = path.join(__dirname, 'fixtures', 'quotes.csv');

describe('Extended query ops', () => {
  it('tail returns last N rows', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.tail(3).collectSync();
      expect(result.nRows).toBe(3);
    } finally {
      ctx.destroy();
    }
  });

  it('distinct deduplicates by column', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.distinct('category').collectSync();
      expect(result.nRows).toBe(3); // electronics, clothing, food
    } finally {
      ctx.destroy();
    }
  });

  it('select picks specific columns', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.select('category', 'price').collectSync();
      expect(result.nCols).toBe(2);
      expect(result.columns).toContain('category');
      expect(result.columns).toContain('price');
    } finally {
      ctx.destroy();
    }
  });

  it('project computes expressions', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.project(
        col('price').mul(col('quantity')).alias('revenue')
      ).collectSync();
      expect(result.columns).toContain('revenue');
      expect(result.nRows).toBe(9);
    } finally {
      ctx.destroy();
    }
  });

  it('window with rowNumber', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.window({
        partitionBy: ['category'],
        orderBy: [{ col: 'price', descending: true }],
        funcs: [{ kind: 'rowNumber' }],
      }).collectSync();
      expect(result.nRows).toBe(9);
      expect(result.nCols).toBeGreaterThan(4); // original cols + window col
    } finally {
      ctx.destroy();
    }
  });

  it('inner join on shared column', () => {
    const ctx = new Context();
    try {
      const sales = ctx.readCsvSync(SALES);
      const orders = ctx.readCsvSync(ORDERS);
      const result = sales.join(orders, { on: 'category' }).collectSync();
      expect(result.nRows).toBeGreaterThan(0);
      expect(result.columns).toContain('category');
    } finally {
      ctx.destroy();
    }
  });

  it('windowJoin (ASOF-style) between trades and quotes', () => {
    const ctx = new Context();
    try {
      const trades = ctx.readCsvSync(TRADES);
      const quotes = ctx.readCsvSync(QUOTES);

      // Verify the API exists and plumbing works.
      // The C core's td_window_join currently returns "not yet implemented",
      // so we verify the call reaches the C layer and throws the expected error.
      expect(typeof trades.windowJoin).toBe('function');

      const query = trades.windowJoin(quotes, {
        timeKey: 'time',
        symKey: 'sym',
        windowLo: -2,
        windowHi: 0,
        aggs: [col('bid').mean().alias('avg_bid')],
      });

      // The C core has td_window_join declared but not yet implemented.
      // Once implemented, this test should be updated to check results.
      try {
        const result = query.collectSync();
        // If the C core implements it, verify the result
        expect(result.nRows).toBeGreaterThan(0);
        expect(result.columns).toContain('avg_bid');
      } catch (err: any) {
        // Expected: C core returns "not yet implemented"
        expect(err.message).toContain('not yet implemented');
      }
    } finally {
      ctx.destroy();
    }
  });
});
