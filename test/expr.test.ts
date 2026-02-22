import { describe, it, expect } from 'vitest';
import { col, lit, Expr } from '../lib/expr';

describe('Expr tree', () => {
  it('builds column reference', () => {
    const e = col('price');
    expect(e.kind).toBe('col');
    expect(e.params.name).toBe('price');
  });

  it('builds literal', () => {
    const e = lit(42);
    expect(e.kind).toBe('lit');
    expect(e.params.value).toBe(42);
  });

  it('builds binary expression', () => {
    const e = col('price').gt(0);
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('gt');
  });

  it('builds aggregation', () => {
    const e = col('price').sum();
    expect(e.kind).toBe('agg');
    expect(e.params.op).toBe(50); // OP_SUM
  });

  it('builds chained expression', () => {
    const e = col('a').add(col('b')).mul(lit(2));
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('mul');
  });

  it('auto-wraps literals in binary ops', () => {
    const e = col('price').gt(100);
    expect(e.kind).toBe('binop');
    const right = e.params.right as Expr;
    expect(right.kind).toBe('lit');
    expect(right.params.value).toBe(100);
  });

  it('builds alias', () => {
    const e = col('price').sum().alias('total_price');
    expect(e.kind).toBe('alias');
    expect(e.params.name).toBe('total_price');
  });

  it('builds unary expression', () => {
    const e = col('x').neg();
    expect(e.kind).toBe('unop');
    expect(e.params.op).toBe('neg');
  });
});
