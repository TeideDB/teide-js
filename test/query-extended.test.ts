import { describe, it, expect } from 'vitest';
import path from 'path';
import { Context, col } from '../lib';

const SALES = path.join(__dirname, 'fixtures', 'sales.csv');

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
});
