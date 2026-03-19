# SQL Engine Design for teide-js

**Date:** 2026-03-19
**Status:** Accepted

## Overview

Bring the full SQL functionality from teide-rs to teide-js: SQL parsing, planning, execution, property graph queries (PGQ), graph algorithms, and vector similarity — all implemented in TypeScript with the C++ NAPI layer extended to expose missing Teide C operations.

## Architecture

```
User SQL string
  ↓
PGQ Pre-parser (lib/sql/pgq-parser.ts)   — intercepts graph DDL & GRAPH_TABLE
  ↓
SQL Parser (lib/sql/parser.ts)            — node-sql-parser, standard SQL
  ↓
Planner (lib/sql/planner.ts)              — AST → Teide graph DAG
  ↓
C++ NAPI (src/)                           — extended op bindings
  ↓
Teide C core (vendor/teide/)              — execution
```

The SQL planner builds Teide graph operations directly rather than going through the fluent Query API. Both APIs share the same C++ execution path but diverge at the planning level.

## SQL Feature Scope

### Core SQL
- DDL: CREATE TABLE (schema + CTAS), CREATE OR REPLACE, IF NOT EXISTS, DROP TABLE
- DML: INSERT INTO (VALUES + SELECT), UPDATE (with WHERE), DELETE (with WHERE)
- SELECT: all clauses (WHERE, GROUP BY, HAVING, ORDER BY, LIMIT/OFFSET, DISTINCT)
- JOINs: INNER, LEFT OUTER, CROSS
- Subqueries: scalar, FROM clause, IN/NOT IN, nested
- Set operations: UNION, UNION ALL, EXCEPT, INTERSECT
- Window functions: ROW_NUMBER, RANK, DENSE_RANK, NTILE, windowed aggregates with frame specs

### Scalar Functions (100+)
- Math: ABS, CEIL, FLOOR, SQRT, ROUND, LN, EXP, LEAST, GREATEST
- String: UPPER, LOWER, LENGTH, TRIM, SUBSTR, REPLACE, CONCAT, ||
- Conditional: COALESCE, NULLIF, CASE WHEN, IF
- Date/Time: CURRENT_DATE, NOW, EXTRACT, DATE_TRUNC, DATE_DIFF
- Type: CAST, :: syntax
- Pattern: LIKE, ILIKE, BETWEEN, IN, IS NULL

### Aggregate Functions
- SUM, AVG, MIN, MAX, COUNT, COUNT(DISTINCT)
- STDDEV, STDDEV_SAMP, STDDEV_POP
- VARIANCE, VAR_SAMP, VAR_POP
- All support FILTER clause

### Property Graphs (PGQ)
- CREATE/DROP PROPERTY GRAPH with VERTEX TABLES and EDGE TABLES
- Natural keys (KEY column), label aliases, property visibility (ALL/ONLY/EXCEPT/NONE)
- GRAPH_TABLE() with MATCH patterns in FROM clause
- Node patterns: (var:Label), multi-label OR (Label1|Label2)
- Edge patterns: directed (->/<-), undirected (-), bidirectional (<-..->)
- Quantifiers: {m,n}, +, *
- Path modes: WALK, ANY SHORTEST, ALL SHORTEST
- COST expressions for weighted shortest path (Dijkstra)
- WHERE filters on node/edge properties

### Graph Algorithms
- PAGERANK(graph, node) — PageRank centrality
- COMPONENT(graph, node) / CONNECTED_COMPONENT — connected components
- COMMUNITY(graph, node) / LOUVAIN — community detection
- CLUSTERING_COEFFICIENT(graph, node) — local clustering coefficient
- SHORTEST_DISTANCE(graph, src, dst, weight) / DIJKSTRA — weighted shortest path

### Vector Similarity
- COSINE_SIMILARITY(col, ARRAY[...])
- EUCLIDEAN_DISTANCE(col, ARRAY[...])
- KNN fast-path detection (ORDER BY similarity LIMIT k → td_knn)
- CREATE/DROP VECTOR INDEX ... USING HNSW(M, ef_construction)
- Auto-invalidation on table mutation

## Parser Strategy

### Standard SQL
Use `node-sql-parser` npm package with PostgreSQL dialect. Handles SELECT, INSERT, UPDATE, DELETE, CREATE/DROP TABLE, JOINs, subqueries, window functions, set operations, CASE WHEN, CAST, BETWEEN, IN, LIKE.

### PGQ Pre-parser
Runs first on every SQL string. Lightweight recursive descent parser (~200 lines) that detects:
- CREATE [OR REPLACE] PROPERTY GRAPH [IF NOT EXISTS]
- DROP PROPERTY GRAPH [IF EXISTS]
- DESCRIBE PROPERTY GRAPH
- CREATE/DROP VECTOR INDEX
- GRAPH_TABLE(...) in FROM clauses (rewritten to temp table reference)

If matched, handles directly. Otherwise passes through to node-sql-parser.

### Function Resolution
Parser produces generic FUNCTION_CALL(name, args) nodes. A function registry maps names to Teide opcodes at plan time, handling aliases (LEN→STRLEN, CEILING→CEIL, etc.).

## Planner

### Expression Compilation (lib/sql/expr.ts)
Recursive AST walk emitting graph ops:
- Literals → emitOp(CONST_I64/F64/STR/BOOL, value)
- Column refs → emitOp(SCAN, colIndex) via schema lookup
- Binary ops → compile left + right, emitOp(ADD/EQ/AND/...)
- Function calls → registry lookup, compile args, emit op
- CASE WHEN → chain of emitOp(IF, condition, then, else)
- CAST → emitOp(CAST, expr, targetType)
- Subqueries → recursively plan inner query
- Aggregate detection → flag for GROUP BY handling

### Query Planning (lib/sql/planner.ts)
SELECT planning order:
1. Resolve FROM — table, join, GRAPH_TABLE, or subquery
2. Build column schema map (case-insensitive name → index)
3. Compile WHERE → filter ops
4. Detect aggregates in SELECT/HAVING
5. GROUP BY: compile group keys + aggregate expressions
6. SELECT projection: column picks, computed expressions, aliases
7. HAVING filter (post-aggregation)
8. DISTINCT → dedup op
9. ORDER BY → sort ops (ASC/DESC, NULLS FIRST/LAST)
10. LIMIT/OFFSET → head op

DML: resolve target table from session, compile value expressions, apply mutations, update session state.

## Session State

`Context` owns session state internally:

```ts
interface SessionState {
  tables: Map<string, StoredTable>
  graphs: Map<string, PropertyGraph>
  vectorIndexes: Map<string, VectorIndex>
}

interface StoredTable {
  nativeTable: NativeTable
  columns: string[]
  embeddingDims: Map<string, number>
}
```

### Table Lifecycle
- CREATE TABLE → allocate in Teide, register in session
- CREATE TABLE AS SELECT → execute query, register result
- read_csv('path') in FROM → load CSV, register as anonymous table
- DROP TABLE → release native handle, remove from registry
- INSERT/UPDATE/DELETE → mutate table, invalidate dependent graphs/indexes

### Property Graph Lifecycle
- CREATE PROPERTY GRAPH → validate tables, store definition, build CSR from edge tables
- CSR via Teide's Rel type for O(1) neighbor lookups
- Invalidated on underlying table mutation
- DROP → free CSR, remove from catalog

### Vector Index Lifecycle
- CREATE VECTOR INDEX → build HNSW on embedding column
- Invalidated on table mutation
- DROP → free index

## Context API

```ts
class Context {
  // Existing
  readCsvSync(path: string): Table
  readCsv(path: string): Promise<Table>
  destroy(): void

  // New
  executeSync(sql: string): Table | null   // Table for queries, null for DDL/DML
  execute(sql: string): Promise<Table | null>
}
```

## C++ NAPI Extensions

Expose missing Teide C ops via a graph-builder interface. Rather than wrapping each C function individually, expose `emitOp(opcode, ...args)` which dispatches to the right td_* call on the Teide thread.

### New operations to expose:
- **JOINs:** td_join(), td_window_join()
- **Window:** td_window_op() (ROW_NUMBER/RANK/DENSE_RANK/NTILE), windowed aggregates with frames
- **String:** td_upper, td_lower, td_strlen, td_substr, td_replace, td_trim, td_concat, td_like, td_ilike
- **Date/Time:** td_extract, td_date_trunc
- **Conditional:** td_if
- **Graph:** td_pagerank, td_connected_comp, td_louvain, td_clustering_coeff, td_dijkstra + CSR/Rel exposure
- **Vector:** td_cosine_sim, td_euclidean_dist, td_knn, HNSW build/search
- **Table mutation:** td_materialize for DML results
- **Set ops:** table concat + distinct/diff

## File Layout

```
lib/
├── context.ts              ← extend with execute/executeSync
├── query.ts                ← unchanged (fluent API still works)
├── expr.ts                 ← unchanged
├── table.ts                ← unchanged
├── series.ts               ← unchanged
└── sql/
    ├── index.ts            ← re-exports
    ├── session.ts          ← table/graph/index registry
    ├── parser.ts           ← node-sql-parser wrapper
    ├── pgq-parser.ts       ← PGQ pre-parser (recursive descent)
    ├── pgq.ts              ← graph catalog, CSR, MATCH execution
    ├── planner.ts          ← SQL AST → graph ops
    ├── expr.ts             ← expression compilation
    ├── functions.ts        ← function name → opcode registry
    └── vector.ts           ← vector ops, HNSW, KNN fast-path
src/
    ├── *.cpp/h             ← extend with new op bindings
test/
    └── sql/
        ├── select.test.ts
        ├── join.test.ts
        ├── window.test.ts
        ├── dml.test.ts
        ├── pgq.test.ts
        ├── vector.test.ts
        └── functions.test.ts
```

## Implementation Phases

### Task 1: Core SELECT
- [x] node-sql-parser integration
- [x] Expression compilation (literals, columns, binary ops, functions)
- [x] Planner: WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, DISTINCT
- [x] Function registry (math, string, conditional, date/time)
- [x] Aggregate functions (SUM, AVG, MIN, MAX, COUNT, STDDEV, VARIANCE)
- [x] Session: table registry, executeSync/execute on Context
- [x] Tests for core SELECT functionality

### Task 2: JOINs, Subqueries, Set Ops, Windows
- [x] JOIN planning (INNER, LEFT, CROSS)
- [x] Subquery support (IN, FROM, scalar, nested)
- [x] Set operations (UNION, EXCEPT, INTERSECT)
- [x] Window functions (ROW_NUMBER, RANK, DENSE_RANK, NTILE)
- [x] Tests for JOINs, subqueries, set ops, windows

### Task 3: DDL & DML
- [x] CREATE TABLE (schema definition + CTAS)
- [x] DROP TABLE
- [x] INSERT INTO (VALUES + SELECT)
- [x] UPDATE with WHERE
- [x] DELETE with WHERE
- [x] Tests for DDL & DML

### Task 4: Property Graphs
- [x] PGQ pre-parser
- [x] Property graph catalog + CSR construction
- [x] GRAPH_TABLE with MATCH patterns
- [x] Path traversal (BFS, quantifiers, shortest path)
- [x] Graph algorithms: PageRank, Connected Components, Community, Clustering Coefficient, Dijkstra
- [x] Tests for property graphs

### Task 5: Vector Similarity
- [x] COSINE_SIMILARITY, EUCLIDEAN_DISTANCE
- [x] KNN fast-path detection and rewrite
- [x] HNSW index creation/search/drop
- [x] Auto-invalidation on mutation
- [x] Tests for vector similarity
