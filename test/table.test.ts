import { describe, it, expect } from 'vitest';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

describe('Table & Series', () => {
  it('reads CSV and accesses columns (sync)', () => {
    const ctx = new addon.NativeContext();
    try {
      const tbl = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      expect(tbl.nRows).toBe(3);
      expect(tbl.nCols).toBe(3);
      expect(tbl.columns).toEqual(['id', 'name', 'value']);

      const values = tbl.col('value');
      expect(values.dtype).toBe(7); // TD_F64 = 7
      expect(values.length).toBe(3);

      const data = values.data;
      expect(data).toBeInstanceOf(Float64Array);
      expect(data[0]).toBeCloseTo(10.5);
      expect(data[1]).toBeCloseTo(20.3);
      expect(data[2]).toBeCloseTo(30.1);
    } finally {
      ctx.destroy();
    }
  });

  it('reads CSV async and returns NativeTable', async () => {
    const ctx = new addon.NativeContext();
    try {
      const tbl = await ctx.readCsv(path.join(__dirname, 'fixtures', 'small.csv'));
      expect(tbl.nRows).toBe(3);
      expect(tbl.nCols).toBe(3);
    } finally {
      ctx.destroy();
    }
  });

  it('accesses symbol columns', () => {
    const ctx = new addon.NativeContext();
    try {
      const tbl = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      const names = tbl.col('name');
      expect(names.dtype).toBe(20); // TD_SYM = 20
      expect(names.indices).toBeInstanceOf(Uint8Array);
      const dict = names.dictionary;
      expect(dict).toContain('alpha');
      expect(dict).toContain('beta');
      expect(dict).toContain('gamma');
    } finally {
      ctx.destroy();
    }
  });

  it('throws on non-existent column', () => {
    const ctx = new addon.NativeContext();
    try {
      const tbl = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      expect(() => tbl.col('nonexistent')).toThrow('Column not found');
    } finally {
      ctx.destroy();
    }
  });
});
