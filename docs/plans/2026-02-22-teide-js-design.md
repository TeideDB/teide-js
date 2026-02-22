# teidedb — Node.js NAPI Bindings for Teide

**Date**: 2026-02-22
**Package**: `teidedb` (npm)
**Target**: Node.js only

## Overview

Zero-copy NAPI bindings for the Teide columnar dataframe engine. Mirrors the Python API with JS idioms: camelCase, options objects, fluent chaining, async-first execution. Key differentiator is Teide's expression compiler (fused morsel-batched JIT) exposed with no copy overhead.

## Architecture

Three layers:

```
JS API (TypeScript)         Context, Query, Expr, Series
NAPI Addon (C++)            node-addon-api, work queue, threadsafe callbacks
Teide C Core                Linked at build, DAG/optimizer/executor/heap
```

### Threading Model

All Teide API calls must happen on the thread that called `td_heap_init`. The addon uses a **dedicated Teide thread**:

- `new Context()` spawns a background thread that calls `td_heap_init` and `td_sym_init`
- An SPSC queue dispatches work items from the main thread to the Teide thread
- Each work item is a tagged union: graph ops, optimize, execute, CSV read, etc.

**Sync path** (`.collectSync()`): Main thread posts work, blocks on a condition variable until the Teide thread signals completion.

**Async path** (`.collect()`): Main thread posts work, returns a Promise immediately. Teide thread processes work, then calls `napi_threadsafe_function` to resolve the Promise on the main thread.

**Teardown**: `context.destroy()` (or `Symbol.dispose` for `using` syntax) posts a shutdown sentinel, joins the thread, cleans up.

## Public API

```typescript
import { Context, col, lit } from 'teidedb';

await using ctx = new Context();

const df = await ctx.readCsv('data.csv');

const result = await df
  .filter(col('price').gt(0))
  .groupBy('category')
  .agg(col('price').sum(), col('price').mean())
  .sort('price_sum', { descending: true })
  .head(100)
  .collect();

// Sync alternative
const result = df.filter(col('x').gt(0)).collectSync();

// Result access
result.nRows;                    // number
result.nCols;                    // number
result.columns;                  // string[]
const s = result.col('price');   // Series

// Series — zero-copy
s.dtype;      // 'f64' | 'i64' | 'i32' | 'bool' | 'sym' | ...
s.length;     // number
s.data;       // Float64Array (zero-copy, rc-backed)

// Symbol series — dictionary encoding
const cat = result.col('category');
cat.indices;     // Uint8Array | Uint16Array | Uint32Array (zero-copy)
cat.dictionary;  // string[]

// Null bitmap
s.nullBitmap;    // Uint8Array | null
```

### Expression Methods

**Binary**: `.add`, `.sub`, `.mul`, `.div`, `.mod`, `.eq`, `.ne`, `.lt`, `.le`, `.gt`, `.ge`, `.and`, `.or`

**Unary**: `.not`, `.neg`, `.abs`, `.sqrt`, `.log`, `.exp`, `.ceil`, `.floor`, `.isNull`

**Aggregation**: `.sum`, `.mean`, `.min`, `.max`, `.count`, `.first`, `.last`

**Other**: `.alias(name)`

No operator overloading — JS does not support it. Explicit methods only.

### Differences from Python API

- `camelCase` everywhere (`groupBy`, `readCsv`, `collectSync`)
- Explicit methods instead of operators (`.gt()` not `>`)
- Options objects: `sort('col', { descending: true })`
- Async-first: `.collect()` returns Promise, `.collectSync()` for scripts
- `Symbol.dispose` support for automatic cleanup via `using`

## Zero-Copy Memory Model

Column data never leaves C memory. JS gets typed views backed by `td_retain`/`td_release`.

### Numeric Columns

```
JS:    Float64Array → ArrayBuffer (external, no owned memory)
NAPI:  napi_create_external_arraybuffer(ptr, len, release_cb)
C:     td_t* vec → data[] (32-byte aligned), rc bumped
```

On first access of `Series.data`:
1. Read `td_t` header: type, length, data pointer (resolve slices)
2. `td_retain(vec)` — bump refcount
3. Create external `ArrayBuffer` pointing at `&vec->data[0]`
4. Attach release callback: `td_release(vec)` on Teide thread
5. Wrap as appropriate `TypedArray`
6. Cache — subsequent `.data` calls return same TypedArray

### Symbol Columns

- `.indices` — zero-copy TypedArray of dictionary-encoded indices (width from attrs)
- `.dictionary` — one-time string array from `td_sym_str()` (small copy, dictionary is tiny)

### Lifecycle

A TypedArray holds a retain on its vector. Vector stays alive as long as any JS reference to the typed array exists. GC collection triggers `td_release` — if refcount hits zero, memory returns to buddy allocator.

## Type Mapping

| C Type       | JS Type          | Notes                              |
|--------------|------------------|------------------------------------|
| TD_F64       | Float64Array     |                                    |
| TD_I64       | BigInt64Array    | JS number can't represent full i64 |
| TD_I32       | Int32Array       |                                    |
| TD_I16       | Int16Array       |                                    |
| TD_BOOL      | Uint8Array       | 1 byte per element                 |
| TD_DATE      | Int32Array       | Days since 2000-01-01              |
| TD_TIMESTAMP | BigInt64Array    | Nanos since epoch                  |
| TD_SYM       | indices + dict   | See symbol columns above           |

## Error Handling

C core error pointers mapped to JS exceptions:

| C Error        | JS Error                                  |
|----------------|-------------------------------------------|
| TD_ERR_OOM     | TeideError('out of memory'), code: 'OOM'  |
| TD_ERR_TYPE    | TypeError('type mismatch: ...')            |
| TD_ERR_RANGE   | RangeError('index out of bounds')          |
| TD_ERR_IO      | TeideError('file not found: ...'), 'IO'   |
| TD_ERR_SCHEMA  | TeideError('column not found: ...'), 'SCHEMA' |
| TD_ERR_NYI     | TeideError('not yet implemented: ...'), 'NYI' |

`TeideError` extends `Error` with a `.code` property for programmatic handling. Sync calls throw, async calls reject.

## Package Structure

```
teidedb/js/
├── package.json
├── tsconfig.json
├── CMakeLists.txt            # cmake-js: links libteide + compiles addon
├── src/                      # C++ NAPI addon
│   ├── addon.cpp             # Module init, class registration
│   ├── context.cpp/.h        # Teide thread lifecycle, work queue
│   ├── query.cpp/.h          # Graph building: scan, filter, sort, group, join
│   ├── series.cpp/.h         # Zero-copy TypedArray, retain/release
│   ├── table.cpp/.h          # Result table wrapper, column access
│   ├── expr.cpp/.h           # Expression node emission to C graph
│   └── util.h                # Error mapping, type helpers
├── lib/                      # TypeScript API layer
│   ├── index.ts              # Public re-exports
│   ├── context.ts            # Context class (wraps native)
│   ├── query.ts              # Query builder (fluent chain)
│   ├── expr.ts               # col(), lit(), Expr class
│   ├── series.ts             # Series wrapper
│   └── table.ts              # Table wrapper
├── test/
│   └── *.test.ts
└── vendor/
    └── teide/                # Submodule or symlink to ../teide
```

## Build System

- **cmake-js** compiles `src/*.cpp` into `teide.node`, linking vendored C core
- C core built from source as part of CMake project
- `npm run build` → `cmake-js compile`
- `npm run build:release` → `cmake-js compile --release` (`-march=native`)
- **Prebuilt binaries** via `prebuildify` for Linux/macOS/Windows (x64 + arm64)
- Falls back to source build if no prebuild matches
