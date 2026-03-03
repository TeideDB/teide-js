export type ExprKind = 'col' | 'lit' | 'binop' | 'unop' | 'agg' | 'alias';

// Agg opcodes (must match C defines in td.h)
export const OP_SUM = 50;
export const OP_PROD = 51;
export const OP_MIN = 52;
export const OP_MAX = 53;
export const OP_COUNT = 54;
export const OP_AVG = 55;
export const OP_FIRST = 56;
export const OP_LAST = 57;
export const OP_COUNT_DISTINCT = 58;
export const OP_STDDEV = 59;
export const OP_STDDEV_POP = 73;
export const OP_VAR = 74;
export const OP_VAR_POP = 75;

export class Expr {
    constructor(
        public readonly kind: ExprKind,
        public readonly params: Record<string, unknown> = {},
    ) {}

    // Binary ops
    add(other: Expr | number | string): Expr { return binop('add', this, wrap(other)); }
    sub(other: Expr | number | string): Expr { return binop('sub', this, wrap(other)); }
    mul(other: Expr | number | string): Expr { return binop('mul', this, wrap(other)); }
    div(other: Expr | number | string): Expr { return binop('div', this, wrap(other)); }
    mod(other: Expr | number | string): Expr { return binop('mod', this, wrap(other)); }

    // Comparison
    eq(other: Expr | number | string): Expr { return binop('eq', this, wrap(other)); }
    ne(other: Expr | number | string): Expr { return binop('ne', this, wrap(other)); }
    lt(other: Expr | number | string): Expr { return binop('lt', this, wrap(other)); }
    le(other: Expr | number | string): Expr { return binop('le', this, wrap(other)); }
    gt(other: Expr | number | string): Expr { return binop('gt', this, wrap(other)); }
    ge(other: Expr | number | string): Expr { return binop('ge', this, wrap(other)); }

    // Logical
    and(other: Expr): Expr { return binop('and', this, other); }
    or(other: Expr): Expr { return binop('or', this, other); }

    // String binary
    like(pattern: Expr | string): Expr { return binop('like', this, wrap(pattern)); }
    ilike(pattern: Expr | string): Expr { return binop('ilike', this, wrap(pattern)); }

    // Element-wise min/max
    min2(other: Expr | number): Expr { return binop('min2', this, wrap(other)); }
    max2(other: Expr | number): Expr { return binop('max2', this, wrap(other)); }

    // Unary
    not(): Expr { return new Expr('unop', { op: 'not', arg: this }); }
    neg(): Expr { return new Expr('unop', { op: 'neg', arg: this }); }
    abs(): Expr { return new Expr('unop', { op: 'abs', arg: this }); }
    sqrt(): Expr { return new Expr('unop', { op: 'sqrt', arg: this }); }
    log(): Expr { return new Expr('unop', { op: 'log', arg: this }); }
    exp(): Expr { return new Expr('unop', { op: 'exp', arg: this }); }
    ceil(): Expr { return new Expr('unop', { op: 'ceil', arg: this }); }
    floor(): Expr { return new Expr('unop', { op: 'floor', arg: this }); }
    isNull(): Expr { return new Expr('unop', { op: 'isnull', arg: this }); }

    // String unary
    upper(): Expr { return new Expr('unop', { op: 'upper', arg: this }); }
    lower(): Expr { return new Expr('unop', { op: 'lower', arg: this }); }
    strlen(): Expr { return new Expr('unop', { op: 'strlen', arg: this }); }
    trim(): Expr { return new Expr('unop', { op: 'trim', arg: this }); }

    // Aggregations
    sum(): Expr { return new Expr('agg', { op: OP_SUM, arg: this }); }
    mean(): Expr { return new Expr('agg', { op: OP_AVG, arg: this }); }
    min(): Expr { return new Expr('agg', { op: OP_MIN, arg: this }); }
    max(): Expr { return new Expr('agg', { op: OP_MAX, arg: this }); }
    count(): Expr { return new Expr('agg', { op: OP_COUNT, arg: this }); }
    first(): Expr { return new Expr('agg', { op: OP_FIRST, arg: this }); }
    last(): Expr { return new Expr('agg', { op: OP_LAST, arg: this }); }
    countDistinct(): Expr { return new Expr('agg', { op: OP_COUNT_DISTINCT, arg: this }); }
    stddev(): Expr { return new Expr('agg', { op: OP_STDDEV, arg: this }); }
    stddevPop(): Expr { return new Expr('agg', { op: OP_STDDEV_POP, arg: this }); }
    variance(): Expr { return new Expr('agg', { op: OP_VAR, arg: this }); }
    variancePop(): Expr { return new Expr('agg', { op: OP_VAR_POP, arg: this }); }

    // Rename
    alias(name: string): Expr { return new Expr('alias', { name, arg: this }); }
}

export function col(name: string): Expr {
    return new Expr('col', { name });
}

export function lit(value: number | string | boolean): Expr {
    return new Expr('lit', { value });
}

function wrap(x: Expr | number | string | boolean): Expr {
    return x instanceof Expr ? x : lit(x);
}

function binop(op: string, left: Expr, right: Expr): Expr {
    return new Expr('binop', { op, left, right });
}
