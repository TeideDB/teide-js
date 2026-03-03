import { describe, it, expect } from 'vitest';
import { Context, Vector } from '../lib';

describe('Vector API', () => {
  it('creates and appends to a vector', () => {
    const ctx = new Context();
    try {
      let v = Vector.newSync(ctx, 'f64', 10);
      v = v.append(1.5);
      v = v.append(2.5);
      expect(v.length).toBe(2);
      expect(v.get(0)).toBeCloseTo(1.5);
    } finally {
      ctx.destroy();
    }
  });

  it('creates from raw TypedArray', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3]));
      expect(v.length).toBe(3);
    } finally {
      ctx.destroy();
    }
  });

  it('slice and concat', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3, 4, 5]));
      const s = v.slice(1, 3);
      expect(s.length).toBe(3);
      const v2 = Vector.fromRawSync(ctx, 'f64', new Float64Array([6, 7]));
      const merged = v.concat(v2);
      expect(merged.length).toBe(7);
    } finally {
      ctx.destroy();
    }
  });

  it('null handling', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3]));
      v.setNull(1, true);
      expect(v.isNull(1)).toBe(true);
      expect(v.isNull(0)).toBe(false);
    } finally {
      ctx.destroy();
    }
  });
});
