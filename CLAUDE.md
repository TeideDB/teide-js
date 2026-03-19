# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

teidedb — zero-copy Node.js NAPI bindings for the Teide columnar dataframe engine. Three-layer architecture: TypeScript API (`lib/`) → C++17 NAPI addon (`src/`) → vendored C17 core (`vendor/teide/`).

## Build & Test Commands

```bash
npm run build              # Full build: native addon (debug) + TypeScript
npm run build:native       # Native addon only (debug)
npm run build:native:release  # Native addon with -O3 optimizations
npm run build:ts           # TypeScript compilation only
npm test                   # Run all tests (vitest run)
npx vitest run test/smoke.test.ts  # Run a single test file
npx vitest run test/sql/           # Run all SQL engine tests
npm run clean              # Remove build/ and dist/
```

Requires: CMake ≥ 3.15, a C17/C++17 compiler, Node.js ≥ 18.

## Architecture

### Threading Model

A dedicated **Teide thread** owns the C heap and runs all Teide operations. The V8/main thread never calls Teide C APIs directly — it posts work items to the Teide thread via an SPSC queue.

- **Sync path**: `dispatch_sync()` blocks the V8 thread on a condition variable until the Teide thread completes.
- **Async path**: `dispatch_async()` uses `napi_threadsafe_function` to resolve a JS Promise from the Teide thread.
- **Shutdown**: Posting a sentinel causes the Teide thread to clean up (`td_pool_destroy`, `td_sym_destroy`, `td_heap_destroy`) and exit.

### Query Execution Pipeline

1. **Build** (TypeScript, lazy): User constructs `Expr` trees and `Query` operation stacks — no execution.
2. **Serialize** (V8 thread): `collect()`/`collectSync()` serializes JS `Expr` objects to C++ `ExprNode` trees and ops to `PlanStep` vectors. This crosses the thread boundary safely (no V8 pointers).
3. **Compile** (Teide thread): `EmitExpr()` walks `ExprNode` → Teide graph DAG.
4. **Execute** (Teide thread): `ExecutePlan()` runs against the table.
5. **Return**: Result wrapped in `NativeTable` → TypeScript `Table`, with zero-copy `Series` accessors.

### Zero-Copy Data Access

`NativeSeries` exposes C heap memory directly as JS TypedArrays via `napi_create_external_typed_array`. No data is copied. The `heap_alive_` atomic flag prevents use-after-free when GC runs Series destructors after heap teardown.

### SQL Execution Pipeline

The SQL engine runs in TypeScript (no C++ changes), using `node-sql-parser` for parsing and a custom PGQ pre-parser for graph/vector DDL.

1. **PGQ Pre-parse** (`lib/sql/pgq-parser.ts`): Intercepts CREATE/DROP PROPERTY GRAPH, CREATE/DROP VECTOR INDEX, and GRAPH_TABLE references before standard SQL parsing.
2. **Parse** (`lib/sql/parser.ts`): `node-sql-parser` produces an AST.
3. **Plan** (`lib/sql/planner.ts`): Routes by statement type. Simple SELECTs compile to Teide Query/Expr trees and execute via the native C++ path. JOINs, window functions, set operations, and DML use a JS-level row-oriented evaluator with CSV round-trip materialization (`lib/sql/js-table.ts`).
4. **Session** (`lib/sql/session.ts`): In-memory table registry with graph catalog and vector index registry.

The JS-level row evaluator (`materializeTable`) round-trips through temp CSV files to create native Tables. This is a known performance limitation pending C++ table-from-data bindings.

### C++ Header Inclusion Order (Critical)

`src/compat.h` provides a C-atomic shim (`_Atomic(T)` → `volatile T` + GCC builtins) so C17 Teide headers compile in C++ mode. **NAPI and C++ standard headers must be included before `compat.h`** to avoid `<atomic>` / `<stdatomic.h>` conflicts.

## Key File Locations

| Layer | Path | Purpose |
|-------|------|---------|
| TS API | `lib/context.ts` | Entry point; loads `.node` addon, wraps `NativeContext` |
| TS API | `lib/query.ts` | Lazy query builder with operation stack |
| TS API | `lib/expr.ts` | Expression tree (column refs, literals, ops, aggregations) |
| TS API | `lib/table.ts` | Table + GroupBy wrappers |
| TS API | `lib/series.ts` | Column accessor with dtype-aware TypedArray resolution |
| NAPI | `src/teide_thread.h` | Background thread + SPSC work queue |
| NAPI | `src/context.cpp` | NativeContext: CSV I/O dispatch |
| NAPI | `src/query.cpp` | Expression serialization, plan compilation & execution |
| NAPI | `src/table.cpp` | NativeTable: column access, retain/release |
| NAPI | `src/series.cpp` | NativeSeries: zero-copy TypedArray creation |
| NAPI | `src/compat.h` | C-atomic shim for C++/C17 interop |
| NAPI | `src/addon.cpp` | Module init, exports `collectSync`/`collect` |
| C Core | `vendor/teide/include/teide/td.h` | Teide public API + type/opcode definitions |
| SQL Engine | `lib/sql/session.ts` | Session: in-memory table registry |
| SQL Engine | `lib/sql/parser.ts` | SQL parsing via node-sql-parser |
| SQL Engine | `lib/sql/planner.ts` | SQL planner: AST to execution (core logic) |
| SQL Engine | `lib/sql/expr.ts` | AST expression to Teide Expr compilation |
| SQL Engine | `lib/sql/functions.ts` | SQL function registry (math, aggregates) |
| SQL Engine | `lib/sql/js-table.ts` | Row extraction and CSV round-trip materialization |
| SQL Engine | `lib/sql/pgq-parser.ts` | PGQ pre-parser for graph/vector DDL |
| SQL Engine | `lib/sql/pgq.ts` | Property graph: CSR, MATCH, graph algorithms |
| SQL Engine | `lib/sql/graph-catalog.ts` | Graph catalog with invalidation on table mutation |
| SQL Engine | `lib/sql/vector.ts` | Vector similarity, HNSW index, KNN fast-path |
| SQL Engine | `lib/sql/index.ts` | SQL module barrel exports |
| Tests | `test/*.test.ts` | Vitest: smoke, table, expr (unit), e2e |
| Tests | `test/sql/*.test.ts` | SQL engine tests: select, join, dml, pgq, vector |
| Fixtures | `test/fixtures/` | CSV test data (`small.csv`, `sales.csv`, `customers.csv`, `orders.csv`) |

## Conventions

- **TypeScript**: camelCase methods, fluent/chainable Query API, options objects (`{ descending?: boolean }`), `Symbol.dispose` for Context cleanup.
- **Expression opcodes**: Aggregation opcodes in `lib/expr.ts` must match C defines in `vendor/teide/include/teide/td.h` (e.g., `OP_SUM=50`, `OP_AVG=55`).
- **NAPI classes**: Inherit `Napi::ObjectWrap<T>`, register via `DefineClass()`. Use `Napi::External<T>` for opaque C pointers.
- **Memory**: `td_retain()`/`td_release()` for C object lifetime; skip release if `heap_alive_` is false.
- **Addon path**: Loaded at runtime from `build/Release/teidedb_addon.node` (relative to `dist/`).
- **SQL parsing**: Two-stage: `pgq-parser.ts` intercepts non-standard SQL (graph DDL, vector index DDL, GRAPH_TABLE) via regex before `node-sql-parser` handles standard SQL. New non-standard SQL extensions should follow this pre-parser pattern.
- **Runtime dependency**: `node-sql-parser` for SQL parsing in the SQL engine layer.
