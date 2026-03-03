# Full libteide Binding Coverage — Design

## Overview

Close the gap between the libteide C API and teide-js Node.js bindings. Currently ~34% of public C functions are bound (~60-70% of user-facing functionality). This design covers everything missing, organized in 5 incremental phases.

## Approach

Incremental by layer, bottom-up. Each phase is independently shippable and testable.

1. Expression layer — string, date/time, cast, conditional, new aggregations
2. Query layer — tail, distinct, join, window join, window functions, select/project
3. I/O layer — CSV write/opts, splayed/partitioned persistence, column I/O, symbol/metadata persistence
4. Table construction — `Table.fromArrays` high-level factory
5. Low-level APIs — vector, atom, list, selection primitives

---

## Phase 1: Expression Layer

New methods on `Expr` in `lib/expr.ts` + `EmitExpr` handling in `src/query.cpp`.

### String Ops

```typescript
// Unary (new unop kinds)
expr.upper()                    // td_upper
expr.lower()                    // td_lower
expr.strlen()                   // td_strlen
expr.trim()                     // td_trim_op

// Binary (new binop kinds)
expr.like(pattern)              // td_like(g, input, pattern)
expr.ilike(pattern)             // td_ilike(g, input, pattern)

// N-ary (new expression kind 'naryop')
expr.substr(start, len)         // td_substr(g, str, start, len)
expr.replace(from, to)          // td_replace(g, str, from, to)
expr.concat(...others)          // td_concat(g, args[], n)
```

`substr`, `replace`, and `concat` need a new ExprKind `'naryop'` since they take 3+ arguments. The `naryop` node stores `op: string` and `args: Expr[]`.

C++ side: `SerializeExpr` handles `"naryop"` by reading the `args` array. `EmitExpr` dispatches:
- `"substr"` → `td_substr(g, args[0], args[1], args[2])`
- `"replace"` → `td_replace(g, args[0], args[1], args[2])`
- `"concat"` → `td_concat(g, args_ptrs, n)`

### Date/Time Ops

New ExprKind `'dateop'` with `op` (`'extract'`/`'date_trunc'`) and `field` string.

```typescript
expr.extract('year')            // td_extract(g, col, TD_EXTRACT_YEAR)
expr.dateTrunc('month')         // td_date_trunc(g, col, TD_EXTRACT_MONTH)
```

Fields: `'year'`, `'month'`, `'day'`, `'hour'`, `'minute'`, `'second'`, `'dow'`, `'doy'`, `'epoch'`.

C++ side: `EmitExpr` maps field strings to `TD_EXTRACT_*` constants (0-8).

### Conditional + Math

```typescript
expr.cast(type)                 // td_cast(g, a, target_type)
Expr.if(cond, then, else)       // td_if(g, cond, then_val, else_val) — static
expr.min2(other)                // td_min2(g, a, b)
expr.max2(other)                // td_max2(g, a, b)
```

`cast` uses a new ExprKind `'cast'` with `targetType` string mapped to `TD_*` type constants.
`Expr.if` uses the existing `'naryop'` kind with `op: 'if'`.
`min2`/`max2` are standard binops.

### New Aggregations

New opcode constants in `lib/expr.ts` (matching td.h):

```typescript
export const OP_COUNT_DISTINCT = 58;
export const OP_STDDEV = 59;
export const OP_STDDEV_POP = 73;
export const OP_VAR = 74;
export const OP_VAR_POP = 75;

expr.countDistinct()            // OP_COUNT_DISTINCT → td_count_distinct
expr.stddev()                   // OP_STDDEV (sample)
expr.stddevPop()                // OP_STDDEV_POP (population)
expr.variance()                 // OP_VAR (sample)
expr.variancePop()              // OP_VAR_POP (population)
```

C++ side: 5 new cases in the `agg` switch of `EmitExpr`. Note: `td_count_distinct` exists in td.h. `stddev`/`var` opcodes are defined but their graph builder functions may need to use the opcode directly via a generic agg emitter if no dedicated `td_stddev()` function exists — fallback to constructing the op node manually.

### Files Changed

- `lib/expr.ts` — new methods, new opcodes, new ExprKinds
- `src/query.h` — new ExprNode fields (`args` vector for naryop, `target_type` for cast)
- `src/query.cpp` — `SerializeExpr` + `EmitExpr` new branches

---

## Phase 2: Query Layer

New methods on `Query` in `lib/query.ts` + `PlanStep` handling in `src/query.cpp`.

### Simple Structural Ops

```typescript
query.tail(n: number): Query
// PlanStep "tail" → td_tail(g, input, n)

query.distinct(...cols: string[]): Query
// PlanStep "distinct" → td_distinct(g, key_nodes[], n_keys)

query.select(...cols: string[]): Query
// PlanStep "select" → td_select(g, input, scan_nodes[], n)

query.project(...exprs: Expr[]): Query
// PlanStep "project" → td_project(g, input, expr_nodes[], n)
```

### Join

```typescript
query.join(other: Table, opts: {
  on?: string | string[];
  leftOn?: string | string[];
  rightOn?: string | string[];
  how?: 'inner' | 'left' | 'full';  // default 'inner'
}): Query
```

C++ side:
- `SerializePlan`: serialize right-side NativeTable pointer + key column names + join type
- `ExecutePlan`: `td_graph_add_table(g, right_tbl)` to register second table, `td_scan_table(g, table_id, col)` for right-side key columns, then `td_join(g, left, left_keys, right, right_keys, n_keys, join_type)`
- Join type mapping: `'inner'`→0, `'left'`→1, `'full'`→2

### Window Join (ASOF-style)

```typescript
query.windowJoin(other: Table, opts: {
  timeKey: string;
  symKey: string;
  windowLo: number;
  windowHi: number;
  aggs: Expr[];
}): Query
```

C++ side: `td_window_join(g, left, right, time_key, sym_key, lo, hi, agg_ops, agg_ins, n_aggs)`. Agg decomposition reuses existing `DecomposeAgg` helper.

### Window Functions

```typescript
query.window(opts: {
  partitionBy: string[];
  orderBy: { col: string; descending?: boolean }[];
  funcs: WindowFunc[];
  frame?: {
    type?: 'rows' | 'range';
    start?: FrameBound;
    end?: FrameBound;
  };
}): Query

type WindowFunc =
  | { kind: 'rowNumber' }
  | { kind: 'rank' }
  | { kind: 'denseRank' }
  | { kind: 'ntile'; n: number }
  | { kind: 'sum' | 'avg' | 'min' | 'max' | 'count'; col: string }
  | { kind: 'lag' | 'lead'; col: string; offset?: number }
  | { kind: 'firstValue' | 'lastValue'; col: string }
  | { kind: 'nthValue'; col: string; n: number };

type FrameBound =
  | 'unboundedPreceding'
  | 'currentRow'
  | 'unboundedFollowing'
  | { preceding: number }
  | { following: number };
```

C++ side mapping:
- `WindowFunc.kind` → `TD_WIN_*` constants (0-13)
- `FrameBound` strings → `TD_BOUND_*` constants (0-4)
- Frame type: `'rows'`→`TD_FRAME_ROWS`, `'range'`→`TD_FRAME_RANGE`
- Emits `td_window_op(g, table_node, part_keys, n_part, order_keys, order_descs, n_order, func_kinds, func_inputs, func_params, n_funcs, frame_type, frame_start, frame_end, frame_start_n, frame_end_n)`

### Files Changed

- `lib/query.ts` — new methods (tail, distinct, select, project, join, windowJoin, window)
- `lib/table.ts` — new convenience methods delegating to Query (tail, distinct, select, join)
- `lib/types.ts` — new file for WindowFunc, FrameBound, JoinOpts type definitions
- `src/query.h` — new PlanStep fields (join table pointer, window spec, etc.)
- `src/query.cpp` — `SerializePlan` + `ExecutePlan` new step handlers

---

## Phase 3: I/O Layer

### CSV

```typescript
// Write
ctx.writeCsvSync(table: Table, path: string): void
ctx.writeCsv(table: Table, path: string): Promise<void>

// Read with options (extends existing signature)
ctx.readCsvSync(path: string, opts?: CsvReadOpts): Table
ctx.readCsv(path: string, opts?: CsvReadOpts): Promise<Table>

interface CsvReadOpts {
  delimiter?: string;
  header?: boolean;
  columnTypes?: ColumnType[];
}
type ColumnType = 'bool'|'u8'|'i16'|'i32'|'i64'|'f64'|'sym'|'date'|'time'|'timestamp';
```

When `opts` is provided, uses `td_read_csv_opts`. When absent, uses `td_read_csv` (backward compatible).

### Splayed Tables

```typescript
ctx.saveTableSync(table: Table, dir: string): void
ctx.saveTable(table: Table, dir: string): Promise<void>
// → td_splay_save(tbl, dir, dir + "/.sym")

ctx.loadTableSync(dir: string): Table
ctx.loadTable(dir: string): Promise<Table>
// → td_read_splayed(dir, dir + "/.sym")
```

### Column I/O

```typescript
series.saveSync(path: string): void
series.save(path: string): Promise<void>
// → td_col_save(vec, path)

ctx.loadColSync(path: string): Series
ctx.loadCol(path: string): Promise<Series>
// → td_col_load(path)

ctx.mmapColSync(path: string): Series
ctx.mmapCol(path: string): Promise<Series>
// → td_col_mmap(path)
```

### Partitioned Tables

```typescript
ctx.loadPartSync(dbRoot: string, tableName: string): Table
ctx.loadPart(dbRoot: string, tableName: string): Promise<Table>
// → td_read_parted(db_root, table_name)
```

### Symbol Table Persistence

```typescript
ctx.saveSymbolsSync(path: string): void
ctx.saveSymbols(path: string): Promise<void>
// → td_sym_save(path)

ctx.loadSymbolsSync(path: string): void
ctx.loadSymbols(path: string): Promise<void>
// → td_sym_load(path)
```

### Metadata

```typescript
ctx.saveMetaSync(table: Table, path: string): void
ctx.saveMeta(table: Table, path: string): Promise<void>
// → td_meta_save_d(schema, path)

ctx.loadMetaSync(path: string): Table
ctx.loadMeta(path: string): Promise<Table>
// → td_meta_load_d(path)
```

### Files Changed

- `lib/context.ts` — new I/O methods
- `lib/series.ts` — save/save methods
- `src/context.cpp` — new NativeContext methods for CSV write/opts, splayed, partitioned, symbol, metadata
- `src/series.cpp` — save dispatch

---

## Phase 4: Table Construction

### High-Level API

```typescript
Table.fromArraysSync(ctx: Context, data: Record<string, ArrayLike>): Table
Table.fromArrays(ctx: Context, data: Record<string, ArrayLike>): Promise<Table>
```

Accepts JS arrays and TypedArrays. Type inference:

| JS type | Teide type |
|---------|-----------|
| `number[]` | TD_F64 (or TD_I64 if all integers) |
| `bigint[]` | TD_I64 |
| `boolean[]` | TD_BOOL |
| `string[]` | TD_SYM (interned via `td_sym_intern`) |
| `Float64Array` | TD_F64 |
| `Int32Array` | TD_I32 |
| `Int16Array` | TD_I16 |
| `Int8Array` / `Uint8Array` | TD_U8 |
| `BigInt64Array` | TD_I64 |

### Implementation

C++ side — single dispatch to Teide thread:
1. V8 thread: serialize column names + typed data buffers into C++ struct
2. Teide thread: `td_table_new(ncols)`, for each column: `td_vec_new(type, len)`, bulk-copy data via `memcpy` into `td_data(vec)` (or `td_sym_intern` loop for strings), `td_table_add_col(tbl, name_id, vec)`
3. Return NativeTable

Exposed as `addon.tableFromArraysSync(ctx, columns)` / `addon.tableFromArrays(ctx, columns)`.

### Files Changed

- `lib/table.ts` — static factory methods
- `src/table.cpp` — `TableFromArraysSync`/`TableFromArrays` implementations
- `src/addon.cpp` — register new exports

---

## Phase 5: Low-Level APIs

### Vector (`lib/vector.ts`, `src/vector.cpp`)

```typescript
class Vector implements Disposable {
  static newSync(ctx: Context, type: ColumnType, capacity: number): Vector
  static fromRawSync(ctx: Context, type: ColumnType, data: ArrayBufferView): Vector

  append(value: number | bigint | boolean | string): Vector
  set(index: number, value: number | bigint | boolean | string): void
  get(index: number): number | bigint | boolean | string | null
  slice(offset: number, length: number): Vector
  concat(other: Vector): Vector
  setNull(index: number, isNull: boolean): void
  isNull(index: number): boolean
  get length(): number
  get type(): ColumnType
  [Symbol.dispose](): void
}
```

C++ `NativeVector`: `Napi::ObjectWrap<NativeVector>` wrapping `td_t*` vector. Dispatches through TeideThread for mutation ops. Also handles `td_sym_vec_new` for TD_SYM type.

### Atom (`lib/atom.ts`, `src/atom.cpp`)

```typescript
// Overloaded factory
function atom(ctx: Context, value: boolean | number | bigint | string | Date): Atom

// Explicit typed constructors
Atom.bool(ctx, val)   Atom.u8(ctx, val)    Atom.i16(ctx, val)
Atom.i32(ctx, val)    Atom.i64(ctx, val)   Atom.f64(ctx, val)
Atom.date(ctx, val)   Atom.time(ctx, val)  Atom.timestamp(ctx, val)
Atom.guid(ctx, bytes) Atom.sym(ctx, id)    Atom.str(ctx, val)
```

C++ `NativeAtom`: wraps scalar `td_t*`. Maps to `td_bool`, `td_u8`, ..., `td_guid`.

### List (`lib/list.ts`, `src/list.cpp`)

```typescript
class List implements Disposable {
  static newSync(ctx: Context, capacity: number): List
  append(item: Atom | Vector | Table | List): List
  get(index: number): Atom | Vector | Table | List
  set(index: number, item: Atom | Vector | Table | List): void
  [Symbol.dispose](): void
}
```

### Selection (`lib/selection.ts`, `src/selection.cpp`)

```typescript
class Selection implements Disposable {
  static newSync(ctx: Context, nRows: number): Selection
  static fromPredSync(ctx: Context, boolVector: Vector): Selection
  and(other: Selection): Selection
  recompute(): void
  get totalPass(): number
  [Symbol.dispose](): void
}
```

### Symbol Table (on Context)

```typescript
ctx.symIntern(str: string): number
ctx.symFind(str: string): number
ctx.symStr(id: number): string
ctx.symCount(): number
```

### Table Builder (low-level)

```typescript
Table.newSync(ctx: Context, nCols: number): Table
table.addCol(name: string, vector: Vector): Table
table.getColByIndex(index: number): Series
table.setColName(index: number, name: string): void
table.schema(): Table
```

### Files Changed

- `lib/vector.ts`, `src/vector.h`, `src/vector.cpp` — new NativeVector class
- `lib/atom.ts`, `src/atom.h`, `src/atom.cpp` — new NativeAtom class
- `lib/list.ts`, `src/list.h`, `src/list.cpp` — new NativeList class
- `lib/selection.ts`, `src/selection.h`, `src/selection.cpp` — new NativeSelection class
- `lib/context.ts` — symIntern, symFind, symStr, symCount
- `lib/table.ts` — newSync, addCol, getColByIndex, setColName, schema
- `src/table.cpp` — low-level table builder methods
- `src/context.cpp` — symbol table methods
- `src/addon.cpp` — register all new classes
- `lib/index.ts` — export Vector, Atom, List, Selection
- `CMakeLists.txt` — add new .cpp source files

---

## Testing Strategy

Each phase gets its own test file:

- `test/expr-extended.test.ts` — string ops, date/time, cast, conditional, new aggs
- `test/query-extended.test.ts` — tail, distinct, select, project, join, window join, window
- `test/io.test.ts` — CSV write/opts, splayed save/load, column save/load/mmap, partitioned, symbols, metadata
- `test/table-builder.test.ts` — Table.fromArrays with various JS types
- `test/low-level.test.ts` — Vector, Atom, List, Selection primitives

Test fixtures: extend existing CSV files or add new ones as needed for join/window scenarios.
