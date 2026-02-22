import { describe, it, expect } from 'vitest';
import path from 'path';
import { Context, col } from '../lib';

const SMALL = path.join(__dirname, 'fixtures', 'small.csv');
const SALES = path.join(__dirname, 'fixtures', 'sales.csv');

describe('End-to-end integration', () => {
  it('filter + collectSync', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SMALL);
      const result = df.filter(col('value').gt(15)).collectSync();
      expect(result.nRows).toBe(2);
      const data = result.col('value').data;
      expect(data).toBeInstanceOf(Float64Array);
      expect(data[0]).toBeCloseTo(20.3);
      expect(data[1]).toBeCloseTo(30.1);
    } finally {
      ctx.destroy();
    }
  });

  it('async collect', async () => {
    const ctx = new Context();
    try {
      const df = await ctx.readCsv(SMALL);
      const result = await df.filter(col('value').gt(15)).collect();
      expect(result.nRows).toBe(2);
    } finally {
      ctx.destroy();
    }
  });

  it('symbol column access', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SMALL);
      const names = df.col('name');
      expect(names.dtype).toBe('sym');
      expect(names.indices).toBeInstanceOf(Uint8Array);
      const dict = names.dictionary;
      expect(dict).toContain('alpha');
      expect(dict).toContain('beta');
      expect(dict).toContain('gamma');
    } finally {
      ctx.destroy();
    }
  });

  it('head', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SMALL);
      const result = df.head(2).collectSync();
      expect(result.nRows).toBe(2);
    } finally {
      ctx.destroy();
    }
  });

  it('filter + head', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SMALL);
      const result = df.filter(col('value').gt(5)).head(1).collectSync();
      expect(result.nRows).toBe(1);
    } finally {
      ctx.destroy();
    }
  });

  it('sort ascending', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.sort('price').collectSync();
      const prices = result.col('price').data;
      expect(prices).toBeInstanceOf(Float64Array);
      expect(prices[0]).toBeCloseTo(3.99);
    } finally {
      ctx.destroy();
    }
  });

  it('sort descending', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.sort('price', { descending: true }).collectSync();
      const prices = result.col('price').data;
      expect(prices).toBeInstanceOf(Float64Array);
      expect(prices[0]).toBeCloseTo(999.99);
    } finally {
      ctx.destroy();
    }
  });
});
