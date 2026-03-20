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
npm run clean              # Remove build/, dist/, and vendor/teide/
npm run sync-vendor        # Clone vendor/teide from GitHub (skips if present)
npm run repl               # Start web REPL server (http://127.0.0.1:3141)
node bin/teide.js          # Same as above, opens browser automatically
```

The `install` script runs `sync-vendor` + native compile automatically on `npm install`.

### Web REPL

```bash
npm run build              # Build first (native + TypeScript + copy ui.html)
npm run repl               # Start server without auto-open
node bin/teide.js          # Start server and open browser
```

The web REPL serves a browser-based SQL console at `http://127.0.0.1:3141` (auto-increments port if busy). Use `.load <file.csv>` to load data, then query with SQL. See `.help` for all commands.

Requires: CMake ≥ 3.15, a C17/C++17 compiler, Node.js ≥ 18, git (for vendor sync).

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

### Graph Execution Pipeline

Graph operations bypass the lazy Query builder and execute directly:

1. **Build** (TypeScript): User calls `Graph.expand()`, `Graph.varExpand()`, etc. with a `Rel` and parameters.
2. **Dispatch** (V8 thread): The call is routed through `dispatch_sync()`/`dispatch_async()` to the Teide thread.
3. **Execute** (Teide thread): `ExecuteGraphOp()` creates a `td_graph_t`, builds an op tree (e.g., `td_scan` → `td_expand`), runs `td_optimize` + `td_execute`, frees the graph.
4. **Return**: Result wrapped in `NativeTable` → TypeScript `Table`.

CSR relationships (`Rel`) must be built first from an edge table or loaded from disk. `Rel` objects are reusable across multiple graph operations.

### Zero-Copy Data Access

`NativeSeries` exposes C heap memory directly as JS TypedArrays via `napi_create_external_typed_array`. No data is copied. The `heap_alive_` atomic flag prevents use-after-free when GC runs Series destructors after heap teardown.

### SQL Execution Pipeline

The SQL engine runs in TypeScript (no C++ changes), using `node-sql-parser` for parsing and a custom PGQ pre-parser for graph/vector DDL.

1. **PGQ Pre-parse** (`lib/sql/pgq-parser.ts`): Intercepts CREATE/DROP PROPERTY GRAPH, CREATE/DROP VECTOR INDEX, and GRAPH_TABLE references before standard SQL parsing.
2. **Parse** (`lib/sql/parser.ts`): `node-sql-parser` produces an AST.
3. **Plan** (`lib/sql/planner.ts`): Routes by statement type. Simple SELECTs compile to Teide Query/Expr trees and execute via the native C++ path. JOINs, window functions, set operations, and DML use a JS-level row-oriented evaluator with CSV round-trip materialization (`lib/sql/js-table.ts`).
4. **Session** (`lib/sql/session.ts`): In-memory table registry with graph catalog and vector index registry.

The JS-level row evaluator (`materializeTable`) round-trips through temp CSV files to create native Tables. This is a known performance limitation pending C++ table-from-data bindings.

### Low-Level Data API

Vector, Atom, List, and Selection classes provide direct access to Teide C data structures without the lazy Query builder:

1. **Create** (TypeScript): User calls a static factory like `Vector.newSync(ctx, 'f64', 10)`.
2. **Dispatch** (V8 thread): The call routes through `dispatch_sync()` to the Teide thread.
3. **Execute** (Teide thread): Calls the corresponding `td_vec_*`, `td_list_*`, or `td_sel_*` C function.
4. **Return**: Result wrapped in `NativeVector`/`NativeAtom`/`NativeList`/`NativeSelection` with `heap_alive_` guard.

These classes own their `td_t*` pointers and follow the same `td_retain()`/`td_release()` lifecycle as NativeTable and NativeSeries.

### C++ Header Inclusion Order (Critical)

`src/compat.h` provides a C-atomic shim (`_Atomic(T)` → `volatile T` + GCC builtins) so C17 Teide headers compile in C++ mode. **NAPI and C++ standard headers must be included before `compat.h`** to avoid `<atomic>` / `<stdatomic.h>` conflicts.

## Key File Locations

| Layer | Path | Purpose |
|-------|------|---------|
| TS API | `lib/context.ts` | Entry point; CSV/binary I/O, splayed/parted table persistence, symbol table access, `graph()` factory |
| TS API | `lib/query.ts` | Lazy query builder: filter, sort, head, tail, distinct, select, project, join, window, windowJoin |
| TS API | `lib/expr.ts` | Expression tree (column refs, literals, ops, aggregations) |
| TS API | `lib/table.ts` | Table + GroupBy wrappers, static fromArrays factories, low-level table builder |
| TS API | `lib/series.ts` | Column accessor with dtype-aware TypedArray resolution |
| TS API | `lib/types.ts` | Window function, join, and windowJoin type definitions |
| TS API | `lib/vector.ts` | Vector wrapper: low-level td_vec_* operations |
| TS API | `lib/atom.ts` | Atom wrapper: scalar type constructors (bool, i64, f64, sym, etc.) |
| TS API | `lib/list.ts` | List wrapper: heterogeneous td_list_* container |
| TS API | `lib/selection.ts` | Selection wrapper: td_sel_* boolean mask operations |
| TS API | `lib/rel.ts` | Rel (CSR relationship) lifecycle: fromEdges, build, save, load, mmap |
| TS API | `lib/graph.ts` | Graph traversal: expand, varExpand, shortestPath, wcoJoin |
| NAPI | `src/teide_thread.h` | Background thread + SPSC work queue |
| NAPI | `src/context.cpp` | NativeContext: CSV, splayed, partitioned, column, symbol, and metadata I/O dispatch |
| NAPI | `src/query.cpp` | Expression serialization (binop, unop, agg, naryop, cast, dateop), plan compilation & execution |
| NAPI | `src/table.cpp` | NativeTable: column access, retain/release, fromArrays, low-level builder |
| NAPI | `src/series.cpp` | NativeSeries: zero-copy TypedArray creation |
| NAPI | `src/vector.cpp` | NativeVector: vector create, append, set, get, slice, concat |
| NAPI | `src/atom.cpp` | NativeAtom: scalar atom constructors |
| NAPI | `src/list.cpp` | NativeList: heterogeneous list container |
| NAPI | `src/selection.cpp` | NativeSelection: boolean mask / selection set |
| NAPI | `src/compat.h` | C-atomic shim for C++/C17 interop |
| NAPI | `src/rel.cpp` | NativeRel: CSR relationship wrapper |
| NAPI | `src/graph_ops.cpp` | Graph operations: expand, var_expand, shortest_path, wco_join |
| NAPI | `src/addon.cpp` | Module init, exports `collectSync`/`collect` |
| Scripts | `scripts/sync-vendor.sh` | Vendor auto-sync: shallow-clone Teide C core from GitHub |
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
| Web REPL | `lib/repl/server.ts` | HTTP + WebSocket server: query execution, autocomplete, dot-commands, metadata |
| Web REPL | `lib/repl/ui.html` | Self-contained HTML UI: CodeMirror 6, virtual-scroll table, database console layout |
| Web REPL | `lib/repl/protocol.ts` | WebSocket message types (client↔server) |
| Web REPL | `lib/repl/serialize.ts` | Table → JSON serialization for WebSocket results |
| Web REPL | `lib/repl/autocomplete.ts` | Server-side SQL autocomplete with fuzzy matching |
| Web REPL | `lib/repl/formatter.ts` | Cell value extraction (`getCellValue`, `isNumericType`) |
| Web REPL | `lib/repl/history.ts` | Persistent query history (~/.teidedb_history) |
| Web REPL | `lib/repl/theme.ts` | Shared color palette constants |
| Tests | `test/*.test.ts` | Vitest: smoke, table, expr, e2e, io, low-level, query-extended, table-builder, graph |
| Tests | `test/sql/*.test.ts` | SQL engine tests: select, join, dml, pgq, vector |
| Tests | `test/repl/*.test.ts` | REPL tests: theme, history, formatter, protocol, serialize, autocomplete |
| Fixtures | `test/fixtures/` | CSV test data (`small.csv`, `sales.csv`, `customers.csv`, `orders.csv`, `nodes.csv`, `edges.csv`, `trades.csv`, `quotes.csv`) |
| Config | `vitest.config.ts` | Test config: pool=forks, maxForks=4 (required for native addon) |

## Conventions

- **TypeScript**: camelCase methods, fluent/chainable Query API, options objects (`{ descending?: boolean }`), `Symbol.dispose` for Context cleanup.
- **Expression opcodes**: Aggregation opcodes in `lib/expr.ts` must match C defines in `vendor/teide/include/teide/td.h` (e.g., `OP_SUM=50`, `OP_AVG=55`).
- **NAPI classes**: Inherit `Napi::ObjectWrap<T>`, register via `DefineClass()`. Use `Napi::External<T>` for opaque C pointers.
- **Memory**: `td_retain()`/`td_release()` for table/column lifetime; `td_rel_free()` for CSR relationships. Both skip cleanup if `heap_alive_` is false.
- **Graph opcodes**: Graph opcodes in `lib/graph.ts` direction constants must match C defines: `TD_DIR_FWD=0`, `TD_DIR_REV=1`, `TD_DIR_BOTH=2`.
- **Expression kinds**: `ExprKind` union covers `col | lit | binop | unop | agg | alias | naryop | cast | dateop`. N-ary ops serialize an `args` vector; cast serializes a `target_type`; dateop serializes a `date_field`.
- **Window function kinds**: Integer mapping in `src/query.cpp` (rowNumber=0 through nthValue=13) must stay in sync with `WindowFuncKind` in `lib/types.ts`.
- **Join type codes**: 0=inner, 1=left, 2=full — used in both `lib/query.ts` and `src/query.cpp`.
- **Vendor sync**: `vendor/teide/` is auto-synced from GitHub via `scripts/sync-vendor.sh`. Run `npm run clean` to force re-sync.
- **Addon path**: Loaded at runtime from `build/Release/teidedb_addon.node` (relative to `dist/`).
- **SQL parsing**: Two-stage: `pgq-parser.ts` intercepts non-standard SQL (graph DDL, vector index DDL, GRAPH_TABLE) via regex before `node-sql-parser` handles standard SQL. New non-standard SQL extensions should follow this pre-parser pattern.
- **Runtime dependency**: `node-sql-parser` for SQL parsing in the SQL engine layer.
- **Web REPL**: `lib/repl/ui.html` is a self-contained HTML page (CSS + JS inlined, CDN imports for CodeMirror 6 and Font Awesome 6). The `build:ts` script copies it to `dist/repl/ui.html`. Server injects version via `__VERSION__` placeholder replacement (`replaceAll`). Uses teidelum color theme (#0e1b24 navy palette).
- **Test runner**: Must use `pool: 'forks'` in vitest (configured in `vitest.config.ts`) — worker threads cause native addon heap corruption. Max 4 forks to avoid CPU saturation.
- **Runtime dependency**: `ws` for WebSocket server in the web REPL layer.
