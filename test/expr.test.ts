import { describe, it, expect } from 'vitest';
import { col, lit, Expr, type DateField } from '../lib/expr';

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

  it('builds countDistinct aggregation', () => {
    const e = col('x').countDistinct();
    expect(e.kind).toBe('agg');
    expect(e.params.op).toBe(58); // OP_COUNT_DISTINCT
  });

  it('builds stddev aggregation', () => {
    const e = col('x').stddev();
    expect(e.kind).toBe('agg');
    expect(e.params.op).toBe(59); // OP_STDDEV
  });

  it('builds stddevPop aggregation', () => {
    const e = col('x').stddevPop();
    expect(e.kind).toBe('agg');
    expect(e.params.op).toBe(73); // OP_STDDEV_POP
  });

  it('builds variance aggregation', () => {
    const e = col('x').variance();
    expect(e.kind).toBe('agg');
    expect(e.params.op).toBe(74); // OP_VAR
  });

  it('builds variancePop aggregation', () => {
    const e = col('x').variancePop();
    expect(e.kind).toBe('agg');
    expect(e.params.op).toBe(75); // OP_VAR_POP
  });

  it('builds upper unary op', () => {
    const e = col('name').upper();
    expect(e.kind).toBe('unop');
    expect(e.params.op).toBe('upper');
  });

  it('builds lower unary op', () => {
    const e = col('name').lower();
    expect(e.kind).toBe('unop');
    expect(e.params.op).toBe('lower');
  });

  it('builds strlen unary op', () => {
    const e = col('name').strlen();
    expect(e.kind).toBe('unop');
    expect(e.params.op).toBe('strlen');
  });

  it('builds trim unary op', () => {
    const e = col('name').trim();
    expect(e.kind).toBe('unop');
    expect(e.params.op).toBe('trim');
  });

  it('builds like binop', () => {
    const e = col('name').like('%alpha%');
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('like');
  });

  it('builds ilike binop', () => {
    const e = col('name').ilike('%ALPHA%');
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('ilike');
  });

  it('builds min2 binop', () => {
    const e = col('a').min2(col('b'));
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('min2');
  });

  it('builds max2 binop', () => {
    const e = col('a').max2(col('b'));
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('max2');
  });

  // N-ary ops
  it('builds substr naryop', () => {
    const e = col('name').substr(lit(0), lit(3));
    expect(e.kind).toBe('naryop');
    expect(e.params.op).toBe('substr');
    expect((e.params.args as Expr[]).length).toBe(3); // str, start, len
  });

  it('builds replace naryop', () => {
    const e = col('name').replace('old', 'new');
    expect(e.kind).toBe('naryop');
    expect(e.params.op).toBe('replace');
  });

  it('builds concat naryop', () => {
    const e = col('first').concat(lit(' '), col('last'));
    expect(e.kind).toBe('naryop');
    expect(e.params.op).toBe('concat');
    expect((e.params.args as Expr[]).length).toBe(3);
  });

  it('builds cast', () => {
    const e = col('x').cast('f64');
    expect(e.kind).toBe('cast');
    expect(e.params.targetType).toBe('f64');
  });

  it('builds Expr.if', () => {
    const e = Expr.if(col('x').gt(0), col('x'), lit(0));
    expect(e.kind).toBe('naryop');
    expect(e.params.op).toBe('if');
    expect((e.params.args as Expr[]).length).toBe(3);
  });
});
