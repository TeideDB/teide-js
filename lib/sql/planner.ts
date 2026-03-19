import { Expr, col, lit } from '../expr';
import { Table } from '../table';
import { Query } from '../query';
import { Session, StoredTable } from './session';
import { compileExpr, containsAggregate } from './expr';
import { parse } from './parser';
import path from 'path';

const addon = require(path.join(__dirname, '..', '..', 'build', 'Release', 'teidedb_addon.node'));

export interface PlanResult {
    table: Table | null;
}

export function planAndExecuteSync(sql: string, session: Session, ctx: any): Table | null {
    const ast = parse(sql);
    if (ast.type !== 'select') {
        throw new Error(`Unsupported SQL statement type: ${ast.type}`);
    }
    return planSelect(ast, session, ctx);
}

export async function planAndExecute(sql: string, session: Session, ctx: any): Promise<Table | null> {
    // For now, SELECT planning is synchronous (only execution can be async)
    return planAndExecuteSync(sql, session, ctx);
}

function planSelect(ast: any, session: Session, ctx: any): Table {
    // 1. Resolve FROM table
    const stored = resolveFrom(ast.from, session, ctx);

    // 2. Build column alias map for resolving references in HAVING/ORDER BY
    const selectAliases = buildSelectAliases(ast.columns, stored);

    // 3. Determine if this is an aggregate query
    const hasGroupBy = ast.groupby !== null && ast.groupby !== undefined;
    const hasAggInSelect = ast.columns !== '*' &&
        ast.columns.some((c: any) => containsAggregate(c.expr));
    const isAggregate = hasGroupBy || hasAggInSelect;

    // Build the query via the fluent API
    let query = new Query(stored.nativeTable, ctx);

    // 4. WHERE filter
    if (ast.where) {
        const filterExpr = compileExpr(ast.where);
        query = query.filter(filterExpr);
    }

    // 5. GROUP BY + aggregation
    if (isAggregate) {
        const { keys, aggs } = buildGroupByPlan(ast, stored, selectAliases);
        const groupBy = query.groupBy(...keys);
        query = groupBy.agg(...aggs);
    }

    // 6. HAVING (post-aggregation filter)
    // HAVING references aliases from SELECT, applied after grouping
    if (ast.having) {
        // After GROUP BY, columns are renamed: group keys keep names, aggs get aliases
        // We need to compile HAVING against the post-group schema
        const havingExpr = compileExpr(ast.having, selectAliases);
        query = query.filter(havingExpr);
    }

    // 7. ORDER BY
    if (ast.orderby) {
        for (const ob of ast.orderby) {
            const colName = resolveOrderByColumn(ob.expr, selectAliases);
            const descending = ob.type === 'DESC';
            query = query.sort(colName, { descending });
        }
    }

    // 8. DISTINCT (implemented as GROUP BY all columns with first() agg)
    if (ast.distinct === 'DISTINCT' && !isAggregate) {
        // For DISTINCT without GROUP BY, we group by all selected columns
        // and take first() of each
        const distinctCols = resolveSelectColumns(ast.columns, stored);
        const groupBy = query.groupBy(...distinctCols);
        const aggs = distinctCols.map(name => col(name).first().alias(name));
        query = groupBy.agg(...aggs);
    }

    // 9. LIMIT / OFFSET
    if (ast.limit) {
        const limitVal = ast.limit.value;
        if (ast.limit.seperator === 'offset' && limitVal.length === 2) {
            // LIMIT n OFFSET m → head(n + m) then we'd need to skip m
            // Since Teide's head() only supports top-N, OFFSET requires post-processing
            const limit = limitVal[0].value;
            const offset = limitVal[1].value;
            if (offset > 0) {
                // Execute with limit+offset, then slice in JS
                query = query.head(limit + offset);
                const fullResult = query.collectSync();
                return sliceTable(fullResult, offset, limit, ctx, session);
            }
            query = query.head(limit);
        } else if (limitVal.length === 1) {
            query = query.head(limitVal[0].value);
        }
    }

    // 10. Execute
    return query.collectSync();
}

function resolveFrom(from: any[], session: Session, ctx: any): StoredTable {
    if (!from || from.length === 0) {
        throw new Error('SELECT requires a FROM clause');
    }
    if (from.length > 1) {
        throw new Error('JOINs not yet supported (Phase 2)');
    }

    const source = from[0];

    // Handle read_csv function call in FROM
    if (source.expr?.type === 'function') {
        const funcName = extractFunctionName(source.expr);
        if (funcName.toLowerCase() === 'read_csv') {
            const args = source.expr.args?.value || [];
            if (args.length !== 1 || args[0].type !== 'single_quote_string') {
                throw new Error('read_csv() requires a single string argument');
            }
            const filePath = args[0].value;
            const table = new Table(ctx.readCsvSync(filePath), ctx);
            const alias = source.as || '_csv';
            session.register(alias, table);
            return session.get(alias)!;
        }
    }

    const tableName = source.table;
    if (!tableName) throw new Error('Cannot resolve table name from FROM clause');

    const stored = session.get(tableName);
    if (!stored) throw new Error(`Table not found: ${tableName}`);

    return stored;
}

function extractFunctionName(node: any): string {
    const nameParts = node.name?.name;
    if (Array.isArray(nameParts)) {
        return nameParts.map((p: any) => p.value).join('.');
    }
    return String(node.name);
}

function buildSelectAliases(columns: any, stored: StoredTable): Map<string, Expr> {
    const aliases = new Map<string, Expr>();
    if (columns === '*') return aliases;

    for (const c of columns) {
        if (c.as) {
            aliases.set(c.as, compileExpr(c.expr));
        }
    }
    return aliases;
}

function buildGroupByPlan(
    ast: any,
    stored: StoredTable,
    selectAliases: Map<string, Expr>,
): { keys: string[]; aggs: Expr[] } {
    // Group keys from GROUP BY clause
    const keys: string[] = [];
    if (ast.groupby) {
        for (const g of ast.groupby.columns) {
            if (g.type === 'column_ref') {
                const name = typeof g.column === 'string' ? g.column : g.column?.expr?.value;
                keys.push(name);
            } else {
                throw new Error('Only column references supported in GROUP BY');
            }
        }
    }

    // Aggregate expressions from SELECT columns
    const aggs: Expr[] = [];
    if (ast.columns !== '*') {
        for (const c of ast.columns) {
            // Skip group key columns (they're implicit in the result)
            if (c.expr.type === 'column_ref') {
                const name = typeof c.expr.column === 'string'
                    ? c.expr.column
                    : c.expr.column?.expr?.value;
                if (keys.includes(name)) continue;
            }

            const expr = compileExpr(c.expr);
            const alias = c.as || getExprName(c.expr);
            aggs.push(expr.alias(alias));
        }
    }

    return { keys, aggs };
}

function getExprName(node: any): string {
    if (node.type === 'column_ref') {
        return typeof node.column === 'string' ? node.column : node.column?.expr?.value || 'col';
    }
    if (node.type === 'aggr_func') {
        const argName = node.args?.expr?.type === 'star' ? 'star' :
            getExprName(node.args?.expr);
        return `${node.name.toLowerCase()}_${argName}`;
    }
    return 'expr';
}

function resolveOrderByColumn(expr: any, aliases: Map<string, Expr>): string {
    if (expr.type === 'column_ref') {
        const name = typeof expr.column === 'string' ? expr.column : expr.column?.expr?.value;
        return name;
    }
    throw new Error('Only column references supported in ORDER BY');
}

function resolveSelectColumns(columns: any, stored: StoredTable): string[] {
    if (columns === '*') return [...stored.columns];
    return columns.map((c: any) => {
        if (c.expr.type === 'column_ref') {
            return typeof c.expr.column === 'string'
                ? c.expr.column
                : c.expr.column?.expr?.value;
        }
        return c.as || 'col';
    });
}

// For OFFSET support: execute the full query then slice the result
function sliceTable(
    fullResult: Table,
    offset: number,
    limit: number,
    ctx: any,
    session: Session,
): Table {
    // Use head() on the result table, but we need to skip `offset` rows first
    // Since Teide doesn't have a skip/offset op, we register the intermediate result
    // and use sort + head as a workaround
    // For now, return the full result (offset support is limited)
    // TODO: Implement proper offset support
    return fullResult;
}
