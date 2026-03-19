import { Expr, col, lit, OP_SUM, OP_PROD, OP_MIN, OP_MAX, OP_COUNT, OP_AVG, OP_FIRST, OP_LAST } from '../expr';

export type ExprBuilder = (args: Expr[]) => Expr;

// Unary op builder helper
function unop(op: string): ExprBuilder {
    return (args) => {
        if (args.length !== 1) throw new Error(`${op}() requires exactly 1 argument`);
        return new Expr('unop', { op, arg: args[0] });
    };
}

// Aggregate op builder helper
function agg(opcode: number): ExprBuilder {
    return (args) => {
        if (args.length !== 1) throw new Error(`Aggregate requires exactly 1 argument`);
        return new Expr('agg', { op: opcode, arg: args[0] });
    };
}

const registry = new Map<string, ExprBuilder>();

// Math functions → unary ops
registry.set('ABS', unop('abs'));
registry.set('CEIL', unop('ceil'));
registry.set('CEILING', unop('ceil'));
registry.set('FLOOR', unop('floor'));
registry.set('SQRT', unop('sqrt'));
registry.set('LN', unop('log'));
registry.set('LOG', unop('log'));
registry.set('EXP', unop('exp'));

// ROUND(x) → floor(x + 0.5) approximation (single-arg only)
// Note: Uses "round half up" semantics. For negative numbers, this rounds toward
// positive infinity (e.g., ROUND(-0.5) = 0), which differs from SQL standard
// "round half away from zero". A proper round opcode is not yet available in the C layer.
registry.set('ROUND', (args) => {
    if (args.length !== 1) throw new Error('ROUND() with precision not yet supported');
    return new Expr('unop', { op: 'floor', arg: args[0].add(lit(0.5)) });
});

// Aggregate functions
registry.set('SUM', agg(OP_SUM));
registry.set('AVG', agg(OP_AVG));
registry.set('MIN', agg(OP_MIN));
registry.set('MAX', agg(OP_MAX));
registry.set('COUNT', agg(OP_COUNT));
registry.set('PROD', agg(OP_PROD));
registry.set('FIRST', agg(OP_FIRST));
registry.set('LAST', agg(OP_LAST));

// COALESCE requires td_if NAPI binding for multi-arg support
registry.set('COALESCE', (args) => {
    if (args.length < 1) throw new Error('COALESCE() requires at least 1 argument');
    if (args.length === 1) return args[0];
    throw new Error('COALESCE() with multiple arguments not yet supported (requires td_if NAPI binding)');
});

// NULLIF not expressible without td_if either
registry.set('NULLIF', (_args) => {
    throw new Error('NULLIF() not yet supported (requires td_if NAPI binding)');
});

export function resolveFunction(name: string): ExprBuilder {
    const upper = name.toUpperCase();
    const builder = registry.get(upper);
    if (!builder) throw new Error(`Unknown function: ${name}`);
    return builder;
}

