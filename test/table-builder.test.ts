import { describe, it, expect } from 'vitest';
import { Context, Table } from '../lib';

describe('Table construction', () => {
  it('fromArraysSync with number arrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        x: [1, 2, 3],
        y: [4.0, 5.0, 6.0],
      });
      expect(t.nRows).toBe(3);
      expect(t.nCols).toBe(2);
      expect(t.columns).toContain('x');
      expect(t.columns).toContain('y');
    } finally {
      ctx.destroy();
    }
  });

  it('fromArraysSync with TypedArrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        vals: new Float64Array([1.1, 2.2, 3.3]),
      });
      expect(t.nRows).toBe(3);
      const data = t.col('vals').data;
      expect(data[0]).toBeCloseTo(1.1);
    } finally {
      ctx.destroy();
    }
  });

  it('fromArraysSync with string arrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        names: ['alice', 'bob', 'charlie'],
      });
      expect(t.nRows).toBe(3);
      expect(t.col('names').dtype).toBe('sym');
    } finally {
      ctx.destroy();
    }
  });

  it('fromArraysSync with boolean arrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        flags: [true, false, true],
      });
      expect(t.nRows).toBe(3);
      expect(t.col('flags').dtype).toBe('bool');
    } finally {
      ctx.destroy();
    }
  });
});
