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
npm run clean              # Remove build/, dist/, and vendor/teide/
npm run sync-vendor        # Clone vendor/teide from GitHub (skips if present)
```

The `install` script runs `sync-vendor` + native compile automatically on `npm install`.

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
| Tests | `test/*.test.ts` | Vitest: smoke, table, expr, e2e, io, low-level, query-extended, table-builder |
| Fixtures | `test/fixtures/` | CSV test data (`small.csv`, `sales.csv`, `nodes.csv`, `edges.csv`, `orders.csv`, `trades.csv`, `quotes.csv`) |

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
