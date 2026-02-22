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

    // Aggregations
    sum(): Expr { return new Expr('agg', { op: OP_SUM, arg: this }); }
    mean(): Expr { return new Expr('agg', { op: OP_AVG, arg: this }); }
    min(): Expr { return new Expr('agg', { op: OP_MIN, arg: this }); }
    max(): Expr { return new Expr('agg', { op: OP_MAX, arg: this }); }
    count(): Expr { return new Expr('agg', { op: OP_COUNT, arg: this }); }
    first(): Expr { return new Expr('agg', { op: OP_FIRST, arg: this }); }
    last(): Expr { return new Expr('agg', { op: OP_LAST, arg: this }); }

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
