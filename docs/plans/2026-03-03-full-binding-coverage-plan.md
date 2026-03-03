# Full libteide Binding Coverage — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose all user-facing libteide C API functionality through the teide-js Node.js NAPI bindings, organized in 5 incremental phases.

**Architecture:** Each phase extends the existing three-layer architecture (TypeScript API → C++17 NAPI addon → C17 core). Expression/query changes extend the lazy-build-then-serialize-then-execute pipeline. I/O and low-level APIs add new NativeContext methods and new Napi::ObjectWrap classes. All C API calls are dispatched through the TeideThread (never called from V8 thread directly).

**Tech Stack:** TypeScript, C++17 (node-addon-api / NAPI v9), C17 (vendor/teide), CMake, Vitest

**Critical patterns to follow:**
- C++ header order: `#include "foo.h"` (which includes `teide_thread.h` → `<napi.h>` → C++ headers) BEFORE `#include "compat.h"` (C-atomic shim)
- All td_* calls go through `thread->dispatch_sync()` or `thread->dispatch_async()`
- Wrap results with `NativeTable::Create(env, result, thread)` or equivalent
- `td_retain`/`td_release` for lifecycle management; check `heap_alive_` before release in destructors
- Serialization (JS→C++) on V8 thread, execution on Teide thread
- Async pattern: `Napi::Promise::Deferred` + `Napi::ThreadSafeFunction` + `td_retain` before dispatch + `td_release` inside work lambda

---

## Phase 1: Expression Layer

### Task 1.1: Add new aggregation opcodes to Expr

- [x] Add opcode constants (OP_COUNT_DISTINCT, OP_STDDEV, OP_STDDEV_POP, OP_VAR, OP_VAR_POP) to lib/expr.ts
- [x] Add aggregation methods (countDistinct, stddev, stddevPop, variance, variancePop) to Expr class
- [x] Add unit tests to test/expr.test.ts
- [x] All tests pass

**Files:**
- Modify: `lib/expr.ts`
- Test: `test/expr.test.ts`

**Step 1: Write failing tests**

Add to `test/expr.test.ts`:

```typescript
it('builds countDistinct aggregation', () => {
  const e = col('x').countDistinct();
  expect(e.kind).toBe('agg');
  expect(e.params.op).toBe(58); // OP_COUNT_DISTINCT
});

it('builds stddev aggregation', () => {
  const e = col('x').stddev();
  expect(e.kind).toBe('agg');
  expect(e.params.op).toBe(59); // OP_STDDEV
});

it('builds stddevPop aggregation', () => {
  const e = col('x').stddevPop();
  expect(e.kind).toBe('agg');
  expect(e.params.op).toBe(73); // OP_STDDEV_POP
});

it('builds variance aggregation', () => {
  const e = col('x').variance();
  expect(e.kind).toBe('agg');
  expect(e.params.op).toBe(74); // OP_VAR
});

it('builds variancePop aggregation', () => {
  const e = col('x').variancePop();
  expect(e.kind).toBe('agg');
  expect(e.params.op).toBe(75); // OP_VAR_POP
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/expr.test.ts`
Expected: FAIL — `countDistinct` is not a function

**Step 3: Implement in lib/expr.ts**

Add opcode constants after line 11 (`export const OP_LAST = 57;`):

```typescript
export const OP_COUNT_DISTINCT = 58;
export const OP_STDDEV = 59;
export const OP_STDDEV_POP = 73;
export const OP_VAR = 74;
export const OP_VAR_POP = 75;
```

Add methods to the `Expr` class after the `last()` method:

```typescript
countDistinct(): Expr { return new Expr('agg', { op: OP_COUNT_DISTINCT, arg: this }); }
stddev(): Expr { return new Expr('agg', { op: OP_STDDEV, arg: this }); }
stddevPop(): Expr { return new Expr('agg', { op: OP_STDDEV_POP, arg: this }); }
variance(): Expr { return new Expr('agg', { op: OP_VAR, arg: this }); }
variancePop(): Expr { return new Expr('agg', { op: OP_VAR_POP, arg: this }); }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/expr.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/expr.ts test/expr.test.ts
git commit -m "feat(expr): add countDistinct, stddev, variance aggregation opcodes"
```

---

### Task 1.2: Add new aggregation opcodes to C++ EmitExpr

- [x] Create test/expr-extended.test.ts with e2e test for countDistinct
- [x] Add countDistinct (and available stat agg) opcodes to EmitExpr switch in src/query.cpp
- [x] Build and verify e2e test passes

**Files:**
- Modify: `src/query.cpp` (the `EmitExpr` function, agg switch around line 175-185)

**Step 1: Write failing e2e test**

Create `test/expr-extended.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import { Context, col } from '../lib';

const SALES = path.join(__dirname, 'fixtures', 'sales.csv');

describe('Extended aggregations', () => {
  it('countDistinct in groupBy', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.groupBy('category')
        .agg(col('product').countDistinct().alias('n_unique'))
        .collectSync();
      expect(result.nRows).toBeGreaterThan(0);
      expect(result.columns).toContain('n_unique');
    } finally {
      ctx.destroy();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/expr-extended.test.ts`
Expected: FAIL or nullptr — agg opcode 58 hits `default: return nullptr` in EmitExpr

**Step 3: Add opcodes to EmitExpr in src/query.cpp**

In the `EmitExpr` function, in the `agg` switch (around line 175-185), add after `case OP_LAST`:

```cpp
case OP_COUNT_DISTINCT: return td_count_distinct(g, arg);
// OP_STDDEV (59), OP_STDDEV_POP (73), OP_VAR (74), OP_VAR_POP (75)
// These use the same pattern — single-input reductions.
// The opcodes are defined in td.h but may not have dedicated builder
// functions. If td_stddev etc. don't exist, construct the op manually:
```

Check if `td_stddev`, etc. exist in td.h. Looking at the header, only `td_count_distinct` has a builder function. For the stat aggs (stddev, var), we need to check if they have dedicated C builder functions. If not, we need to build the op nodes manually using a helper:

```cpp
// Helper to create a generic reduction op node
static td_op_t* emit_reduction(td_graph_t* g, uint16_t opcode, td_op_t* input) {
    // Allocate an extended op node and set it up as a reduction
    td_op_t* base = &g->nodes[g->node_count];
    // ... This depends on td_graph internal API.
    // If the C core doesn't expose builders for these, fall through to nullptr
    // and document the limitation.
    return nullptr;
}
```

**Practical approach:** Add `td_count_distinct` (which has a builder). For stddev/var, verify whether the C core supports them by checking `vendor/teide/src/`. If it doesn't have builders, skip them for now and add a comment. The opcodes are defined but execution may not be implemented yet.

Add to the switch in `EmitExpr`:

```cpp
case 58: return td_count_distinct(g, arg);  // OP_COUNT_DISTINCT
```

**Step 4: Build and run test**

Run: `npm run build && npx vitest run test/expr-extended.test.ts`
Expected: PASS (at least for countDistinct)

**Step 5: Commit**

```bash
git add src/query.cpp test/expr-extended.test.ts
git commit -m "feat(query): wire countDistinct aggregation through EmitExpr"
```

---

### Task 1.3: Add string unary ops to Expr and EmitExpr

- [x] Add string unary ops (upper, lower, strlen, trim) to Expr and wire through EmitExpr

**Files:**
- Modify: `lib/expr.ts`
- Modify: `src/query.cpp`
- Test: `test/expr.test.ts`, `test/expr-extended.test.ts`

**Step 1: Write failing unit tests**

Add to `test/expr.test.ts`:

```typescript
it('builds upper unary op', () => {
  const e = col('name').upper();
  expect(e.kind).toBe('unop');
  expect(e.params.op).toBe('upper');
});

it('builds lower unary op', () => {
  const e = col('name').lower();
  expect(e.kind).toBe('unop');
  expect(e.params.op).toBe('lower');
});

it('builds strlen unary op', () => {
  const e = col('name').strlen();
  expect(e.kind).toBe('unop');
  expect(e.params.op).toBe('strlen');
});

it('builds trim unary op', () => {
  const e = col('name').trim();
  expect(e.kind).toBe('unop');
  expect(e.params.op).toBe('trim');
});
```

**Step 2: Run tests to verify failure**

Run: `npx vitest run test/expr.test.ts`
Expected: FAIL — `upper` is not a function

**Step 3: Add methods to Expr class in lib/expr.ts**

After the `isNull()` method:

```typescript
upper(): Expr { return new Expr('unop', { op: 'upper', arg: this }); }
lower(): Expr { return new Expr('unop', { op: 'lower', arg: this }); }
strlen(): Expr { return new Expr('unop', { op: 'strlen', arg: this }); }
trim(): Expr { return new Expr('unop', { op: 'trim', arg: this }); }
```

**Step 4: Run unit tests**

Run: `npx vitest run test/expr.test.ts`
Expected: PASS

**Step 5: Wire up in EmitExpr**

In `src/query.cpp`, in the `unop` section of `EmitExpr` (around line 157-170), add after the `isnull` case:

```cpp
if (op == "upper")  return td_upper(g, arg);
if (op == "lower")  return td_lower(g, arg);
if (op == "strlen") return td_strlen(g, arg);
if (op == "trim")   return td_trim_op(g, arg);
```

**Step 6: Write e2e test**

Add to `test/expr-extended.test.ts`:

```typescript
it('upper on symbol column', () => {
  const ctx = new Context();
  try {
    const df = ctx.readCsvSync(SALES);
    // Filter using string length — products with name length > 4
    const result = df.filter(col('product').strlen().gt(4)).collectSync();
    expect(result.nRows).toBeGreaterThan(0);
  } finally {
    ctx.destroy();
  }
});
```

**Step 7: Build and run**

Run: `npm run build && npx vitest run test/expr-extended.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add lib/expr.ts src/query.cpp test/expr.test.ts test/expr-extended.test.ts
git commit -m "feat(expr): add string unary ops (upper, lower, strlen, trim)"
```

---

### Task 1.4: Add string binary ops (like, ilike) to Expr and EmitExpr

- [x] Add string binary ops (like, ilike, min2, max2) to Expr and wire through EmitExpr

**Files:**
- Modify: `lib/expr.ts`
- Modify: `src/query.cpp`
- Test: `test/expr.test.ts`, `test/expr-extended.test.ts`

**Step 1: Write failing unit tests**

Add to `test/expr.test.ts`:

```typescript
it('builds like binop', () => {
  const e = col('name').like('%alpha%');
  expect(e.kind).toBe('binop');
  expect(e.params.op).toBe('like');
});

it('builds ilike binop', () => {
  const e = col('name').ilike('%ALPHA%');
  expect(e.kind).toBe('binop');
  expect(e.params.op).toBe('ilike');
});

it('builds min2 binop', () => {
  const e = col('a').min2(col('b'));
  expect(e.kind).toBe('binop');
  expect(e.params.op).toBe('min2');
});

it('builds max2 binop', () => {
  const e = col('a').max2(col('b'));
  expect(e.kind).toBe('binop');
  expect(e.params.op).toBe('max2');
});
```

**Step 2: Run tests to verify failure**

Run: `npx vitest run test/expr.test.ts`
Expected: FAIL

**Step 3: Add methods to Expr class in lib/expr.ts**

After the `or` method:

```typescript
like(pattern: Expr | string): Expr { return binop('like', this, wrap(pattern)); }
ilike(pattern: Expr | string): Expr { return binop('ilike', this, wrap(pattern)); }
min2(other: Expr | number): Expr { return binop('min2', this, wrap(other)); }
max2(other: Expr | number): Expr { return binop('max2', this, wrap(other)); }
```

**Step 4: Run unit tests**

Run: `npx vitest run test/expr.test.ts`
Expected: PASS

**Step 5: Wire up in EmitExpr**

In `src/query.cpp`, in the `binop` section of `EmitExpr` (around line 142-155), add after the `or` case:

```cpp
if (op == "like")  return td_like(g, left, right);
if (op == "ilike") return td_ilike(g, left, right);
if (op == "min2")  return td_min2(g, left, right);
if (op == "max2")  return td_max2(g, left, right);
```

**Step 6: Build and run e2e**

Run: `npm run build && npx vitest run test/expr-extended.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add lib/expr.ts src/query.cpp test/expr.test.ts
git commit -m "feat(expr): add like, ilike, min2, max2 binary ops"
```

---

### Task 1.5: Add N-ary ops (substr, replace, concat) and cast

- [x] Add N-ary ops (substr, replace, concat, if) and cast to Expr and wire through EmitExpr

**Files:**
- Modify: `lib/expr.ts` — add `ExprKind 'naryop'` and `'cast'`
- Modify: `src/query.h` — add `args` vector and `target_type` to ExprNode
- Modify: `src/query.cpp` — handle `naryop` and `cast` in SerializeExpr + EmitExpr
- Test: `test/expr.test.ts`, `test/expr-extended.test.ts`

**Step 1: Write failing unit tests**

Add to `test/expr.test.ts`:

```typescript
it('builds substr naryop', () => {
  const e = col('name').substr(lit(0), lit(3));
  expect(e.kind).toBe('naryop');
  expect(e.params.op).toBe('substr');
  expect((e.params.args as Expr[]).length).toBe(3); // str, start, len
});

it('builds replace naryop', () => {
  const e = col('name').replace('old', 'new');
  expect(e.kind).toBe('naryop');
  expect(e.params.op).toBe('replace');
});

it('builds concat naryop', () => {
  const e = col('first').concat(lit(' '), col('last'));
  expect(e.kind).toBe('naryop');
  expect(e.params.op).toBe('concat');
  expect((e.params.args as Expr[]).length).toBe(3);
});

it('builds cast', () => {
  const e = col('x').cast('f64');
  expect(e.kind).toBe('cast');
  expect(e.params.targetType).toBe('f64');
});

it('builds Expr.if', () => {
  const e = Expr.if(col('x').gt(0), col('x'), lit(0));
  expect(e.kind).toBe('naryop');
  expect(e.params.op).toBe('if');
  expect((e.params.args as Expr[]).length).toBe(3);
});
```

**Step 2: Run tests to verify failure**

Run: `npx vitest run test/expr.test.ts`
Expected: FAIL

**Step 3: Implement in lib/expr.ts**

Update ExprKind type:

```typescript
export type ExprKind = 'col' | 'lit' | 'binop' | 'unop' | 'agg' | 'alias' | 'naryop' | 'cast' | 'dateop';
```

Add methods to Expr class:

```typescript
// N-ary ops
substr(start: Expr | number, len: Expr | number): Expr {
    return new Expr('naryop', { op: 'substr', args: [this, wrap(start), wrap(len)] });
}
replace(from: Expr | string, to: Expr | string): Expr {
    return new Expr('naryop', { op: 'replace', args: [this, wrap(from), wrap(to)] });
}
concat(...others: (Expr | string)[]): Expr {
    return new Expr('naryop', { op: 'concat', args: [this, ...others.map(wrap)] });
}

// Cast
cast(targetType: string): Expr {
    return new Expr('cast', { targetType, arg: this });
}

// Static: conditional
static if(cond: Expr, thenVal: Expr | number | string, elseVal: Expr | number | string): Expr {
    return new Expr('naryop', { op: 'if', args: [cond, wrap(thenVal), wrap(elseVal)] });
}
```

**Step 4: Run unit tests**

Run: `npx vitest run test/expr.test.ts`
Expected: PASS

**Step 5: Update ExprNode in src/query.h**

Add to ExprNode struct:

```cpp
std::vector<std::shared_ptr<ExprNode>> args;  // for 'naryop'
int8_t target_type = 0;                        // for 'cast'
```

**Step 6: Update SerializeExpr in src/query.cpp**

Add after the `alias` handler:

```cpp
else if (node->kind == "naryop") {
    node->str_val = params.Get("op").As<Napi::String>().Utf8Value();
    Napi::Array args_arr = params.Get("args").As<Napi::Array>();
    uint32_t n = args_arr.Length();
    node->args.reserve(n);
    for (uint32_t i = 0; i < n; i++) {
        node->args.push_back(SerializeExpr(args_arr.Get(i).As<Napi::Object>()));
    }
}
else if (node->kind == "cast") {
    node->left = SerializeExpr(params.Get("arg").As<Napi::Object>());
    std::string type_str = params.Get("targetType").As<Napi::String>().Utf8Value();
    // Map type string to TD_* constant
    if (type_str == "bool")      node->target_type = TD_BOOL;
    else if (type_str == "u8")   node->target_type = TD_U8;
    else if (type_str == "i16")  node->target_type = TD_I16;
    else if (type_str == "i32")  node->target_type = TD_I32;
    else if (type_str == "i64")  node->target_type = TD_I64;
    else if (type_str == "f64")  node->target_type = TD_F64;
    else if (type_str == "sym")  node->target_type = TD_SYM;
    else if (type_str == "date") node->target_type = TD_DATE;
    else if (type_str == "time") node->target_type = TD_TIME;
    else if (type_str == "timestamp") node->target_type = TD_TIMESTAMP;
}
```

Note: `TD_BOOL`, `TD_I64`, etc. are macros from td.h — they're available via compat.h which is included in the .cpp file.

**Step 7: Update EmitExpr in src/query.cpp**

Add after the `alias` handler:

```cpp
else if (node->kind == "naryop") {
    const std::string& op = node->str_val;
    if (op == "substr") {
        td_op_t* str = EmitExpr(g, node->args[0]);
        td_op_t* start = EmitExpr(g, node->args[1]);
        td_op_t* len = EmitExpr(g, node->args[2]);
        return td_substr(g, str, start, len);
    }
    if (op == "replace") {
        td_op_t* str = EmitExpr(g, node->args[0]);
        td_op_t* from = EmitExpr(g, node->args[1]);
        td_op_t* to = EmitExpr(g, node->args[2]);
        return td_replace(g, str, from, to);
    }
    if (op == "concat") {
        int n = (int)node->args.size();
        std::vector<td_op_t*> ops(n);
        for (int i = 0; i < n; i++) ops[i] = EmitExpr(g, node->args[i]);
        return td_concat(g, ops.data(), n);
    }
    if (op == "if") {
        td_op_t* cond = EmitExpr(g, node->args[0]);
        td_op_t* then_val = EmitExpr(g, node->args[1]);
        td_op_t* else_val = EmitExpr(g, node->args[2]);
        return td_if(g, cond, then_val, else_val);
    }
    return nullptr;
}
else if (node->kind == "cast") {
    td_op_t* arg = EmitExpr(g, node->left);
    return td_cast(g, arg, node->target_type);
}
```

**Step 8: Build and run all tests**

Run: `npm run build && npx vitest run test/expr.test.ts test/expr-extended.test.ts`
Expected: PASS

**Step 9: Commit**

```bash
git add lib/expr.ts src/query.h src/query.cpp test/expr.test.ts test/expr-extended.test.ts
git commit -m "feat(expr): add naryop (substr, replace, concat, if), cast"
```

---

### Task 1.6: Add date/time ops (extract, dateTrunc)

- [x] Add date/time ops (extract, dateTrunc) to Expr and wire through EmitExpr

**Files:**
- Modify: `lib/expr.ts`
- Modify: `src/query.h` — add `date_field` to ExprNode
- Modify: `src/query.cpp`
- Test: `test/expr.test.ts`

**Step 1: Write failing unit tests**

Add to `test/expr.test.ts`:

```typescript
it('builds extract dateop', () => {
  const e = col('ts').extract('year');
  expect(e.kind).toBe('dateop');
  expect(e.params.op).toBe('extract');
  expect(e.params.field).toBe('year');
});

it('builds dateTrunc dateop', () => {
  const e = col('ts').dateTrunc('month');
  expect(e.kind).toBe('dateop');
  expect(e.params.op).toBe('date_trunc');
  expect(e.params.field).toBe('month');
});
```

**Step 2: Run tests to verify failure**

Run: `npx vitest run test/expr.test.ts`
Expected: FAIL

**Step 3: Implement in lib/expr.ts**

Add type for date fields (at top of file):

```typescript
export type DateField = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'dow' | 'doy' | 'epoch';
```

Add methods to Expr class:

```typescript
extract(field: DateField): Expr {
    return new Expr('dateop', { op: 'extract', field, arg: this });
}
dateTrunc(field: DateField): Expr {
    return new Expr('dateop', { op: 'date_trunc', field, arg: this });
}
```

**Step 4: Run unit tests**

Run: `npx vitest run test/expr.test.ts`
Expected: PASS

**Step 5: Update ExprNode in src/query.h**

Add to ExprNode struct:

```cpp
int64_t date_field = 0;  // for 'dateop' — TD_EXTRACT_* constant
```

**Step 6: Update SerializeExpr and EmitExpr in src/query.cpp**

SerializeExpr — add after the `cast` handler:

```cpp
else if (node->kind == "dateop") {
    node->str_val = params.Get("op").As<Napi::String>().Utf8Value();
    node->left = SerializeExpr(params.Get("arg").As<Napi::Object>());
    std::string field = params.Get("field").As<Napi::String>().Utf8Value();
    if (field == "year")        node->date_field = TD_EXTRACT_YEAR;
    else if (field == "month")  node->date_field = TD_EXTRACT_MONTH;
    else if (field == "day")    node->date_field = TD_EXTRACT_DAY;
    else if (field == "hour")   node->date_field = TD_EXTRACT_HOUR;
    else if (field == "minute") node->date_field = TD_EXTRACT_MINUTE;
    else if (field == "second") node->date_field = TD_EXTRACT_SECOND;
    else if (field == "dow")    node->date_field = TD_EXTRACT_DOW;
    else if (field == "doy")    node->date_field = TD_EXTRACT_DOY;
    else if (field == "epoch")  node->date_field = TD_EXTRACT_EPOCH;
}
```

EmitExpr — add after the `cast` handler:

```cpp
else if (node->kind == "dateop") {
    td_op_t* arg = EmitExpr(g, node->left);
    if (node->str_val == "extract")    return td_extract(g, arg, node->date_field);
    if (node->str_val == "date_trunc") return td_date_trunc(g, arg, node->date_field);
    return nullptr;
}
```

**Step 7: Build and run**

Run: `npm run build && npx vitest run test/expr.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add lib/expr.ts src/query.h src/query.cpp test/expr.test.ts
git commit -m "feat(expr): add extract and dateTrunc date/time ops"
```

---

## Phase 2: Query Layer

### Task 2.1: Add tail and distinct to Query

- [x] Add tail and distinct operations to Query and wire through SerializePlan/ExecutePlan

**Files:**
- Modify: `lib/query.ts`
- Modify: `lib/table.ts` — add convenience methods
- Modify: `src/query.h` — add PlanStep fields
- Modify: `src/query.cpp` — SerializePlan + ExecutePlan
- Test: `test/query-extended.test.ts`

**Step 1: Write failing tests**

Create `test/query-extended.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import { Context, col } from '../lib';

const SALES = path.join(__dirname, 'fixtures', 'sales.csv');

describe('Extended query ops', () => {
  it('tail returns last N rows', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.tail(3).collectSync();
      expect(result.nRows).toBe(3);
    } finally {
      ctx.destroy();
    }
  });

  it('distinct deduplicates by column', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(SALES);
      const result = df.distinct('category').collectSync();
      expect(result.nRows).toBe(3); // electronics, clothing, food
    } finally {
      ctx.destroy();
    }
  });
});
```

**Step 2: Run test to verify failure**

Run: `npm run build && npx vitest run test/query-extended.test.ts`
Expected: FAIL — `tail` is not a function

**Step 3: Add methods to Query in lib/query.ts**

After the `head` method:

```typescript
tail(n: number): Query {
    this._ops.push({ type: 'tail', n });
    return this;
}

distinct(...cols: string[]): Query {
    this._ops.push({ type: 'distinct', cols });
    return this;
}
```

**Step 4: Add convenience methods to Table in lib/table.ts**

After the `head` method:

```typescript
tail(n: number): Query {
    return new Query(this._native, this._ctx).tail(n);
}

distinct(...cols: string[]): Query {
    return new Query(this._native, this._ctx).distinct(...cols);
}
```

**Step 5: Update PlanStep in src/query.h**

Add fields to PlanStep:

```cpp
int64_t tail_n = 0;                              // for 'tail'
std::vector<std::string> distinct_cols;           // for 'distinct'
```

**Step 6: Update SerializePlan in src/query.cpp**

Add after the `head` handler in SerializePlan:

```cpp
else if (step.type == "tail") {
    step.tail_n = (int64_t)op.Get("n").As<Napi::Number>().Int64Value();
}
else if (step.type == "distinct") {
    Napi::Array cols = op.Get("cols").As<Napi::Array>();
    for (uint32_t c = 0; c < cols.Length(); c++) {
        step.distinct_cols.push_back(
            cols.Get(c).As<Napi::String>().Utf8Value());
    }
}
```

**Step 7: Update ExecutePlan in src/query.cpp**

Add after the `head` handler in ExecutePlan:

```cpp
else if (step.type == "tail") {
    if (!current) {
        current = td_const_table(g, tbl);
    }
    if (filter_pred) {
        current = td_filter(g, current, filter_pred);
        filter_pred = nullptr;
    }
    current = td_tail(g, current, step.tail_n);
}
else if (step.type == "distinct") {
    if (filter_pred) {
        td_t* mask = td_execute(g, filter_pred);
        if (TD_IS_ERR(mask)) { td_graph_free(g); return mask; }
        td_retain(mask);
        g->selection = mask;
        filter_pred = nullptr;
    }
    uint8_t n_keys = (uint8_t)step.distinct_cols.size();
    std::vector<td_op_t*> key_nodes(n_keys);
    for (uint8_t k = 0; k < n_keys; k++) {
        key_nodes[k] = td_scan(g, step.distinct_cols[k].c_str());
    }
    current = td_distinct(g, key_nodes.data(), n_keys);
}
```

**Step 8: Build and run**

Run: `npm run build && npx vitest run test/query-extended.test.ts`
Expected: PASS

**Step 9: Commit**

```bash
git add lib/query.ts lib/table.ts src/query.h src/query.cpp test/query-extended.test.ts
git commit -m "feat(query): add tail and distinct operations"
```

---

### Task 2.2: Add select and project to Query

- [x] Add select and project operations to Query and wire through SerializePlan/ExecutePlan

**Files:**
- Modify: `lib/query.ts`
- Modify: `lib/table.ts`
- Modify: `src/query.h`
- Modify: `src/query.cpp`
- Test: `test/query-extended.test.ts`

**Step 1: Write failing tests**

Add to `test/query-extended.test.ts`:

```typescript
it('select picks specific columns', () => {
  const ctx = new Context();
  try {
    const df = ctx.readCsvSync(SALES);
    const result = df.select('category', 'price').collectSync();
    expect(result.nCols).toBe(2);
    expect(result.columns).toContain('category');
    expect(result.columns).toContain('price');
  } finally {
    ctx.destroy();
  }
});

it('project computes expressions', () => {
  const ctx = new Context();
  try {
    const df = ctx.readCsvSync(SALES);
    const result = df.project(
      col('price').mul(col('quantity')).alias('revenue')
    ).collectSync();
    expect(result.columns).toContain('revenue');
    expect(result.nRows).toBe(9);
  } finally {
    ctx.destroy();
  }
});
```

**Step 2: Run tests to verify failure**

Run: `npm run build && npx vitest run test/query-extended.test.ts`
Expected: FAIL

**Step 3: Add methods to Query and Table**

In `lib/query.ts`:

```typescript
select(...cols: string[]): Query {
    this._ops.push({ type: 'select', cols });
    return this;
}

project(...exprs: Expr[]): Query {
    this._ops.push({ type: 'project', exprs });
    return this;
}
```

In `lib/table.ts`:

```typescript
select(...cols: string[]): Query {
    return new Query(this._native, this._ctx).select(...cols);
}

project(...exprs: Expr[]): Query {
    return new Query(this._native, this._ctx).project(...exprs);
}
```

Add `import { Expr } from './expr';` at top of `lib/table.ts` if not already imported.

**Step 4: Update PlanStep in src/query.h**

```cpp
std::vector<std::string> select_cols;                      // for 'select'
std::vector<std::shared_ptr<ExprNode>> project_exprs;      // for 'project'
```

**Step 5: Update SerializePlan**

```cpp
else if (step.type == "select") {
    Napi::Array cols = op.Get("cols").As<Napi::Array>();
    for (uint32_t c = 0; c < cols.Length(); c++) {
        step.select_cols.push_back(cols.Get(c).As<Napi::String>().Utf8Value());
    }
}
else if (step.type == "project") {
    Napi::Array exprs = op.Get("exprs").As<Napi::Array>();
    for (uint32_t e = 0; e < exprs.Length(); e++) {
        step.project_exprs.push_back(
            SerializeExpr(exprs.Get(e).As<Napi::Object>()));
    }
}
```

**Step 6: Update ExecutePlan**

```cpp
else if (step.type == "select") {
    td_op_t* table_node = current ? current : td_const_table(g, tbl);
    if (filter_pred) {
        table_node = td_filter(g, table_node, filter_pred);
        filter_pred = nullptr;
    }
    uint8_t n = (uint8_t)step.select_cols.size();
    std::vector<td_op_t*> col_nodes(n);
    for (uint8_t c = 0; c < n; c++) {
        col_nodes[c] = td_scan(g, step.select_cols[c].c_str());
    }
    current = td_select(g, table_node, col_nodes.data(), n);
}
else if (step.type == "project") {
    td_op_t* table_node = current ? current : td_const_table(g, tbl);
    if (filter_pred) {
        table_node = td_filter(g, table_node, filter_pred);
        filter_pred = nullptr;
    }
    uint8_t n = (uint8_t)step.project_exprs.size();
    std::vector<td_op_t*> expr_nodes(n);
    for (uint8_t e = 0; e < n; e++) {
        expr_nodes[e] = EmitExpr(g, step.project_exprs[e]);
    }
    current = td_project(g, table_node, expr_nodes.data(), n);
}
```

**Step 7: Build and run**

Run: `npm run build && npx vitest run test/query-extended.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add lib/query.ts lib/table.ts src/query.h src/query.cpp test/query-extended.test.ts
git commit -m "feat(query): add select and project operations"
```

---

### Task 2.3: Add join to Query

- [x] Add join operation (inner, left, full) to Query and wire through SerializePlan/ExecutePlan

**Files:**
- Modify: `lib/query.ts`
- Modify: `lib/table.ts`
- Modify: `src/query.h` — add join fields to PlanStep
- Modify: `src/query.cpp` — serialize + execute join
- Create: `test/fixtures/orders.csv` — test fixture for joins
- Test: `test/query-extended.test.ts`

**Step 1: Create test fixture**

Create `test/fixtures/orders.csv`:

```csv
order_id,category,amount
1,electronics,500
2,clothing,150
3,food,30
4,electronics,800
5,clothing,200
```

**Step 2: Write failing test**

Add to `test/query-extended.test.ts`:

```typescript
const ORDERS = path.join(__dirname, 'fixtures', 'orders.csv');

it('inner join on shared column', () => {
  const ctx = new Context();
  try {
    const sales = ctx.readCsvSync(SALES);
    const orders = ctx.readCsvSync(ORDERS);
    const result = sales.join(orders, { on: 'category' }).collectSync();
    expect(result.nRows).toBeGreaterThan(0);
    // Both tables have 'category' — inner join should match
    expect(result.columns).toContain('category');
  } finally {
    ctx.destroy();
  }
});
```

**Step 3: Add join method to Query and Table**

In `lib/query.ts`, add import for Table at top and method:

```typescript
join(other: Table, opts: {
    on?: string | string[];
    leftOn?: string | string[];
    rightOn?: string | string[];
    how?: 'inner' | 'left' | 'full';
}): Query {
    const how = opts.how ?? 'inner';
    let leftKeys: string[];
    let rightKeys: string[];
    if (opts.on) {
        const keys = Array.isArray(opts.on) ? opts.on : [opts.on];
        leftKeys = keys;
        rightKeys = keys;
    } else {
        leftKeys = Array.isArray(opts.leftOn!) ? opts.leftOn! : [opts.leftOn!];
        rightKeys = Array.isArray(opts.rightOn!) ? opts.rightOn! : [opts.rightOn!];
    }
    this._ops.push({
        type: 'join',
        rightTable: other._native,
        leftKeys,
        rightKeys,
        joinType: how === 'inner' ? 0 : how === 'left' ? 1 : 2,
    });
    return this;
}
```

In `lib/table.ts`:

```typescript
join(other: Table, opts: {
    on?: string | string[];
    leftOn?: string | string[];
    rightOn?: string | string[];
    how?: 'inner' | 'left' | 'full';
}): Query {
    return new Query(this._native, this._ctx).join(other, opts);
}
```

**Step 4: Update PlanStep in src/query.h**

```cpp
// For 'join'
td_t* join_right_table = nullptr;
std::vector<std::string> join_left_keys;
std::vector<std::string> join_right_keys;
uint8_t join_type = 0;  // 0=inner, 1=left, 2=full
```

**Step 5: Update SerializePlan**

```cpp
else if (step.type == "join") {
    NativeTable* right = Napi::ObjectWrap<NativeTable>::Unwrap(
        op.Get("rightTable").As<Napi::Object>());
    step.join_right_table = right->ptr();
    td_retain(step.join_right_table);

    Napi::Array lkeys = op.Get("leftKeys").As<Napi::Array>();
    for (uint32_t k = 0; k < lkeys.Length(); k++) {
        step.join_left_keys.push_back(lkeys.Get(k).As<Napi::String>().Utf8Value());
    }
    Napi::Array rkeys = op.Get("rightKeys").As<Napi::Array>();
    for (uint32_t k = 0; k < rkeys.Length(); k++) {
        step.join_right_keys.push_back(rkeys.Get(k).As<Napi::String>().Utf8Value());
    }
    step.join_type = (uint8_t)op.Get("joinType").As<Napi::Number>().Uint32Value();
}
```

**Step 6: Update ExecutePlan**

```cpp
else if (step.type == "join") {
    td_op_t* left_table_node = current ? current : td_const_table(g, tbl);
    if (filter_pred) {
        left_table_node = td_filter(g, left_table_node, filter_pred);
        filter_pred = nullptr;
    }

    // Register right table in graph
    uint16_t right_id = td_graph_add_table(g, step.join_right_table);

    // Build right table node — use const_table with the right table
    td_op_t* right_table_node = td_const_table(g, step.join_right_table);

    uint8_t n_keys = (uint8_t)step.join_left_keys.size();
    std::vector<td_op_t*> left_keys(n_keys);
    std::vector<td_op_t*> right_keys(n_keys);
    for (uint8_t k = 0; k < n_keys; k++) {
        left_keys[k] = td_scan(g, step.join_left_keys[k].c_str());
        right_keys[k] = td_scan_table(g, right_id, step.join_right_keys[k].c_str());
    }

    current = td_join(g, left_table_node, left_keys.data(),
                       right_table_node, right_keys.data(),
                       n_keys, step.join_type);
}
```

Note: Need to release `join_right_table` after execution. Add cleanup in ExecutePlan or handle via the dispatch_sync lambda.

**Step 7: Build and run**

Run: `npm run build && npx vitest run test/query-extended.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add lib/query.ts lib/table.ts src/query.h src/query.cpp test/fixtures/orders.csv test/query-extended.test.ts
git commit -m "feat(query): add join operation (inner, left, full)"
```

---

### Task 2.4: Add window functions to Query

- [x] Add window functions with full frame specification to Query and wire through SerializePlan/ExecutePlan

**Files:**
- Modify: `lib/query.ts`
- Create: `lib/types.ts` — WindowFunc, FrameBound type definitions
- Modify: `lib/index.ts` — export new types
- Modify: `src/query.h` — window step fields
- Modify: `src/query.cpp` — serialize + execute window
- Test: `test/query-extended.test.ts`

**Step 1: Create lib/types.ts**

```typescript
export type WindowFuncKind =
  | 'rowNumber' | 'rank' | 'denseRank' | 'ntile'
  | 'sum' | 'avg' | 'min' | 'max' | 'count'
  | 'lag' | 'lead'
  | 'firstValue' | 'lastValue' | 'nthValue';

export interface WindowFunc {
  kind: WindowFuncKind;
  col?: string;
  n?: number;       // for ntile, nthValue
  offset?: number;   // for lag, lead
}

export type FrameBound =
  | 'unboundedPreceding'
  | 'currentRow'
  | 'unboundedFollowing'
  | { preceding: number }
  | { following: number };

export interface WindowOpts {
  partitionBy: string[];
  orderBy: { col: string; descending?: boolean }[];
  funcs: WindowFunc[];
  frame?: {
    type?: 'rows' | 'range';
    start?: FrameBound;
    end?: FrameBound;
  };
}

export interface JoinOpts {
  on?: string | string[];
  leftOn?: string | string[];
  rightOn?: string | string[];
  how?: 'inner' | 'left' | 'full';
}

export interface WindowJoinOpts {
  timeKey: string;
  symKey: string;
  windowLo: number;
  windowHi: number;
  aggs: import('./expr').Expr[];
}
```

**Step 2: Write failing test**

Add to `test/query-extended.test.ts`:

```typescript
it('window with rowNumber', () => {
  const ctx = new Context();
  try {
    const df = ctx.readCsvSync(SALES);
    const result = df.window({
      partitionBy: ['category'],
      orderBy: [{ col: 'price', descending: true }],
      funcs: [{ kind: 'rowNumber' }],
    }).collectSync();
    expect(result.nRows).toBe(9);
    expect(result.nCols).toBeGreaterThan(4); // original cols + window col
  } finally {
    ctx.destroy();
  }
});
```

**Step 3: Add window method to Query in lib/query.ts**

```typescript
window(opts: WindowOpts): Query {
    this._ops.push({ type: 'window', ...opts });
    return this;
}
```

Import `WindowOpts` from `./types`.

**Step 4: Add window step fields to PlanStep in src/query.h**

```cpp
// For 'window'
std::vector<std::string> win_part_keys;
std::vector<std::string> win_order_keys;
std::vector<bool> win_order_descs;
std::vector<uint8_t> win_func_kinds;
std::vector<std::string> win_func_cols;    // column name per func (empty for rowNumber etc.)
std::vector<int64_t> win_func_params;      // ntile(n), lag offset, nth_value(n)
uint8_t win_frame_type = 0;               // 0=ROWS, 1=RANGE
uint8_t win_frame_start = 0;              // TD_BOUND_*
uint8_t win_frame_end = 2;                // TD_BOUND_CURRENT_ROW
int64_t win_frame_start_n = 0;
int64_t win_frame_end_n = 0;
```

**Step 5: Update SerializePlan for window**

Map JS `WindowFunc.kind` strings to `TD_WIN_*` constants:

```cpp
else if (step.type == "window") {
    // Partition keys
    Napi::Array pkeys = op.Get("partitionBy").As<Napi::Array>();
    for (uint32_t i = 0; i < pkeys.Length(); i++)
        step.win_part_keys.push_back(pkeys.Get(i).As<Napi::String>().Utf8Value());

    // Order keys
    Napi::Array okeys = op.Get("orderBy").As<Napi::Array>();
    for (uint32_t i = 0; i < okeys.Length(); i++) {
        Napi::Object o = okeys.Get(i).As<Napi::Object>();
        step.win_order_keys.push_back(o.Get("col").As<Napi::String>().Utf8Value());
        step.win_order_descs.push_back(
            o.Has("descending") && o.Get("descending").As<Napi::Boolean>().Value());
    }

    // Functions
    Napi::Array funcs = op.Get("funcs").As<Napi::Array>();
    for (uint32_t i = 0; i < funcs.Length(); i++) {
        Napi::Object f = funcs.Get(i).As<Napi::Object>();
        std::string kind = f.Get("kind").As<Napi::String>().Utf8Value();

        uint8_t k = 0;
        if (kind == "rowNumber")   k = 0;   // TD_WIN_ROW_NUMBER
        else if (kind == "rank")   k = 1;   // TD_WIN_RANK
        else if (kind == "denseRank") k = 2; // TD_WIN_DENSE_RANK
        else if (kind == "ntile")  k = 3;   // TD_WIN_NTILE
        else if (kind == "sum")    k = 4;
        else if (kind == "avg")    k = 5;
        else if (kind == "min")    k = 6;
        else if (kind == "max")    k = 7;
        else if (kind == "count")  k = 8;
        else if (kind == "lag")    k = 9;
        else if (kind == "lead")   k = 10;
        else if (kind == "firstValue") k = 11;
        else if (kind == "lastValue")  k = 12;
        else if (kind == "nthValue")   k = 13;
        step.win_func_kinds.push_back(k);

        std::string col_name = "";
        if (f.Has("col") && f.Get("col").IsString())
            col_name = f.Get("col").As<Napi::String>().Utf8Value();
        step.win_func_cols.push_back(col_name);

        int64_t param = 0;
        if (f.Has("n") && f.Get("n").IsNumber())
            param = f.Get("n").As<Napi::Number>().Int64Value();
        else if (f.Has("offset") && f.Get("offset").IsNumber())
            param = f.Get("offset").As<Napi::Number>().Int64Value();
        step.win_func_params.push_back(param);
    }

    // Frame (optional)
    if (op.Has("frame") && op.Get("frame").IsObject()) {
        Napi::Object frame = op.Get("frame").As<Napi::Object>();
        if (frame.Has("type")) {
            std::string ft = frame.Get("type").As<Napi::String>().Utf8Value();
            step.win_frame_type = (ft == "range") ? 1 : 0;
        }
        // Parse start/end bounds — helper needed
        // Default: UNBOUNDED_PRECEDING to CURRENT_ROW
        auto parseBound = [](Napi::Value v, uint8_t& bound, int64_t& n) {
            if (v.IsString()) {
                std::string s = v.As<Napi::String>().Utf8Value();
                if (s == "unboundedPreceding") { bound = 0; n = 0; }
                else if (s == "currentRow")    { bound = 2; n = 0; }
                else if (s == "unboundedFollowing") { bound = 4; n = 0; }
            } else if (v.IsObject()) {
                Napi::Object o = v.As<Napi::Object>();
                if (o.Has("preceding")) { bound = 1; n = o.Get("preceding").As<Napi::Number>().Int64Value(); }
                else if (o.Has("following")) { bound = 3; n = o.Get("following").As<Napi::Number>().Int64Value(); }
            }
        };
        if (frame.Has("start")) parseBound(frame.Get("start"), step.win_frame_start, step.win_frame_start_n);
        if (frame.Has("end")) parseBound(frame.Get("end"), step.win_frame_end, step.win_frame_end_n);
    }
}
```

**Step 6: Update ExecutePlan for window**

```cpp
else if (step.type == "window") {
    td_op_t* table_node = current ? current : td_const_table(g, tbl);
    if (filter_pred) {
        table_node = td_filter(g, table_node, filter_pred);
        filter_pred = nullptr;
    }

    uint8_t n_part = (uint8_t)step.win_part_keys.size();
    std::vector<td_op_t*> part_keys(n_part);
    for (uint8_t i = 0; i < n_part; i++)
        part_keys[i] = td_scan(g, step.win_part_keys[i].c_str());

    uint8_t n_order = (uint8_t)step.win_order_keys.size();
    std::vector<td_op_t*> order_keys(n_order);
    std::vector<uint8_t> order_descs(n_order);
    for (uint8_t i = 0; i < n_order; i++) {
        order_keys[i] = td_scan(g, step.win_order_keys[i].c_str());
        order_descs[i] = step.win_order_descs[i] ? 1 : 0;
    }

    uint8_t n_funcs = (uint8_t)step.win_func_kinds.size();
    std::vector<td_op_t*> func_inputs(n_funcs);
    for (uint8_t i = 0; i < n_funcs; i++) {
        if (!step.win_func_cols[i].empty())
            func_inputs[i] = td_scan(g, step.win_func_cols[i].c_str());
        else
            func_inputs[i] = nullptr;  // rowNumber, rank etc. don't need input
    }

    current = td_window_op(g, table_node,
        part_keys.data(), n_part,
        order_keys.data(), order_descs.data(), n_order,
        step.win_func_kinds.data(), func_inputs.data(),
        step.win_func_params.data(), n_funcs,
        step.win_frame_type, step.win_frame_start, step.win_frame_end,
        step.win_frame_start_n, step.win_frame_end_n);
}
```

**Step 7: Update lib/index.ts exports**

```typescript
export type { WindowFunc, WindowFuncKind, FrameBound, WindowOpts, JoinOpts, WindowJoinOpts } from './types';
```

**Step 8: Build and run**

Run: `npm run build && npx vitest run test/query-extended.test.ts`
Expected: PASS

**Step 9: Commit**

```bash
git add lib/types.ts lib/query.ts lib/table.ts lib/index.ts src/query.h src/query.cpp test/query-extended.test.ts
git commit -m "feat(query): add window functions with full frame specification"
```

---

### Task 2.5: Add windowJoin to Query

- [x] Add windowJoin (ASOF-style) operation to Query and wire through SerializePlan/ExecutePlan

**Files:**
- Modify: `lib/query.ts`
- Modify: `src/query.h`
- Modify: `src/query.cpp`
- Test: `test/query-extended.test.ts`

**Step 1: Write failing test**

Add to `test/query-extended.test.ts`:

```typescript
it('windowJoin (ASOF-style)', () => {
  const ctx = new Context();
  try {
    // This test exercises the wiring; real ASOF needs time-series data.
    // For now, just verify it doesn't crash with compatible inputs.
    const sales = ctx.readCsvSync(SALES);
    const orders = ctx.readCsvSync(ORDERS);
    // windowJoin needs time and sym columns — may need dedicated fixtures
    // For now, test the TypeScript API compiles and serializes correctly
    expect(typeof sales.windowJoin).toBe('undefined'); // will fail once we add it
  } finally {
    ctx.destroy();
  }
});
```

Note: A proper ASOF test needs time-series fixture data. Create `test/fixtures/trades.csv` and `test/fixtures/quotes.csv` for a real test once wiring is confirmed. For now, test the plumbing.

**Step 2: Add windowJoin to Query and Table**

In `lib/query.ts`:

```typescript
windowJoin(other: Table, opts: WindowJoinOpts): Query {
    const aggExprs = opts.aggs;
    this._ops.push({
        type: 'windowJoin',
        rightTable: other._native,
        timeKey: opts.timeKey,
        symKey: opts.symKey,
        windowLo: opts.windowLo,
        windowHi: opts.windowHi,
        aggs: aggExprs,
    });
    return this;
}
```

In `lib/table.ts`:

```typescript
windowJoin(other: Table, opts: WindowJoinOpts): Query {
    return new Query(this._native, this._ctx).windowJoin(other, opts);
}
```

Import `WindowJoinOpts` from `./types`.

**Step 3: Update PlanStep and wire through SerializePlan/ExecutePlan**

Follow the same pattern as join — register right table with `td_graph_add_table`, decompose aggs with `DecomposeAgg`, call `td_window_join`.

PlanStep fields:

```cpp
// For 'windowJoin'
td_t* wjoin_right_table = nullptr;
std::string wjoin_time_key;
std::string wjoin_sym_key;
int64_t wjoin_lo = 0;
int64_t wjoin_hi = 0;
std::vector<std::shared_ptr<ExprNode>> wjoin_agg_exprs;
```

**Step 4: Build and run**

Run: `npm run build && npx vitest run test/query-extended.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/query.ts lib/table.ts src/query.h src/query.cpp test/query-extended.test.ts
git commit -m "feat(query): add windowJoin (ASOF-style) operation"
```

---

## Phase 3: I/O Layer

### Task 3.1: Add CSV write

- [x] Add writeCsvSync and writeCsv methods to Context and NativeContext

**Files:**
- Modify: `lib/context.ts`
- Modify: `src/context.h`
- Modify: `src/context.cpp`
- Test: `test/io.test.ts`

**Step 1: Write failing test**

Create `test/io.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Context, col } from '../lib';

const SMALL = path.join(__dirname, 'fixtures', 'small.csv');

describe('I/O operations', () => {
  it('writeCsvSync writes a CSV file', () => {
    const ctx = new Context();
    const outPath = path.join(os.tmpdir(), `teide-test-${Date.now()}.csv`);
    try {
      const df = ctx.readCsvSync(SMALL);
      ctx.writeCsvSync(df, outPath);
      expect(fs.existsSync(outPath)).toBe(true);
      const content = fs.readFileSync(outPath, 'utf-8');
      expect(content).toContain('name');
      expect(content).toContain('alpha');
    } finally {
      ctx.destroy();
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
  });

  it('writeCsv writes async', async () => {
    const ctx = new Context();
    const outPath = path.join(os.tmpdir(), `teide-test-async-${Date.now()}.csv`);
    try {
      const df = await ctx.readCsv(SMALL);
      await ctx.writeCsv(df, outPath);
      expect(fs.existsSync(outPath)).toBe(true);
    } finally {
      ctx.destroy();
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
  });
});
```

**Step 2: Run test to verify failure**

Run: `npm run build && npx vitest run test/io.test.ts`
Expected: FAIL — `writeCsvSync` is not a function

**Step 3: Add to NativeContext C++ class**

In `src/context.h`, add method declarations:

```cpp
Napi::Value WriteCsvSync(const Napi::CallbackInfo& info);
Napi::Value WriteCsv(const Napi::CallbackInfo& info);
```

In `src/context.cpp`, register in DefineClass:

```cpp
InstanceMethod("writeCsvSync", &NativeContext::WriteCsvSync),
InstanceMethod("writeCsv", &NativeContext::WriteCsv),
```

Implement:

```cpp
Napi::Value NativeContext::WriteCsvSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 2 || !info[1].IsString()) {
        Napi::TypeError::New(env, "writeCsvSync(table, path)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string path = info[1].As<Napi::String>().Utf8Value();
    td_t* tbl = table->ptr();

    void* result = thread_->dispatch_sync([tbl, path]() -> void* {
        td_err_t err = td_write_csv(tbl, path.c_str());
        return (void*)(uintptr_t)err;
    });

    td_err_t err = (td_err_t)(uintptr_t)result;
    if (err != TD_OK) {
        Napi::Error::New(env, std::string("Failed to write CSV: ") + td_err_str(err))
            .ThrowAsJavaScriptException();
    }
    return env.Undefined();
}
```

Async variant follows the same deferred + tsfn pattern.

**Step 4: Add to TypeScript Context**

In `lib/context.ts`:

```typescript
writeCsvSync(table: Table, filePath: string): void {
    this._checkAlive();
    this._native.writeCsvSync(table._native, filePath);
}

async writeCsv(table: Table, filePath: string): Promise<void> {
    this._checkAlive();
    await this._native.writeCsv(table._native, filePath);
}
```

**Step 5: Build and run**

Run: `npm run build && npx vitest run test/io.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add lib/context.ts src/context.h src/context.cpp test/io.test.ts
git commit -m "feat(io): add writeCsvSync and writeCsv"
```

---

### Task 3.2: Add CSV read with options

- [x] Add CSV read options (delimiter, header, columnTypes) to readCsvSync and readCsv

**Files:**
- Modify: `src/context.h`
- Modify: `src/context.cpp`
- Modify: `lib/context.ts`
- Test: `test/io.test.ts`

**Step 1: Write failing test**

Add to `test/io.test.ts`:

```typescript
it('readCsvSync with delimiter option', () => {
  const ctx = new Context();
  // Create a tab-separated file for testing
  const tsvPath = path.join(os.tmpdir(), `teide-test-${Date.now()}.tsv`);
  fs.writeFileSync(tsvPath, 'a\tb\n1\t2\n3\t4\n');
  try {
    const df = ctx.readCsvSync(tsvPath, { delimiter: '\t' });
    expect(df.nRows).toBe(2);
    expect(df.columns).toContain('a');
  } finally {
    ctx.destroy();
    if (fs.existsSync(tsvPath)) fs.unlinkSync(tsvPath);
  }
});
```

**Step 2: Implement**

In `src/context.cpp`, modify `ReadCsvSync` to check for options argument:

```cpp
Napi::Value NativeContext::ReadCsvSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string path").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();

    // Check for options object
    bool has_opts = info.Length() >= 2 && info[1].IsObject();
    char delimiter = ',';
    bool header = true;
    std::vector<int8_t> col_types;

    if (has_opts) {
        Napi::Object opts = info[1].As<Napi::Object>();
        if (opts.Has("delimiter") && opts.Get("delimiter").IsString()) {
            std::string d = opts.Get("delimiter").As<Napi::String>().Utf8Value();
            if (!d.empty()) delimiter = d[0];
        }
        if (opts.Has("header") && opts.Get("header").IsBoolean()) {
            header = opts.Get("header").As<Napi::Boolean>().Value();
        }
        if (opts.Has("columnTypes") && opts.Get("columnTypes").IsArray()) {
            Napi::Array types = opts.Get("columnTypes").As<Napi::Array>();
            // Map type strings to TD_* constants
            for (uint32_t i = 0; i < types.Length(); i++) {
                std::string t = types.Get(i).As<Napi::String>().Utf8Value();
                int8_t td_type = TD_F64; // default
                if (t == "bool")      td_type = TD_BOOL;
                else if (t == "u8")   td_type = TD_U8;
                else if (t == "i16")  td_type = TD_I16;
                else if (t == "i32")  td_type = TD_I32;
                else if (t == "i64")  td_type = TD_I64;
                else if (t == "f64")  td_type = TD_F64;
                else if (t == "sym")  td_type = TD_SYM;
                else if (t == "date") td_type = TD_DATE;
                else if (t == "time") td_type = TD_TIME;
                else if (t == "timestamp") td_type = TD_TIMESTAMP;
                col_types.push_back(td_type);
            }
        }
    }

    void* result;
    if (has_opts) {
        int32_t n_types = (int32_t)col_types.size();
        const int8_t* types_ptr = n_types > 0 ? col_types.data() : nullptr;
        result = thread_->dispatch_sync([path, delimiter, header, col_types, n_types, types_ptr]() -> void* {
            return (void*)td_read_csv_opts(path.c_str(), delimiter, header,
                                            col_types.data(), (int32_t)col_types.size());
        });
    } else {
        result = thread_->dispatch_sync([path]() -> void* {
            return (void*)td_read_csv(path.c_str());
        });
    }

    // ... error handling same as before
}
```

Update TypeScript signature:

```typescript
interface CsvReadOpts {
  delimiter?: string;
  header?: boolean;
  columnTypes?: string[];
}

readCsvSync(filePath: string, opts?: CsvReadOpts): Table {
    this._checkAlive();
    return new Table(
        opts ? this._native.readCsvSync(filePath, opts) : this._native.readCsvSync(filePath),
        this._native
    );
}
```

**Step 3: Build and run**

Run: `npm run build && npx vitest run test/io.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add lib/context.ts src/context.h src/context.cpp test/io.test.ts
git commit -m "feat(io): add CSV read with options (delimiter, header, columnTypes)"
```

---

### Task 3.3: Add splayed table save/load

- [x] Add saveTableSync/loadTableSync for splayed table persistence

**Files:**
- Modify: `lib/context.ts`
- Modify: `src/context.h`
- Modify: `src/context.cpp`
- Test: `test/io.test.ts`

**Step 1: Write failing test**

```typescript
it('save and load splayed table', () => {
  const ctx = new Context();
  const dir = path.join(os.tmpdir(), `teide-splay-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const df = ctx.readCsvSync(SMALL);
    ctx.saveTableSync(df, dir);
    const loaded = ctx.loadTableSync(dir);
    expect(loaded.nRows).toBe(3);
    expect(loaded.columns).toContain('name');
  } finally {
    ctx.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

**Step 2: Implement NativeContext methods**

Follow the same dispatch_sync pattern. `td_splay_save(tbl, dir, sym_path)` needs a sym_path — derive as `dir + "/.sym"`. `td_read_splayed(dir, sym_path)` to load.

```cpp
Napi::Value NativeContext::SaveTableSync(const Napi::CallbackInfo& info) {
    // ... validate args
    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string dir = info[1].As<Napi::String>().Utf8Value();
    std::string sym_path = dir + "/.sym";
    td_t* tbl = table->ptr();

    void* result = thread_->dispatch_sync([tbl, dir, sym_path]() -> void* {
        td_err_t err = td_splay_save(tbl, dir.c_str(), sym_path.c_str());
        return (void*)(uintptr_t)err;
    });
    // ... error handling
}

Napi::Value NativeContext::LoadTableSync(const Napi::CallbackInfo& info) {
    // ... validate args
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    std::string sym_path = dir + "/.sym";

    void* result = thread_->dispatch_sync([dir, sym_path]() -> void* {
        return (void*)td_read_splayed(dir.c_str(), sym_path.c_str());
    });
    // ... wrap as NativeTable
}
```

**Step 3: Add TypeScript wrappers, build, test, commit**

```bash
git commit -m "feat(io): add splayed table save/load"
```

---

### Task 3.4: Add column save/load/mmap

- [x] Add column save/load/mmap methods to Series and Context

**Files:**
- Modify: `lib/series.ts` — add save methods
- Modify: `lib/context.ts` — add loadCol, mmapCol
- Modify: `src/series.h`, `src/series.cpp` — add Save methods
- Modify: `src/context.h`, `src/context.cpp` — add loadCol, mmapCol
- Test: `test/io.test.ts`

Follow the same dispatch_sync pattern. `NativeSeries` needs a `thread_` accessor to dispatch save. `td_col_save(vec, path)`, `td_col_load(path)`, `td_col_mmap(path)`.

**Commit:** `git commit -m "feat(io): add column save/load/mmap"`

---

### Task 3.5: Add partitioned table load

- [x] Add partitioned table load via td_read_parted

**Files:**
- Modify: `lib/context.ts`
- Modify: `src/context.h`, `src/context.cpp`
- Test: `test/io.test.ts`

`td_read_parted(db_root, table_name)` — dispatch through TeideThread.

**Commit:** `git commit -m "feat(io): add partitioned table load"`

---

### Task 3.6: Add symbol table and metadata persistence

- [x] Add symbol table and metadata save/load methods to Context

**Files:**
- Modify: `lib/context.ts`
- Modify: `src/context.h`, `src/context.cpp`
- Test: `test/io.test.ts`

Methods: `saveSymbolsSync`, `loadSymbolsSync`, `saveMetaSync`, `loadMetaSync` + async variants.

C calls: `td_sym_save(path)`, `td_sym_load(path)`, `td_meta_save_d(schema, path)`, `td_meta_load_d(path)`.

**Commit:** `git commit -m "feat(io): add symbol table and metadata persistence"`

---

## Phase 4: Table Construction

### Task 4.1: Implement Table.fromArraysSync

- [x] Implement Table.fromArraysSync for constructing tables from JS arrays and TypedArrays

**Files:**
- Modify: `lib/table.ts` — add static factory
- Modify: `src/table.h`, `src/table.cpp` — add TableFromArraysSync C++ function
- Modify: `src/addon.cpp` — register new export
- Test: `test/table-builder.test.ts`

**Step 1: Write failing test**

Create `test/table-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Context, Table } from '../lib';

describe('Table construction', () => {
  it('fromArraysSync with number arrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        x: [1, 2, 3],
        y: [4.0, 5.0, 6.0],
      });
      expect(t.nRows).toBe(3);
      expect(t.nCols).toBe(2);
      expect(t.columns).toContain('x');
      expect(t.columns).toContain('y');
    } finally {
      ctx.destroy();
    }
  });

  it('fromArraysSync with TypedArrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        vals: new Float64Array([1.1, 2.2, 3.3]),
      });
      expect(t.nRows).toBe(3);
      const data = t.col('vals').data;
      expect(data[0]).toBeCloseTo(1.1);
    } finally {
      ctx.destroy();
    }
  });

  it('fromArraysSync with string arrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        names: ['alice', 'bob', 'charlie'],
      });
      expect(t.nRows).toBe(3);
      expect(t.col('names').dtype).toBe('sym');
    } finally {
      ctx.destroy();
    }
  });

  it('fromArraysSync with boolean arrays', () => {
    const ctx = new Context();
    try {
      const t = Table.fromArraysSync(ctx, {
        flags: [true, false, true],
      });
      expect(t.nRows).toBe(3);
      expect(t.col('flags').dtype).toBe('bool');
    } finally {
      ctx.destroy();
    }
  });
});
```

**Step 2: Implement C++ TableFromArraysSync**

In `src/table.cpp`, add a standalone function (registered in addon.cpp):

```cpp
Napi::Value TableFromArraysSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    // info[0] = NativeContext (to get thread)
    // info[1] = JS object { colName: array, ... }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    Napi::Object data = info[1].As<Napi::Object>();
    Napi::Array keys = data.GetPropertyNames();
    uint32_t ncols = keys.Length();

    // Serialize column data on V8 thread
    struct ColSpec {
        std::string name;
        int8_t type;
        std::vector<double> f64_data;
        std::vector<int64_t> i64_data;
        std::vector<uint8_t> bool_data;
        std::vector<std::string> str_data;
        int64_t length;
    };
    std::vector<ColSpec> cols(ncols);

    for (uint32_t i = 0; i < ncols; i++) {
        cols[i].name = keys.Get(i).As<Napi::String>().Utf8Value();
        Napi::Value val = data.Get(cols[i].name);

        if (val.IsTypedArray()) {
            // Handle TypedArrays — copy data to vector
            Napi::TypedArray ta = val.As<Napi::TypedArray>();
            // ... detect type from TypedArray type, copy data
        } else if (val.IsArray()) {
            Napi::Array arr = val.As<Napi::Array>();
            cols[i].length = arr.Length();
            if (arr.Length() == 0) { cols[i].type = TD_F64; continue; }
            Napi::Value first = arr.Get((uint32_t)0);
            if (first.IsBoolean()) {
                cols[i].type = TD_BOOL;
                for (uint32_t j = 0; j < arr.Length(); j++)
                    cols[i].bool_data.push_back(arr.Get(j).As<Napi::Boolean>().Value() ? 1 : 0);
            } else if (first.IsString()) {
                cols[i].type = TD_SYM;
                for (uint32_t j = 0; j < arr.Length(); j++)
                    cols[i].str_data.push_back(arr.Get(j).As<Napi::String>().Utf8Value());
            } else { // number
                cols[i].type = TD_F64;
                for (uint32_t j = 0; j < arr.Length(); j++)
                    cols[i].f64_data.push_back(arr.Get(j).As<Napi::Number>().DoubleValue());
            }
        }
    }

    // Execute on Teide thread
    void* result = thread->dispatch_sync([&cols, ncols]() -> void* {
        td_t* tbl = td_table_new((int64_t)ncols);
        if (TD_IS_ERR(tbl)) return tbl;

        for (uint32_t i = 0; i < ncols; i++) {
            int64_t name_id = td_sym_intern(cols[i].name.c_str(), cols[i].name.size());
            int64_t len = cols[i].length;
            td_t* vec;

            if (cols[i].type == TD_SYM) {
                uint8_t width = td_sym_dict_width(td_sym_count() + len);
                vec = td_sym_vec_new(width, len);
                if (TD_IS_ERR(vec)) return vec;
                vec->len = len;
                for (int64_t j = 0; j < len; j++) {
                    int64_t sid = td_sym_intern(cols[i].str_data[j].c_str(),
                                                 cols[i].str_data[j].size());
                    td_write_sym(td_data(vec), j, (uint64_t)sid, TD_SYM, vec->attrs);
                }
            } else {
                vec = td_vec_new(cols[i].type, len);
                if (TD_IS_ERR(vec)) return vec;
                vec->len = len;
                void* dst = td_data(vec);
                if (cols[i].type == TD_F64) {
                    memcpy(dst, cols[i].f64_data.data(), (size_t)len * 8);
                } else if (cols[i].type == TD_I64) {
                    memcpy(dst, cols[i].i64_data.data(), (size_t)len * 8);
                } else if (cols[i].type == TD_BOOL) {
                    memcpy(dst, cols[i].bool_data.data(), (size_t)len);
                }
            }
            td_table_add_col(tbl, name_id, vec);
        }
        return (void*)tbl;
    });

    td_t* tbl = (td_t*)result;
    if (TD_IS_ERR(tbl)) {
        Napi::Error::New(env, std::string("Table creation failed: ") + td_err_str(TD_ERR_CODE(tbl)))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, tbl, thread);
}
```

Register in `src/addon.cpp`:

```cpp
exports.Set("tableFromArraysSync", Napi::Function::New(env, TableFromArraysSync));
```

**Step 3: Add TypeScript factory**

In `lib/table.ts`:

```typescript
static fromArraysSync(ctx: Context, data: Record<string, any>): Table {
    const result = addon.tableFromArraysSync(ctx._nativeCtx, data);
    return new Table(result, ctx._nativeCtx);
}
```

Note: Need to expose `_nativeCtx` from Context or pass the NativeContext object. Check the existing pattern — Context stores `this._native` which is the NativeContext. So use `(ctx as any)._native` or add a `_nativeCtx` getter.

**Step 4: Build and run**

Run: `npm run build && npx vitest run test/table-builder.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/table.ts src/table.h src/table.cpp src/addon.cpp test/table-builder.test.ts
git commit -m "feat(table): add Table.fromArraysSync for constructing tables from JS arrays"
```

---

### Task 4.2: Add Table.fromArrays (async variant)

- [x] Add Table.fromArrays async variant using dispatch_async

Follow the same pattern as 4.1 but with `dispatch_async`. Serialize on V8 thread, dispatch, resolve Promise with NativeTable.

**Commit:** `git commit -m "feat(table): add Table.fromArrays async variant"`

---

## Phase 5: Low-Level APIs

### Task 5.1: Add NativeVector class

- [x] Add NativeVector class wrapping td_vec_* API with Vector TypeScript wrapper

**Files:**
- Create: `src/vector.h`
- Create: `src/vector.cpp`
- Create: `lib/vector.ts`
- Modify: `src/addon.cpp` — register NativeVector
- Modify: `lib/index.ts` — export Vector
- Test: `test/low-level.test.ts`

**Step 1: Write failing test**

Create `test/low-level.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Context, Vector } from '../lib';

describe('Vector API', () => {
  it('creates and appends to a vector', () => {
    const ctx = new Context();
    try {
      let v = Vector.newSync(ctx, 'f64', 10);
      v = v.append(1.5);
      v = v.append(2.5);
      expect(v.length).toBe(2);
      expect(v.get(0)).toBeCloseTo(1.5);
    } finally {
      ctx.destroy();
    }
  });

  it('creates from raw TypedArray', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3]));
      expect(v.length).toBe(3);
    } finally {
      ctx.destroy();
    }
  });

  it('slice and concat', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3, 4, 5]));
      const s = v.slice(1, 3);
      expect(s.length).toBe(3);
      const v2 = Vector.fromRawSync(ctx, 'f64', new Float64Array([6, 7]));
      const merged = v.concat(v2);
      expect(merged.length).toBe(7);
    } finally {
      ctx.destroy();
    }
  });

  it('null handling', () => {
    const ctx = new Context();
    try {
      const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([1, 2, 3]));
      v.setNull(1, true);
      expect(v.isNull(1)).toBe(true);
      expect(v.isNull(0)).toBe(false);
    } finally {
      ctx.destroy();
    }
  });
});
```

**Step 2: Create src/vector.h**

```cpp
#pragma once
#include "teide_thread.h"
#include <string>

extern "C" { typedef union td_t td_t; }
class TeideThread;

class NativeVector : public Napi::ObjectWrap<NativeVector> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_t* vec, TeideThread* thread);
    NativeVector(const Napi::CallbackInfo& info);
    ~NativeVector();

    td_t* ptr() const { return vec_; }
    TeideThread* thread() const { return thread_; }

private:
    // Static factories
    static Napi::Value NewSync(const Napi::CallbackInfo& info);
    static Napi::Value FromRawSync(const Napi::CallbackInfo& info);

    // Instance methods
    Napi::Value Append(const Napi::CallbackInfo& info);
    Napi::Value Set(const Napi::CallbackInfo& info);
    Napi::Value Get(const Napi::CallbackInfo& info);
    Napi::Value Slice(const Napi::CallbackInfo& info);
    Napi::Value Concat(const Napi::CallbackInfo& info);
    void SetNull(const Napi::CallbackInfo& info);
    Napi::Value IsNull(const Napi::CallbackInfo& info);
    Napi::Value GetLength(const Napi::CallbackInfo& info);
    Napi::Value GetType(const Napi::CallbackInfo& info);

    td_t* vec_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    static Napi::FunctionReference constructor_;
};
```

**Step 3: Implement src/vector.cpp**

Follow the NativeTable/NativeSeries pattern. Each method dispatches through TeideThread. `td_vec_new`, `td_vec_append`, `td_vec_set`, `td_vec_get`, `td_vec_slice`, `td_vec_concat`, `td_vec_from_raw`, `td_vec_set_null`, `td_vec_is_null`.

**Step 4: Create lib/vector.ts**

```typescript
import path from 'path';
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export class Vector {
    /** @internal */
    constructor(private readonly _native: any) {}

    static newSync(ctx: any, type: string, capacity: number): Vector {
        return new Vector(addon.NativeVector.newSync(ctx._native, type, capacity));
    }

    static fromRawSync(ctx: any, type: string, data: ArrayBufferView): Vector {
        return new Vector(addon.NativeVector.fromRawSync(ctx._native, type, data));
    }

    append(value: number | bigint | boolean | string): Vector {
        return new Vector(this._native.append(value));
    }
    set(index: number, value: number | bigint | boolean | string): void { this._native.set(index, value); }
    get(index: number): number | bigint | boolean | string | null { return this._native.get(index); }
    slice(offset: number, length: number): Vector { return new Vector(this._native.slice(offset, length)); }
    concat(other: Vector): Vector { return new Vector(this._native.concat(other._native)); }
    setNull(index: number, isNull: boolean): void { this._native.setNull(index, isNull); }
    isNull(index: number): boolean { return this._native.isNull(index); }
    get length(): number { return this._native.length; }
    get type(): string { return this._native.type; }
    [Symbol.dispose](): void { /* release handled by GC */ }
}
```

**Step 5: Register in addon.cpp, export in index.ts**

**Step 6: Build and run**

Run: `npm run build && npx vitest run test/low-level.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/vector.h src/vector.cpp lib/vector.ts src/addon.cpp lib/index.ts test/low-level.test.ts
git commit -m "feat(low-level): add Vector class wrapping td_vec_* API"
```

---

### Task 5.2: Add NativeAtom class

- [x] Add NativeAtom class wrapping td_* atom constructors with Atom TypeScript wrapper

**Files:**
- Create: `src/atom.h`, `src/atom.cpp`
- Create: `lib/atom.ts`
- Modify: `src/addon.cpp`
- Modify: `lib/index.ts`
- Test: `test/low-level.test.ts`

Wrap `td_bool`, `td_u8`, `td_i16`, `td_i32`, `td_i64`, `td_f64`, `td_str`, `td_sym`, `td_date`, `td_time`, `td_timestamp`, `td_guid`. Each as a static factory method.

**Commit:** `git commit -m "feat(low-level): add Atom class wrapping td_* atom constructors"`

---

### Task 5.3: Add NativeList class

- [ ] Add NativeList class wrapping td_list_* API with List TypeScript wrapper

**Files:**
- Create: `src/list.h`, `src/list.cpp`
- Create: `lib/list.ts`
- Modify: `src/addon.cpp`
- Modify: `lib/index.ts`
- Test: `test/low-level.test.ts`

Wrap `td_list_new`, `td_list_append`, `td_list_get`, `td_list_set`.

**Commit:** `git commit -m "feat(low-level): add List class wrapping td_list_* API"`

---

### Task 5.4: Add NativeSelection class

- [ ] Add NativeSelection class wrapping td_sel_* API with Selection TypeScript wrapper

**Files:**
- Create: `src/selection.h`, `src/selection.cpp`
- Create: `lib/selection.ts`
- Modify: `src/addon.cpp`
- Modify: `lib/index.ts`
- Test: `test/low-level.test.ts`

Wrap `td_sel_new`, `td_sel_from_pred`, `td_sel_and`, `td_sel_recompute`.

**Commit:** `git commit -m "feat(low-level): add Selection class wrapping td_sel_* API"`

---

### Task 5.5: Add symbol table direct access and low-level table builder

- [ ] Add symbol table direct access (symIntern, symStr) and low-level table builder to Context and Table

**Files:**
- Modify: `lib/context.ts` — add symIntern, symFind, symStr, symCount
- Modify: `src/context.h`, `src/context.cpp` — expose sym methods
- Modify: `lib/table.ts` — add newSync, addCol, getColByIndex, setColName, schema
- Modify: `src/table.h`, `src/table.cpp` — add low-level methods
- Test: `test/low-level.test.ts`

**Tests:**

```typescript
it('symIntern and symStr roundtrip', () => {
  const ctx = new Context();
  try {
    const id = ctx.symIntern('hello');
    expect(typeof id).toBe('number');
    expect(ctx.symStr(id)).toBe('hello');
  } finally {
    ctx.destroy();
  }
});

it('low-level table builder', () => {
  const ctx = new Context();
  try {
    const v = Vector.fromRawSync(ctx, 'f64', new Float64Array([10, 20, 30]));
    const t = Table.newSync(ctx, 1);
    t.addCol('values', v);
    expect(t.nRows).toBe(3);
    expect(t.col('values').data[0]).toBeCloseTo(10);
  } finally {
    ctx.destroy();
  }
});
```

**Commit:** `git commit -m "feat(low-level): add symbol table access and low-level table builder"`

---

## Summary

| Phase | Tasks | New Files | Modified Files |
|-------|-------|-----------|----------------|
| 1. Expressions | 1.1–1.6 | `test/expr-extended.test.ts` | `lib/expr.ts`, `src/query.h`, `src/query.cpp`, `test/expr.test.ts` |
| 2. Query | 2.1–2.5 | `lib/types.ts`, `test/query-extended.test.ts`, `test/fixtures/orders.csv` | `lib/query.ts`, `lib/table.ts`, `lib/index.ts`, `src/query.h`, `src/query.cpp` |
| 3. I/O | 3.1–3.6 | `test/io.test.ts` | `lib/context.ts`, `lib/series.ts`, `src/context.h`, `src/context.cpp`, `src/series.h`, `src/series.cpp` |
| 4. Table Construction | 4.1–4.2 | `test/table-builder.test.ts` | `lib/table.ts`, `src/table.h`, `src/table.cpp`, `src/addon.cpp` |
| 5. Low-Level | 5.1–5.5 | `src/vector.h`, `src/vector.cpp`, `lib/vector.ts`, `src/atom.h`, `src/atom.cpp`, `lib/atom.ts`, `src/list.h`, `src/list.cpp`, `lib/list.ts`, `src/selection.h`, `src/selection.cpp`, `lib/selection.ts`, `test/low-level.test.ts` | `src/addon.cpp`, `lib/index.ts`, `lib/context.ts`, `lib/table.ts`, `src/context.h`, `src/context.cpp`, `src/table.h`, `src/table.cpp` |

Total: ~20 tasks, ~15 new files, ~15 modified files.
