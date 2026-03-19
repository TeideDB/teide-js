import { Expr, col, lit, OP_SUM, OP_PROD, OP_MIN, OP_MAX, OP_COUNT, OP_AVG, OP_FIRST, OP_LAST } from '../expr';
import { resolveFunction } from './functions';

// Maps node-sql-parser binary operators to Teide Expr binop names
const BINOP_MAP: Record<string, string> = {
    '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
    '=': 'eq', '!=': 'ne', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
    'AND': 'and', 'OR': 'or',
};

// Maps SQL aggregate names to Teide opcodes
const AGG_MAP: Record<string, number> = {
    SUM: OP_SUM, AVG: OP_AVG, MIN: OP_MIN, MAX: OP_MAX,
    COUNT: OP_COUNT, PROD: OP_PROD, FIRST: OP_FIRST, LAST: OP_LAST,
};

// Compile a node-sql-parser AST expression node into a Teide Expr tree.
// The `aliases` map resolves column aliases from SELECT (for HAVING/ORDER BY).
export function compileExpr(node: any, aliases?: Map<string, Expr>): Expr {
    if (!node) throw new Error('Null expression node');

    switch (node.type) {
        case 'column_ref': {
            const name = typeof node.column === 'string' ? node.column : node.column?.expr?.value;
            if (!name) throw new Error('Cannot resolve column name');
            if (aliases?.has(name)) return aliases.get(name)!;
            return col(name);
        }

        case 'number':
            return lit(node.value);

        case 'single_quote_string':
        case 'double_quote_string':
        case 'string':
            return lit(node.value);

        case 'bool':
            return lit(node.value);

        case 'null':
            // Represent NULL as lit(0) for now - limited without proper null support
            return lit(0);

        case 'star':
            // COUNT(*) uses a dummy column - handled at aggregate level
            return col('*');

        case 'binary_expr':
            return compileBinaryExpr(node, aliases);

        case 'unary_expr':
            return compileUnaryExpr(node, aliases);

        case 'aggr_func':
            return compileAggrFunc(node, aliases);

        case 'function':
            return compileFunction(node, aliases);

        case 'case':
            return compileCaseExpr(node, aliases);

        case 'cast':
            // CAST not fully supported without C++ changes - pass through the inner expr
            return compileExpr(node.expr, aliases);

        case 'expr_list':
            // For IN lists etc - shouldn't reach here normally
            throw new Error('Unexpected expr_list in expression compilation');

        default:
            throw new Error(`Unsupported expression type: ${node.type}`);
    }
}

function compileBinaryExpr(node: any, aliases?: Map<string, Expr>): Expr {
    const op = node.operator;

    // Special operators
    if (op === 'IS') {
        const left = compileExpr(node.left, aliases);
        if (node.right?.type === 'null') return left.isNull();
        throw new Error('IS operator only supports IS NULL');
    }

    if (op === 'IS NOT') {
        const left = compileExpr(node.left, aliases);
        if (node.right?.type === 'null') return left.isNull().not();
        throw new Error('IS NOT operator only supports IS NOT NULL');
    }

    if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
        // x BETWEEN a AND b → x >= a AND x <= b
        const expr = compileExpr(node.left, aliases);
        const low = compileExpr(node.right.value[0], aliases);
        const high = compileExpr(node.right.value[1], aliases);
        const result = expr.ge(low).and(expr.le(high));
        return op === 'NOT BETWEEN' ? result.not() : result;
    }

    if (op === 'IN' || op === 'NOT IN') {
        // x IN (a, b, c) → x = a OR x = b OR x = c
        const expr = compileExpr(node.left, aliases);
        const values: any[] = node.right.value || node.right;
        let result: Expr | null = null;
        for (const v of values) {
            const eq = expr.eq(compileExpr(v, aliases));
            result = result ? result.or(eq) : eq;
        }
        if (!result) {
            // Empty IN list (e.g., from empty subquery) matches nothing
            return lit(0);
        }
        return op === 'NOT IN' ? result.not() : result;
    }

    if (op === 'LIKE' || op === 'NOT LIKE') {
        // LIKE not directly supported without string ops - throw
        throw new Error('LIKE operator not yet supported (requires string NAPI bindings)');
    }

    // Standard binary operators
    const binop = BINOP_MAP[op];
    if (!binop) throw new Error(`Unsupported binary operator: ${op}`);

    const left = compileExpr(node.left, aliases);
    const right = compileExpr(node.right, aliases);
    return new Expr('binop', { op: binop, left, right });
}

function compileUnaryExpr(node: any, aliases?: Map<string, Expr>): Expr {
    const inner = compileExpr(node.expr, aliases);
    switch (node.operator) {
        case '-': return inner.neg();
        case '+': return inner;
        case 'NOT': return inner.not();
        default: throw new Error(`Unsupported unary operator: ${node.operator}`);
    }
}

function compileAggrFunc(node: any, aliases?: Map<string, Expr>): Expr {
    const name = node.name.toUpperCase();
    const opcode = AGG_MAP[name];
    if (opcode === undefined) throw new Error(`Unknown aggregate function: ${name}`);

    if (node.args.distinct) {
        throw new Error(`${name}(DISTINCT ...) is not yet supported`);
    }

    // COUNT(*) → count on first column (the C layer handles this)
    let arg: Expr;
    if (node.args.expr?.type === 'star') {
        arg = col('*');
    } else {
        arg = compileExpr(node.args.expr, aliases);
    }

    return new Expr('agg', { op: opcode, arg });
}

function compileFunction(node: any, aliases?: Map<string, Expr>): Expr {
    // Extract function name from AST
    const nameParts = node.name?.name;
    let funcName: string;
    if (Array.isArray(nameParts)) {
        funcName = nameParts.map((p: any) => p.value).join('.');
    } else {
        funcName = String(node.name);
    }

    // Compile arguments
    const args: Expr[] = [];
    if (node.args?.type === 'expr_list') {
        for (const v of node.args.value) {
            args.push(compileExpr(v, aliases));
        }
    }

    const builder = resolveFunction(funcName);
    return builder(args);
}

function compileCaseExpr(node: any, _aliases?: Map<string, Expr>): Expr {
    // CASE WHEN is not fully expressible without td_if
    // For now, throw an informative error
    throw new Error('CASE WHEN not yet supported (requires td_if NAPI binding)');
}

// Check if an expression AST node contains aggregate functions
export function containsAggregate(node: any): boolean {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'aggr_func') return true;
    if (node.type === 'function') {
        const nameParts = node.name?.name;
        let funcName: string;
        if (Array.isArray(nameParts)) {
            funcName = nameParts.map((p: any) => p.value).join('.').toUpperCase();
        } else {
            funcName = String(node.name).toUpperCase();
        }
        if (AGG_MAP[funcName] !== undefined) return true;
    }
    // Recurse into children
    for (const key of Object.keys(node)) {
        if (key === 'type') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            if (child.some(c => containsAggregate(c))) return true;
        } else if (child && typeof child === 'object') {
            if (containsAggregate(child)) return true;
        }
    }
    return false;
}
