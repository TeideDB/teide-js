import { describe, it, expect } from 'vitest';
import path from 'path';
import { Context, col } from '../lib';

const SALES = path.join(__dirname, 'fixtures', 'sales.csv');

describe('Extended aggregations', () => {
  it('countDistinct opcode wires through EmitExpr without crash', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      // Verify countDistinct goes through the binding layer without error.
      // Note: the C core (exec.c) does not yet implement OP_COUNT_DISTINCT
      // in the group executor, so the result value may not be correct.
      // This test validates the NAPI wiring, not the C core execution.
      const result = df.groupBy('category')
        .agg(col('product').countDistinct())
        .collectSync();
      expect(result.nRows).toBe(3);
      expect(result.columns).toContain('category');
    } finally {
      ctx.destroy();
    }
  });

  it('count aggregation in groupBy produces correct results', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.groupBy('category')
        .agg(col('product').count())
        .collectSync();
      expect(result.nRows).toBe(3);
      expect(result.columns).toContain('category');
      expect(result.columns).toContain('product_count');
      // Each category has 3 products, so count should be 3
      const series = result.col('product_count');
      expect(series.dtype).toBe('i64');
      const data = series.data as BigInt64Array;
      for (let i = 0; i < result.nRows; i++) {
        expect(data[i]).toBe(3n);
      }
    } finally {
      ctx.destroy();
    }
  });
});

describe('String unary ops', () => {
  it('strlen filters products by name length', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      // Filter products with name length > 4 (laptop, phone, tablet, shirt, pants, jacket, bread, cheese)
      const result = df.filter(col('product').strlen().gt(4)).collectSync();
      expect(result.nRows).toBeGreaterThan(0);
      // "milk" has length 4 so should be filtered out
      expect(result.nRows).toBeLessThan(9);
    } finally {
      ctx.destroy();
    }
  });
});
