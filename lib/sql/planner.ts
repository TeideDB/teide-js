import { Expr, col, lit } from '../expr';
import { Table } from '../table';
import { Query } from '../query';
import { Session, StoredTable } from './session';
import { compileExpr, containsAggregate } from './expr';
import { parse } from './parser';
import { extractRows, materializeTable, RowData } from './js-table';
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
    return planSelectWithSetOps(ast, session, ctx);
}

export async function planAndExecute(sql: string, session: Session, ctx: any): Promise<Table | null> {
    return planAndExecuteSync(sql, session, ctx);
}

// Handle set operations (UNION, EXCEPT, INTERSECT) by chaining selects
function planSelectWithSetOps(ast: any, session: Session, ctx: any): Table {
    const left = planSelect(ast, session, ctx);

    if (!ast.set_op || !ast._next) return left;

    const right = planSelectWithSetOps(ast._next, session, ctx);
    const setOp: string = ast.set_op;

    const leftData = extractRows(left);
    const rightData = extractRows(right);

    // Use left side's column names for the result
    const columns = leftData.columns;
    let resultRows: any[][];

    if (setOp === 'union all') {
        resultRows = [...leftData.rows, ...rightData.rows];
    } else if (setOp === 'union') {
        // UNION = UNION ALL + DISTINCT
        const combined = [...leftData.rows, ...rightData.rows];
        resultRows = deduplicateRows(combined);
    } else if (setOp === 'except') {
        const rightSet = rowSet(rightData.rows);
        resultRows = leftData.rows.filter(row => !rightSet.has(rowKey(row)));
    } else if (setOp === 'intersect') {
        const rightSet = rowSet(rightData.rows);
        resultRows = leftData.rows.filter(row => rightSet.has(rowKey(row)));
    } else {
        throw new Error(`Unsupported set operation: ${setOp}`);
    }

    return materializeTable({ columns, rows: resultRows }, ctx);
}

function planSelect(ast: any, session: Session, ctx: any): Table {
    // 1. Resolve FROM - may be a single table, JOIN, or subquery
    const from = ast.from;
    const hasJoin = from && from.length > 1 && from[1].join;
    const hasSubquery = from && from.length === 1 && from[0].expr?.ast;

    // Check if any SELECT column has a window function
    const hasWindowFn = ast.columns !== '*' &&
        ast.columns.some((c: any) => c.expr?.over);

    if (hasJoin) {
        return planJoinSelect(ast, session, ctx);
    }

    if (hasSubquery) {
        // FROM subquery: execute inner query, register as temp table
        const subAst = from[0].expr.ast;
        const subResult = planSelectWithSetOps(subAst, session, ctx);
        const alias = from[0].as || '_sub';
        session.register(alias, subResult);
        // Replace FROM with the registered alias
        const modifiedAst = { ...ast, from: [{ table: alias, as: null }] };
        return planSimpleSelect(modifiedAst, session, ctx);
    }

    if (hasWindowFn) {
        return planWindowSelect(ast, session, ctx);
    }

    return planSimpleSelect(ast, session, ctx);
}

// Original single-table SELECT logic (now handles the simple case)
function planSimpleSelect(ast: any, session: Session, ctx: any): Table {
    const stored = resolveFromSingle(ast.from, session, ctx);

    const selectAliases = buildSelectAliases(ast.columns, stored);

    const hasGroupBy = ast.groupby !== null && ast.groupby !== undefined;
    const hasAggInSelect = ast.columns !== '*' &&
        ast.columns.some((c: any) => containsAggregate(c.expr));
    const isAggregate = hasGroupBy || hasAggInSelect;

    let query = new Query(stored.nativeTable, ctx);

    // WHERE filter - handle subqueries in WHERE
    if (ast.where) {
        const where = rewriteSubqueryInWhere(ast.where, session, ctx);
        const filterExpr = compileExpr(where);
        query = query.filter(filterExpr);
    }

    if (isAggregate) {
        const { keys, aggs } = buildGroupByPlan(ast, stored, selectAliases);
        const groupBy = query.groupBy(...keys);
        query = groupBy.agg(...aggs);
    }

    if (ast.having) {
        const havingExpr = compileExpr(ast.having, selectAliases);
        query = query.filter(havingExpr);
    }

    if (ast.orderby) {
        for (const ob of ast.orderby) {
            const colName = resolveOrderByColumn(ob.expr, selectAliases);
            const descending = ob.type === 'DESC';
            query = query.sort(colName, { descending });
        }
    }

    if (ast.distinct === 'DISTINCT' && !isAggregate) {
        const distinctCols = resolveSelectColumns(ast.columns, stored);
        const groupBy = query.groupBy(...distinctCols);
        const aggs = distinctCols.map(name => col(name).first().alias(name));
        query = groupBy.agg(...aggs);
    }

    if (ast.limit) {
        const limitVal = ast.limit.value;
        if (ast.limit.seperator === 'offset' && limitVal.length === 2) {
            const limit = limitVal[0].value;
            const offset = limitVal[1].value;
            if (offset > 0) {
                query = query.head(limit + offset);
                const fullResult = query.collectSync();
                return sliceTable(fullResult, offset, limit, ctx);
            }
            query = query.head(limit);
        } else if (limitVal.length === 1) {
            query = query.head(limitVal[0].value);
        }
    }

    return query.collectSync();
}

// ─── JOIN planning ──────────────────────────────────────────────────────────

function planJoinSelect(ast: any, session: Session, ctx: any): Table {
    // Build the joined row data by processing FROM entries left-to-right
    const from = ast.from;

    // Start with the first (left) table
    const leftStored = resolveFromSingle([from[0]], session, ctx);
    let result = extractRows(leftStored.table);
    let tableAliases = buildAliasMap(from[0], result.columns);

    // Process each subsequent JOIN
    for (let i = 1; i < from.length; i++) {
        const joinEntry = from[i];
        const joinType: string = joinEntry.join || 'INNER JOIN';
        const rightStored = resolveFromSingle([joinEntry], session, ctx);
        const rightData = extractRows(rightStored.table);
        const rightAliases = buildAliasMap(joinEntry, rightData.columns);

        // Merge alias maps
        const combinedAliases = new Map([...tableAliases, ...rightAliases]);

        if (joinType === 'CROSS JOIN') {
            result = crossJoin(result, rightData);
        } else {
            // INNER JOIN or LEFT JOIN - evaluate ON condition
            const isLeft = joinType.includes('LEFT');
            result = nestedLoopJoin(result, rightData, joinEntry.on, combinedAliases, isLeft);
        }

        // Update alias map with combined columns
        tableAliases = combinedAliases;
    }

    // Now apply WHERE, ORDER BY, LIMIT on the joined result
    let table = materializeTable(result, ctx);

    // Register temporarily for query operations
    const tmpName = `_join_${Date.now()}`;
    session.register(tmpName, table);
    const stored = session.get(tmpName)!;

    // Apply remaining clauses through a simplified planSimpleSelect
    const joinedAst = {
        ...ast,
        from: [{ table: tmpName, as: null }],
    };

    // Strip table prefixes from column refs in WHERE, ORDER BY, etc.
    rewriteTablePrefixes(joinedAst, tableAliases, result.columns);

    return planSimpleSelect(joinedAst, session, ctx);
}

function buildAliasMap(fromEntry: any, columns: string[]): Map<string, string> {
    const map = new Map<string, string>();
    const alias = fromEntry.as || fromEntry.table;
    if (alias) {
        for (const col of columns) {
            map.set(`${alias}.${col}`, col);
        }
    }
    return map;
}

function crossJoin(left: RowData, right: RowData): RowData {
    // Prefix columns with table-scoped names to avoid collisions
    const columns = [...left.columns, ...prefixColumns(right.columns, left.columns)];
    const rows: any[][] = [];
    for (const lr of left.rows) {
        for (const rr of right.rows) {
            rows.push([...lr, ...rr]);
        }
    }
    return { columns, rows };
}

function nestedLoopJoin(
    left: RowData,
    right: RowData,
    onCondition: any,
    aliasMap: Map<string, string>,
    isLeft: boolean,
): RowData {
    const rightCols = prefixColumns(right.columns, left.columns);
    const columns = [...left.columns, ...rightCols];
    const rows: any[][] = [];

    // Parse the ON condition to extract left/right column references
    const { leftCol, rightCol } = parseEqualityCondition(onCondition, left.columns, right.columns, aliasMap);

    const leftColIdx = left.columns.indexOf(leftCol);
    const rightColIdx = right.columns.indexOf(rightCol);

    if (leftColIdx === -1) throw new Error(`JOIN column not found in left table: ${leftCol}`);
    if (rightColIdx === -1) throw new Error(`JOIN column not found in right table: ${rightCol}`);

    // Build hash map on right side for O(n+m) performance
    const rightIndex = new Map<string, any[][]>();
    for (const rr of right.rows) {
        const key = String(rr[rightColIdx]);
        if (!rightIndex.has(key)) rightIndex.set(key, []);
        rightIndex.get(key)!.push(rr);
    }

    for (const lr of left.rows) {
        const key = String(lr[leftColIdx]);
        const matches = rightIndex.get(key);
        if (matches && matches.length > 0) {
            for (const rr of matches) {
                rows.push([...lr, ...rr]);
            }
        } else if (isLeft) {
            // LEFT JOIN: include left row with NULLs for right columns
            const nullRight = right.columns.map(() => 0); // Use 0 for NULL (Teide limitation)
            rows.push([...lr, ...nullRight]);
        }
    }

    return { columns, rows };
}

function parseEqualityCondition(
    node: any,
    leftCols: string[],
    rightCols: string[],
    aliasMap: Map<string, string>,
): { leftCol: string; rightCol: string } {
    if (node.type !== 'binary_expr' || node.operator !== '=') {
        throw new Error('JOIN ON condition must be an equality expression (a.col = b.col)');
    }

    const lref = resolveColumnRef(node.left, aliasMap);
    const rref = resolveColumnRef(node.right, aliasMap);

    // Determine which ref belongs to which side
    if (leftCols.includes(lref) && rightCols.includes(rref)) {
        return { leftCol: lref, rightCol: rref };
    }
    if (leftCols.includes(rref) && rightCols.includes(lref)) {
        return { leftCol: rref, rightCol: lref };
    }

    throw new Error(`JOIN columns not found: ${lref}, ${rref}`);
}

function resolveColumnRef(node: any, aliasMap: Map<string, string>): string {
    if (node.type !== 'column_ref') {
        throw new Error('Expected column reference in JOIN ON condition');
    }
    const colName = typeof node.column === 'string' ? node.column : node.column?.expr?.value;
    if (node.table) {
        const qualified = `${node.table}.${colName}`;
        return aliasMap.get(qualified) || colName;
    }
    return colName;
}

function prefixColumns(cols: string[], existingCols: string[]): string[] {
    return cols.map(c => existingCols.includes(c) ? `${c}_1` : c);
}

function rewriteTablePrefixes(ast: any, aliasMap: Map<string, string>, resultColumns: string[]): void {
    // Walk the AST and strip table prefixes from column_ref nodes
    rewriteNode(ast.where);
    rewriteNode(ast.having);
    if (ast.orderby) {
        for (const ob of ast.orderby) {
            rewriteNode(ob.expr);
        }
    }
    if (ast.columns !== '*') {
        for (const c of ast.columns) {
            rewriteNode(c.expr);
        }
    }
    if (ast.groupby?.columns) {
        for (const g of ast.groupby.columns) {
            rewriteNode(g);
        }
    }

    function rewriteNode(node: any): void {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'column_ref' && node.table) {
            const colName = typeof node.column === 'string' ? node.column : node.column?.expr?.value;
            const qualified = `${node.table}.${colName}`;
            const resolved = aliasMap.get(qualified);
            if (resolved) {
                // Find the actual column name in the result (may have _1 suffix)
                const actual = resultColumns.includes(resolved) ? resolved :
                    resultColumns.find(c => c === `${resolved}_1`) || resolved;
                node.column = actual;
                node.table = null;
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'type') continue;
            const child = node[key];
            if (Array.isArray(child)) {
                child.forEach(rewriteNode);
            } else if (child && typeof child === 'object') {
                rewriteNode(child);
            }
        }
    }
}

// ─── Subquery rewriting ─────────────────────────────────────────────────────

function rewriteSubqueryInWhere(node: any, session: Session, ctx: any): any {
    if (!node || typeof node !== 'object') return node;

    // IN subquery: right side is expr_list with a single item that has .ast
    if (node.type === 'binary_expr' && (node.operator === 'IN' || node.operator === 'NOT IN')) {
        const right = node.right;
        if (right?.type === 'expr_list' && right.value?.length === 1 && right.value[0].ast) {
            // Execute the subquery
            const subAst = right.value[0].ast;
            const subResult = planSelectWithSetOps(subAst, session, ctx);
            const subData = extractRows(subResult);

            // Determine which column the subquery SELECTs
            // The planner doesn't do projection, so we need to find the selected column
            const subSelectCols = subAst.columns;
            let colIdx = 0;
            if (subSelectCols !== '*' && subSelectCols.length === 1) {
                const selColName = resolveColName(subSelectCols[0].expr);
                colIdx = subData.columns.indexOf(selColName);
                if (colIdx === -1) colIdx = 0;
            }
            const values = subData.rows.map(row => row[colIdx]);

            // Rewrite as: col IN (val1, val2, ...)
            const valueNodes = values.map((v: any) => ({
                type: typeof v === 'string' ? 'single_quote_string' : 'number',
                value: v,
            }));

            return {
                ...node,
                right: { type: 'expr_list', value: valueNodes },
            };
        }
    }

    // Recurse into children
    const result: any = { ...node };
    for (const key of Object.keys(result)) {
        if (key === 'type') continue;
        const child = result[key];
        if (Array.isArray(child)) {
            result[key] = child.map(c =>
                c && typeof c === 'object' ? rewriteSubqueryInWhere(c, session, ctx) : c
            );
        } else if (child && typeof child === 'object') {
            result[key] = rewriteSubqueryInWhere(child, session, ctx);
        }
    }
    return result;
}

// ─── Window functions ───────────────────────────────────────────────────────

function planWindowSelect(ast: any, session: Session, ctx: any): Table {
    // Execute the base query (without window functions) first
    const stored = resolveFromSingle(ast.from, session, ctx);
    const baseData = extractRows(stored.table);

    // Apply WHERE filter if present
    let rows = baseData.rows;
    if (ast.where) {
        // Execute with WHERE via the native engine, then extract
        const filteredAst = { ...ast, columns: '*', orderby: null, limit: null };
        delete filteredAst.columns;
        // Use the simpler approach: just execute a SELECT * with WHERE
        const tmpName = `_wbase_${Date.now()}`;
        session.register(tmpName, stored.table);
        const filterQuery = `SELECT * FROM ${tmpName}` +
            (ast.where ? ` WHERE ${reconstructWhereClause(ast.where)}` : '');
        // Actually, we can't easily reconstruct SQL. Instead, use the fluent API.
        let query = new Query(stored.nativeTable, ctx);
        const filterExpr = compileExpr(ast.where);
        query = query.filter(filterExpr);
        const filtered = query.collectSync();
        const filteredData = extractRows(filtered);
        rows = filteredData.rows;
    }

    // Build result columns and compute window function values
    const resultColumns: string[] = [];
    const resultColData: any[][] = [];

    for (const c of ast.columns) {
        if (c.expr.over) {
            // Window function column
            const winResult = computeWindowFunction(c.expr, rows, baseData.columns);
            resultColumns.push(c.as || 'window_col');
            resultColData.push(winResult);
        } else {
            // Regular column reference
            const colName = resolveColName(c.expr);
            const colIdx = baseData.columns.indexOf(colName);
            if (colIdx === -1) throw new Error(`Column not found: ${colName}`);
            resultColumns.push(c.as || colName);
            resultColData.push(rows.map(row => row[colIdx]));
        }
    }

    // Build result rows
    const nRows = rows.length;
    const resultRows: any[][] = [];
    for (let i = 0; i < nRows; i++) {
        const row: any[] = [];
        for (let c = 0; c < resultColumns.length; c++) {
            row.push(resultColData[c][i]);
        }
        resultRows.push(row);
    }

    let result: RowData = { columns: resultColumns, rows: resultRows };

    // Apply ORDER BY on the final result
    if (ast.orderby) {
        result = sortRowData(result, ast.orderby);
    }

    // Apply LIMIT
    if (ast.limit) {
        const limitVal = ast.limit.value;
        if (limitVal.length === 1) {
            result.rows = result.rows.slice(0, limitVal[0].value);
        }
    }

    return materializeTable(result, ctx);
}

function computeWindowFunction(expr: any, rows: any[][], columns: string[]): number[] {
    const funcName = extractWindowFuncName(expr);
    const spec = expr.over.as_window_specification.window_specification;
    const partitionBy = spec.partitionby;
    const orderBy = spec.orderby;

    // Build partition groups
    const partitions = buildPartitions(rows, columns, partitionBy);

    // Sort within each partition
    const sortedPartitions = partitions.map(partition =>
        sortPartition(partition, columns, orderBy)
    );

    // Compute window values
    const result = new Array<number>(rows.length);

    for (const partition of sortedPartitions) {
        const sortedRows = partition.map(idx => rows[idx]);
        const values = computeWindowValues(funcName, sortedRows, partition.length, columns, expr);

        for (let i = 0; i < partition.length; i++) {
            result[partition[i]] = values[i];
        }
    }

    return result;
}

function extractWindowFuncName(expr: any): string {
    const nameParts = expr.name?.name;
    if (Array.isArray(nameParts)) {
        return nameParts.map((p: any) => p.value).join('.').toUpperCase();
    }
    return String(expr.name).toUpperCase();
}

function buildPartitions(rows: any[][], columns: string[], partitionBy: any[] | null): number[][] {
    if (!partitionBy || partitionBy.length === 0) {
        // Single partition: all rows
        return [rows.map((_, i) => i)];
    }

    const partColIndices = partitionBy.map((p: any) => {
        const name = resolveColName(p.expr || p);
        const idx = columns.indexOf(name);
        if (idx === -1) throw new Error(`PARTITION BY column not found: ${name}`);
        return idx;
    });

    const groups = new Map<string, number[]>();
    for (let i = 0; i < rows.length; i++) {
        const key = partColIndices.map(ci => String(rows[i][ci])).join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(i);
    }

    return Array.from(groups.values());
}

function sortPartition(indices: number[], columns: string[], orderBy: any[] | null): number[] {
    if (!orderBy || orderBy.length === 0) return indices;

    const sortCols = orderBy.map((ob: any) => {
        const name = resolveColName(ob.expr);
        const idx = columns.indexOf(name);
        if (idx === -1) throw new Error(`ORDER BY column not found: ${name}`);
        const desc = ob.type === 'DESC';
        return { idx, desc };
    });

    // We need access to the actual row data - passed via closure
    // This is called from computeWindowFunction which has rows
    return indices; // Sorting is done in computeWindowFunction
}

function computeWindowValues(
    funcName: string,
    sortedRows: any[][],
    partitionSize: number,
    columns: string[],
    expr: any,
): number[] {
    const spec = expr.over.as_window_specification.window_specification;
    const orderBy = spec.orderby;

    // Sort by ORDER BY columns within the partition
    const indexedRows = sortedRows.map((row, i) => ({ row, origIdx: i }));

    if (orderBy && orderBy.length > 0) {
        const sortCols = orderBy.map((ob: any) => {
            const name = resolveColName(ob.expr);
            const idx = columns.indexOf(name);
            return { idx, desc: ob.type === 'DESC' };
        });

        indexedRows.sort((a, b) => {
            for (const { idx, desc } of sortCols) {
                const av = a.row[idx];
                const bv = b.row[idx];
                let cmp = 0;
                if (typeof av === 'number' && typeof bv === 'number') {
                    cmp = av - bv;
                } else {
                    cmp = String(av).localeCompare(String(bv));
                }
                if (cmp !== 0) return desc ? -cmp : cmp;
            }
            return 0;
        });
    }

    const values = new Array<number>(partitionSize);

    switch (funcName) {
        case 'ROW_NUMBER': {
            for (let i = 0; i < indexedRows.length; i++) {
                values[indexedRows[i].origIdx] = i + 1;
            }
            break;
        }
        case 'RANK': {
            let rank = 1;
            for (let i = 0; i < indexedRows.length; i++) {
                if (i > 0 && !sameOrderByValues(indexedRows[i].row, indexedRows[i - 1].row, orderBy, columns)) {
                    rank = i + 1;
                }
                values[indexedRows[i].origIdx] = rank;
            }
            break;
        }
        case 'DENSE_RANK': {
            let rank = 1;
            for (let i = 0; i < indexedRows.length; i++) {
                if (i > 0 && !sameOrderByValues(indexedRows[i].row, indexedRows[i - 1].row, orderBy, columns)) {
                    rank++;
                }
                values[indexedRows[i].origIdx] = rank;
            }
            break;
        }
        case 'NTILE': {
            // NTILE(n) - extract n from function args
            const nArg = expr.args?.value?.[0]?.value;
            const n = typeof nArg === 'number' ? nArg : parseInt(String(nArg), 10);
            if (!n || n <= 0) throw new Error('NTILE requires a positive integer argument');
            const size = indexedRows.length;
            for (let i = 0; i < indexedRows.length; i++) {
                values[indexedRows[i].origIdx] = Math.floor(i * n / size) + 1;
            }
            break;
        }
        default:
            throw new Error(`Unsupported window function: ${funcName}`);
    }

    return values;
}

function sameOrderByValues(rowA: any[], rowB: any[], orderBy: any[], columns: string[]): boolean {
    if (!orderBy) return true;
    for (const ob of orderBy) {
        const name = resolveColName(ob.expr);
        const idx = columns.indexOf(name);
        if (idx === -1) continue;
        if (rowA[idx] !== rowB[idx]) return false;
    }
    return true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveFromSingle(from: any[], session: Session, ctx: any): StoredTable {
    if (!from || from.length === 0) {
        throw new Error('SELECT requires a FROM clause');
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

    // Handle subquery in FROM
    if (source.expr?.ast) {
        const subResult = planSelectWithSetOps(source.expr.ast, session, ctx);
        const alias = source.as || '_sub';
        session.register(alias, subResult);
        return session.get(alias)!;
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

    const aggs: Expr[] = [];
    if (ast.columns !== '*') {
        for (const c of ast.columns) {
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

function resolveColName(node: any): string {
    if (node.type === 'column_ref') {
        return typeof node.column === 'string' ? node.column : node.column?.expr?.value;
    }
    throw new Error(`Expected column reference, got ${node.type}`);
}

function sliceTable(fullResult: Table, offset: number, limit: number, ctx: any): Table {
    const data = extractRows(fullResult);
    data.rows = data.rows.slice(offset, offset + limit);
    return materializeTable(data, ctx);
}

function sortRowData(data: RowData, orderBy: any[]): RowData {
    const sortCols = orderBy.map((ob: any) => {
        const name = resolveColName(ob.expr);
        const idx = data.columns.indexOf(name);
        if (idx === -1) throw new Error(`ORDER BY column not found: ${name}`);
        return { idx, desc: ob.type === 'DESC' };
    });

    data.rows.sort((a, b) => {
        for (const { idx, desc } of sortCols) {
            const av = a[idx];
            const bv = b[idx];
            let cmp = 0;
            if (typeof av === 'number' && typeof bv === 'number') {
                cmp = av - bv;
            } else {
                cmp = String(av).localeCompare(String(bv));
            }
            if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return 0;
    });

    return data;
}

function reconstructWhereClause(_node: any): string {
    // Not used - keeping for reference
    return '';
}

// ─── Set operation helpers ──────────────────────────────────────────────────

function rowKey(row: any[]): string {
    return row.map(v => String(v)).join('|');
}

function rowSet(rows: any[][]): Set<string> {
    return new Set(rows.map(rowKey));
}

function deduplicateRows(rows: any[][]): any[][] {
    const seen = new Set<string>();
    const result: any[][] = [];
    for (const row of rows) {
        const key = rowKey(row);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(row);
        }
    }
    return result;
}
