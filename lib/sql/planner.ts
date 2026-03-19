import { Expr, col, lit } from '../expr';
import { Table } from '../table';
import { Query } from '../query';
import { Session, StoredTable } from './session';
import { compileExpr, containsAggregate } from './expr';
import { parse } from './parser';
import { extractRows, materializeTable, RowData } from './js-table';
import { parsePgq } from './pgq-parser';
import { executeGraphTable, executeGraphAlgorithm } from './pgq';
import { detectKnnQuery, hnswSearch, computeVectorSimilarity, parseVector, KnnQuery } from './vector';
import path from 'path';

const addon = require(path.join(__dirname, '..', '..', 'build', 'Release', 'teidedb_addon.node'));

export function planAndExecuteSync(sql: string, session: Session, ctx: any): Table | null {
    // PGQ pre-parser: intercept graph DDL and GRAPH_TABLE before standard SQL parsing
    const pgqResult = parsePgq(sql);
    if (pgqResult) {
        return handlePgqResult(pgqResult, session, ctx);
    }

    const ast = parse(sql);
    switch (ast.type) {
        case 'select':
            return planSelectWithSetOps(ast, session, ctx);
        case 'create':
            return planCreate(ast, session, ctx);
        case 'drop':
            return planDrop(ast, session);
        case 'insert':
            return planInsert(ast, session, ctx);
        case 'update':
            return planUpdate(ast, session, ctx);
        case 'delete':
            return planDelete(ast, session, ctx);
        default:
            throw new Error(`Unsupported SQL statement type: ${ast.type}`);
    }
}

function handlePgqResult(pgq: any, session: Session, ctx: any): Table | null {
    switch (pgq.type) {
        case 'create_property_graph':
            session.graphCatalog.createGraph(pgq, session);
            return null;
        case 'drop_property_graph':
            session.graphCatalog.dropGraph(pgq);
            return null;
        case 'create_vector_index': {
            const stored = session.get(pgq.tableName);
            if (!stored) throw new Error(`Table not found: ${pgq.tableName}`);
            const data = extractRows(stored.table);
            const colIdx = data.columns.indexOf(pgq.columnName);
            if (colIdx === -1) throw new Error(`Column not found: ${pgq.columnName}`);
            const vectors = data.rows.map(row => parseVector(row[colIdx]));
            session.vectorIndexes.create(pgq.name, pgq.tableName, pgq.columnName, vectors, pgq.metric, pgq.m, pgq.efConstruction);
            return null;
        }
        case 'drop_vector_index': {
            if (!session.vectorIndexes.has(pgq.name) && !pgq.ifExists) {
                throw new Error(`Vector index not found: ${pgq.name}`);
            }
            session.vectorIndexes.drop(pgq.name);
            return null;
        }
        case 'graph_table_rewrite': {
            // Execute each GRAPH_TABLE reference and register as temp table
            for (let i = 0; i < pgq.graphTableRefs.length; i++) {
                const ref = pgq.graphTableRefs[i];
                const alias = `_gt${i + 1}`;
                const table = executeGraphTable(ref, session.graphCatalog, session, ctx);
                session.register(alias, table);
            }
            // Parse and execute the rewritten SQL (with temp table refs)
            const ast = parse(pgq.rewritten);
            return planSelectWithSetOps(ast, session, ctx);
        }
        default:
            throw new Error(`Unknown PGQ result type: ${pgq.type}`);
    }
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

    // Check for KNN fast-path: ORDER BY similarity_func(...) LIMIT k
    const knnQuery = detectKnnQuery(ast);
    if (knnQuery) {
        return planKnnSelect(knnQuery, ast, session, ctx);
    }

    // Check for vector function in SELECT (not KNN - just computing similarity)
    const hasVectorFunc = ast.columns !== '*' &&
        ast.columns.some((c: any) => isVectorFunctionCall(c.expr));
    if (hasVectorFunc && !hasJoin && !hasSubquery && !hasWindowFn) {
        return planVectorSelect(ast, session, ctx);
    }

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

    // Compute window values
    const result = new Array<number>(rows.length);

    for (const partition of partitions) {
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

// ─── Vector similarity planning ─────────────────────────────────────────────

function isVectorFunctionCall(node: any): boolean {
    if (!node || node.type !== 'function') return false;
    const name = extractFunctionName(node).toUpperCase();
    return name === 'COSINE_SIMILARITY' || name === 'EUCLIDEAN_DISTANCE';
}

function planVectorSelect(ast: any, session: Session, ctx: any): Table {
    const stored = resolveFromSingle(ast.from, session, ctx);
    const data = extractRows(stored.table);

    const resultColumns: string[] = [];
    const resultColData: any[][] = [];

    for (const c of ast.columns) {
        if (isVectorFunctionCall(c.expr)) {
            const { columnName, queryVector, metric } = extractVectorFuncInfo(c.expr);
            const similarities = computeVectorSimilarity(data.rows, data.columns, columnName, queryVector, metric);
            resultColumns.push(c.as || `${metric}_similarity`);
            resultColData.push(similarities);
        } else if (c.expr.type === 'column_ref') {
            const colName = resolveColName(c.expr);
            const colIdx = data.columns.indexOf(colName);
            if (colIdx === -1) throw new Error(`Column not found: ${colName}`);
            resultColumns.push(c.as || colName);
            resultColData.push(data.rows.map(row => row[colIdx]));
        } else if (c.expr.type === 'star') {
            for (let ci = 0; ci < data.columns.length; ci++) {
                resultColumns.push(data.columns[ci]);
                resultColData.push(data.rows.map(row => row[ci]));
            }
        } else {
            throw new Error('Unsupported expression in vector SELECT');
        }
    }

    const nRows = data.rows.length;
    const resultRows: any[][] = [];
    for (let i = 0; i < nRows; i++) {
        resultRows.push(resultColData.map(col => col[i]));
    }

    let result: RowData = { columns: resultColumns, rows: resultRows };

    if (ast.orderby) {
        result = sortRowData(result, ast.orderby);
    }

    if (ast.limit) {
        const limitVal = ast.limit.value;
        if (limitVal.length === 1) {
            result.rows = result.rows.slice(0, limitVal[0].value);
        }
    }

    return materializeTable(result, ctx);
}

function planKnnSelect(knn: KnnQuery, ast: any, session: Session, ctx: any): Table {
    const stored = session.get(knn.tableName);
    if (!stored) throw new Error(`Table not found: ${knn.tableName}`);

    const data = extractRows(stored.table);

    // Check for HNSW index
    const index = session.vectorIndexes.findIndex(knn.tableName, knn.columnName, knn.metric);

    let topKIndices: number[];
    let topKDistances: number[];

    if (index) {
        // Use HNSW index for approximate KNN
        const results = hnswSearch(index, knn.queryVector, knn.k);
        topKIndices = results.map(r => r.rowIndex);
        topKDistances = results.map(r => knn.metric === 'cosine' ? 1 - r.distance : r.distance);
    } else {
        // Brute-force KNN: compute all similarities, sort, take top k
        const similarities = computeVectorSimilarity(
            data.rows, data.columns, knn.columnName, knn.queryVector, knn.metric,
        );

        const indexed = similarities.map((s, i) => ({ score: s, idx: i }));
        if (knn.metric === 'cosine') {
            indexed.sort((a, b) => b.score - a.score); // DESC for cosine
        } else {
            indexed.sort((a, b) => a.score - b.score); // ASC for euclidean
        }

        const topK = indexed.slice(0, knn.k);
        topKIndices = topK.map(t => t.idx);
        topKDistances = topK.map(t => t.score);
    }

    // Build result with selected columns
    const resultColumns: string[] = [];
    const resultRows: any[][] = [];

    // Determine which columns to include
    const selectCols = knn.selectColumns;
    const colSpecs: { name: string; type: 'regular' | 'vector_func'; colIdx?: number; metric?: 'cosine' | 'euclidean' }[] = [];

    if (selectCols === '*') {
        for (let ci = 0; ci < data.columns.length; ci++) {
            colSpecs.push({ name: data.columns[ci], type: 'regular', colIdx: ci });
        }
    } else {
        for (const c of selectCols) {
            if (isVectorFunctionCall(c.expr)) {
                const info = extractVectorFuncInfo(c.expr);
                colSpecs.push({ name: c.as || `${info.metric}_result`, type: 'vector_func', metric: info.metric });
            } else if (c.expr.type === 'column_ref') {
                const colName = resolveColName(c.expr);
                const colIdx = data.columns.indexOf(colName);
                if (colIdx === -1) throw new Error(`Column not found: ${colName}`);
                colSpecs.push({ name: c.as || colName, type: 'regular', colIdx });
            } else if (c.expr.type === 'star') {
                for (let ci = 0; ci < data.columns.length; ci++) {
                    colSpecs.push({ name: data.columns[ci], type: 'regular', colIdx: ci });
                }
            }
        }
    }

    for (const spec of colSpecs) {
        resultColumns.push(spec.name);
    }

    for (let i = 0; i < topKIndices.length; i++) {
        const rowIdx = topKIndices[i];
        const row: any[] = [];
        for (const spec of colSpecs) {
            if (spec.type === 'regular') {
                row.push(data.rows[rowIdx][spec.colIdx!]);
            } else {
                row.push(topKDistances[i]);
            }
        }
        resultRows.push(row);
    }

    return materializeTable({ columns: resultColumns, rows: resultRows }, ctx);
}

function extractVectorFuncInfo(node: any): { columnName: string; queryVector: number[]; metric: 'cosine' | 'euclidean' } {
    const funcName = extractFunctionName(node).toUpperCase();
    const metric: 'cosine' | 'euclidean' = funcName === 'COSINE_SIMILARITY' ? 'cosine' : 'euclidean';
    const args = node.args?.value;
    if (!args || args.length !== 2) throw new Error(`${funcName} requires exactly 2 arguments`);

    const colArg = args[0];
    if (colArg.type !== 'column_ref') throw new Error(`${funcName} first argument must be a column reference`);
    const columnName = typeof colArg.column === 'string' ? colArg.column : colArg.column?.expr?.value;

    const vecArg = args[1];
    const queryVector = extractArrayFromArg(vecArg);

    return { columnName, queryVector, metric };
}

function extractArrayFromArg(node: any): number[] {
    if (node?.type === 'expr_list') {
        return node.value.map((v: any) => {
            if (v.type === 'number') return v.value;
            if (v.type === 'unary_expr' && v.operator === '-' && v.expr?.type === 'number') {
                return -v.expr.value;
            }
            throw new Error(`Unexpected value in array literal: ${JSON.stringify(v)}`);
        });
    }
    if (node?.type === 'array') {
        return extractArrayFromArg(node.value);
    }
    throw new Error('Expected array literal as second argument to vector function');
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

// ─── Set operation helpers ──────────────────────────────────────────────────

function rowKey(row: any[]): string {
    return JSON.stringify(row);
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

// ─── DDL: CREATE TABLE / DROP TABLE ─────────────────────────────────────────

function planCreate(ast: any, session: Session, ctx: any): Table | null {
    if (ast.keyword !== 'table') {
        throw new Error(`CREATE ${ast.keyword} not supported`);
    }

    const tableName = ast.table[0].table;
    const ifNotExists = ast.if_not_exists != null;

    if (session.has(tableName) && ifNotExists) {
        return null;
    }
    if (session.has(tableName) && !ifNotExists) {
        throw new Error(`Table already exists: ${tableName}`);
    }

    // CTAS: CREATE TABLE ... AS SELECT ...
    if (ast.query_expr) {
        const result = planSelectWithSetOps(ast.query_expr, session, ctx);
        session.register(tableName, result);
        return null;
    }

    // Schema-only CREATE TABLE: build empty table from column definitions
    if (!ast.create_definitions || ast.create_definitions.length === 0) {
        throw new Error('CREATE TABLE requires column definitions or AS SELECT');
    }

    const columns: string[] = [];
    for (const def of ast.create_definitions) {
        if (def.resource !== 'column') continue;
        const colName = typeof def.column.column === 'string'
            ? def.column.column
            : def.column.column?.expr?.value;
        columns.push(colName);
    }

    if (columns.length === 0) {
        throw new Error('CREATE TABLE requires at least one column');
    }

    // Create an empty table via CSV with just a header row
    const emptyData: RowData = { columns, rows: [] };
    const table = materializeTable(emptyData, ctx);
    session.register(tableName, table);
    return null;
}


function planDrop(ast: any, session: Session): Table | null {
    if (ast.keyword !== 'table') {
        throw new Error(`DROP ${ast.keyword} not supported`);
    }

    const tableName = ast.name[0].table;
    const ifExists = ast.prefix === 'if exists';

    if (!session.has(tableName) && !ifExists) {
        throw new Error(`Table not found: ${tableName}`);
    }

    session.drop(tableName);
    return null;
}

// ─── DML: INSERT, UPDATE, DELETE ────────────────────────────────────────────

function planInsert(ast: any, session: Session, ctx: any): Table | null {
    const tableName = ast.table[0].table;
    const stored = session.get(tableName);
    if (!stored) throw new Error(`Table not found: ${tableName}`);

    const existingData = extractRows(stored.table);
    let newRows: any[][];

    if (ast.values.type === 'select') {
        // INSERT INTO ... SELECT ...
        const selectResult = planSelectWithSetOps(ast.values, session, ctx);
        const selectData = extractRows(selectResult);
        newRows = selectData.rows;

        // If INSERT specifies columns, reorder to match target table
        if (ast.columns) {
            newRows = reorderInsertRows(newRows, ast.columns, selectData.columns, existingData.columns);
        }
    } else {
        // INSERT INTO ... VALUES (...)
        const targetCols = ast.columns || existingData.columns;
        newRows = [];
        for (const valueRow of ast.values.values) {
            const row = buildInsertRow(valueRow.value, targetCols, existingData.columns);
            newRows.push(row);
        }
    }

    const combined: RowData = {
        columns: existingData.columns,
        rows: [...existingData.rows, ...newRows],
    };

    const newTable = materializeTable(combined, ctx);
    session.register(tableName, newTable);
    session.onTableMutated(tableName);
    return null;
}

function buildInsertRow(values: any[], insertCols: string[], tableCols: string[]): any[] {
    const row = new Array(tableCols.length).fill(0);
    for (let i = 0; i < insertCols.length; i++) {
        const colIdx = tableCols.indexOf(insertCols[i]);
        if (colIdx === -1) throw new Error(`Column not found: ${insertCols[i]}`);
        row[colIdx] = evaluateLiteralValue(values[i]);
    }
    return row;
}

function reorderInsertRows(
    rows: any[][],
    insertCols: string[],
    sourceCols: string[],
    targetCols: string[],
): any[][] {
    return rows.map(sourceRow => {
        const targetRow = new Array(targetCols.length).fill(0);
        for (let i = 0; i < insertCols.length; i++) {
            const targetIdx = targetCols.indexOf(insertCols[i]);
            if (targetIdx === -1) throw new Error(`Column not found: ${insertCols[i]}`);
            // Map source column index: if insertCols align with sourceCols by position
            targetRow[targetIdx] = i < sourceRow.length ? sourceRow[i] : 0;
        }
        return targetRow;
    });
}

function evaluateLiteralValue(node: any): any {
    if (!node) return 0;
    switch (node.type) {
        case 'number': return node.value;
        case 'single_quote_string':
        case 'double_quote_string':
        case 'string': return node.value;
        case 'bool': return node.value ? 1 : 0;
        case 'null': return 0;
        default: return node.value ?? 0;
    }
}

function planUpdate(ast: any, session: Session, ctx: any): Table | null {
    const tableName = ast.table[0].table;
    const stored = session.get(tableName);
    if (!stored) throw new Error(`Table not found: ${tableName}`);

    const data = extractRows(stored.table);
    const columns = data.columns;

    // Build set assignments: column index → value expression evaluator
    const assignments: { colIdx: number; valueNode: any }[] = [];
    for (const setItem of ast.set) {
        const colName = setItem.column;
        const colIdx = columns.indexOf(colName);
        if (colIdx === -1) throw new Error(`Column not found: ${colName}`);
        assignments.push({ colIdx, valueNode: setItem.value });
    }

    // Apply UPDATE: for each row, if WHERE matches, apply assignments
    const updatedRows = data.rows.map(row => {
        if (ast.where && !evaluateWhereOnRow(ast.where, row, columns)) {
            return row;
        }
        const newRow = [...row];
        for (const { colIdx, valueNode } of assignments) {
            newRow[colIdx] = evaluateExprOnRow(valueNode, row, columns);
        }
        return newRow;
    });

    const newTable = materializeTable({ columns, rows: updatedRows }, ctx);
    session.register(tableName, newTable);
    session.onTableMutated(tableName);
    return null;
}

function planDelete(ast: any, session: Session, ctx: any): Table | null {
    // DELETE FROM table WHERE ...
    const tableName = ast.from[0].table;
    const stored = session.get(tableName);
    if (!stored) throw new Error(`Table not found: ${tableName}`);

    const data = extractRows(stored.table);
    const columns = data.columns;

    // Keep rows that do NOT match the WHERE condition
    let filteredRows: any[][];
    if (ast.where) {
        filteredRows = data.rows.filter(row => !evaluateWhereOnRow(ast.where, row, columns));
    } else {
        // DELETE without WHERE = delete all rows
        filteredRows = [];
    }

    const newTable = materializeTable({ columns, rows: filteredRows }, ctx);
    session.register(tableName, newTable);
    session.onTableMutated(tableName);
    return null;
}

// ─── JS-level expression evaluator for WHERE/SET on extracted rows ──────────

function evaluateWhereOnRow(node: any, row: any[], columns: string[]): boolean {
    const result = evaluateExprOnRow(node, row, columns);
    return Boolean(result);
}

function evaluateExprOnRow(node: any, row: any[], columns: string[]): any {
    if (!node) return 0;

    switch (node.type) {
        case 'column_ref': {
            const name = typeof node.column === 'string' ? node.column : node.column?.expr?.value;
            const idx = columns.indexOf(name);
            if (idx === -1) throw new Error(`Column not found: ${name}`);
            return row[idx];
        }
        case 'number':
            return node.value;
        case 'single_quote_string':
        case 'double_quote_string':
        case 'string':
            return node.value;
        case 'bool':
            return node.value ? 1 : 0;
        case 'null':
            return null;
        case 'binary_expr':
            return evaluateBinaryOnRow(node, row, columns);
        case 'unary_expr': {
            const inner = evaluateExprOnRow(node.expr, row, columns);
            switch (node.operator) {
                case '-': return -inner;
                case '+': return +inner;
                case 'NOT': return !inner ? 1 : 0;
                default: throw new Error(`Unsupported unary: ${node.operator}`);
            }
        }
        default:
            return evaluateLiteralValue(node);
    }
}

function evaluateBinaryOnRow(node: any, row: any[], columns: string[]): any {
    const op = node.operator;

    if (op === 'AND') {
        return evaluateExprOnRow(node.left, row, columns) && evaluateExprOnRow(node.right, row, columns) ? 1 : 0;
    }
    if (op === 'OR') {
        return evaluateExprOnRow(node.left, row, columns) || evaluateExprOnRow(node.right, row, columns) ? 1 : 0;
    }
    if (op === 'IS') {
        const left = evaluateExprOnRow(node.left, row, columns);
        return (node.right?.type === 'null' && left === null) ? 1 : 0;
    }
    if (op === 'IS NOT') {
        const left = evaluateExprOnRow(node.left, row, columns);
        return (node.right?.type === 'null' && left !== null) ? 1 : 0;
    }
    if (op === 'IN' || op === 'NOT IN') {
        const left = evaluateExprOnRow(node.left, row, columns);
        const values = (node.right.value || []).map((v: any) => evaluateExprOnRow(v, row, columns));
        const found = values.some((v: any) => v === left);
        return (op === 'IN' ? found : !found) ? 1 : 0;
    }
    if (op === 'BETWEEN') {
        const val = evaluateExprOnRow(node.left, row, columns);
        const lo = evaluateExprOnRow(node.right.value[0], row, columns);
        const hi = evaluateExprOnRow(node.right.value[1], row, columns);
        return (val >= lo && val <= hi) ? 1 : 0;
    }
    if (op === 'NOT BETWEEN') {
        const val = evaluateExprOnRow(node.left, row, columns);
        const lo = evaluateExprOnRow(node.right.value[0], row, columns);
        const hi = evaluateExprOnRow(node.right.value[1], row, columns);
        return (val < lo || val > hi) ? 1 : 0;
    }
    if (op === 'LIKE') {
        const left = String(evaluateExprOnRow(node.left, row, columns));
        const pattern = String(evaluateExprOnRow(node.right, row, columns));
        return likeMatch(left, pattern) ? 1 : 0;
    }
    if (op === 'NOT LIKE') {
        const left = String(evaluateExprOnRow(node.left, row, columns));
        const pattern = String(evaluateExprOnRow(node.right, row, columns));
        return !likeMatch(left, pattern) ? 1 : 0;
    }

    const left = evaluateExprOnRow(node.left, row, columns);
    const right = evaluateExprOnRow(node.right, row, columns);

    switch (op) {
        case '=': case '==': return (left === right) ? 1 : 0;
        case '!=': case '<>': return (left !== right) ? 1 : 0;
        case '<': return (left < right) ? 1 : 0;
        case '<=': return (left <= right) ? 1 : 0;
        case '>': return (left > right) ? 1 : 0;
        case '>=': return (left >= right) ? 1 : 0;
        case '+': return Number(left) + Number(right);
        case '-': return Number(left) - Number(right);
        case '*': return Number(left) * Number(right);
        case '/': return Number(left) / Number(right);
        case '%': return Number(left) % Number(right);
        default: throw new Error(`Unsupported binary operator in DML: ${op}`);
    }
}

function likeMatch(value: string, pattern: string): boolean {
    // Convert SQL LIKE pattern to regex: % → .*, _ → .
    const regex = new RegExp(
        '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*')
            .replace(/_/g, '.') + '$',
    );
    return regex.test(value);
}
