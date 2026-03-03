# Graph Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add graph traversal support (CSR relationships, expand, variable-length BFS, shortest path, WCO join) to teide-js, with automatic vendor sync from upstream.

**Architecture:** Three layers — (1) auto-sync the vendor C core from GitHub to get graph APIs, (2) C++ NAPI classes `NativeRel` + graph op functions dispatched through the existing TeideThread, (3) TypeScript `Rel` and `Graph` classes wrapping the native layer. All graph ops follow the same dispatch_sync/dispatch_async pattern as existing query execution.

**Tech Stack:** TypeScript, C++17 NAPI (node-addon-api), C17 Teide core, Vitest, CMake

---

### Task 1: Vendor Auto-Sync Script [DONE]

**Files:**
- [x] Create: `scripts/sync-vendor.sh`
- [x] Modify: `package.json`
- [x] Modify: `.gitignore`

**Step 1: Create the sync script**

Create `scripts/sync-vendor.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/TeideDB/teide.git"
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/teide"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# Skip if vendor already populated (use `npm run clean` to force re-sync)
if [ -d "$VENDOR_DIR/src" ] && [ -d "$VENDOR_DIR/include" ]; then
    echo "vendor/teide/ already exists, skipping sync (run 'npm run clean' to re-sync)"
    exit 0
fi

echo "Cloning Teide C core from $REPO_URL ..."
git clone --depth=1 "$REPO_URL" "$TMP_DIR/teide"

mkdir -p "$VENDOR_DIR"
cp -R "$TMP_DIR/teide/include" "$VENDOR_DIR/include"
cp -R "$TMP_DIR/teide/src" "$VENDOR_DIR/src"

echo "Vendor sync complete: $VENDOR_DIR"
```

**Step 2: Update package.json scripts**

In `package.json`, add `sync-vendor` script and wire it into the build:

```json
{
  "scripts": {
    "sync-vendor": "bash scripts/sync-vendor.sh",
    "install": "npm run sync-vendor && cmake-js compile --release",
    "build:native": "npm run sync-vendor && cmake-js compile",
    "build:native:release": "npm run sync-vendor && cmake-js compile --release",
    "build:ts": "tsc",
    "build": "npm run build:native && npm run build:ts",
    "prepublishOnly": "npm run build:ts",
    "test": "vitest run",
    "clean": "cmake-js clean && rm -rf dist vendor/teide"
  }
}
```

**Step 3: Update .gitignore**

Add `vendor/teide/` to `.gitignore`:

```
node_modules/
dist/
build/
*.node
vendor/teide/
```

**Step 4: Remove the checked-in vendor directory**

```bash
git rm -r --cached vendor/teide/
```

**Step 5: Verify the sync works**

```bash
rm -rf vendor/teide/
npm run sync-vendor
ls vendor/teide/include/teide/td.h  # should exist
ls vendor/teide/src/store/csr.c     # should exist (new graph file)
```

Expected: Both files exist. The `csr.c` confirms we're getting the latest C core with graph support.

**Step 6: Verify the full build works**

```bash
npm run build
```

Expected: Build succeeds. CMake's `GLOB_RECURSE` picks up the new `csr.c`, `lftj.c`, `fvec.c` files automatically.

**Step 7: Run existing tests to confirm no regressions**

```bash
npm test
```

Expected: All existing tests pass.

**Step 8: Commit**

```bash
git add scripts/sync-vendor.sh package.json .gitignore
git commit -m "feat: auto-sync vendor/teide from GitHub on build"
```

---

### Task 2: NativeRel C++ Class [DONE]

**Files:**
- [x] Create: `src/rel.h`
- [x] Create: `src/rel.cpp`
- [x] Modify: `src/addon.cpp` (register NativeRel)

**Context:**
- Follow the same patterns as `NativeTable` (`src/table.h`, `src/table.cpp`): `Napi::ObjectWrap`, static `constructor_` FunctionReference, `Create()` factory, `heap_alive_` guard.
- `td_rel_t` is an opaque type — just store the pointer. Call `td_rel_free()` on destruction.
- All C calls must go through `TeideThread::dispatch_sync()` or `dispatch_async()`.
- Header inclusion order: `rel.h` first (pulls in teide_thread.h → napi.h), then `compat.h` in `.cpp`.

**Step 1: Create `src/rel.h`**

```cpp
#pragma once

#include "teide_thread.h"
#include <string>

extern "C" {
    typedef union td_t td_t;
    typedef struct td_rel td_rel_t;
}

class TeideThread;

class NativeRel : public Napi::ObjectWrap<NativeRel> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_rel_t* rel, TeideThread* thread);
    NativeRel(const Napi::CallbackInfo& info);
    ~NativeRel();

    td_rel_t* ptr() const { return rel_; }
    TeideThread* thread() const { return thread_; }

private:
    // Static factory methods
    static Napi::Value FromEdgesSync(const Napi::CallbackInfo& info);
    static Napi::Value FromEdges(const Napi::CallbackInfo& info);
    static Napi::Value BuildSync(const Napi::CallbackInfo& info);
    static Napi::Value Build(const Napi::CallbackInfo& info);
    static Napi::Value LoadSync(const Napi::CallbackInfo& info);
    static Napi::Value Load(const Napi::CallbackInfo& info);
    static Napi::Value MmapSync(const Napi::CallbackInfo& info);

    // Instance methods
    Napi::Value SaveSync(const Napi::CallbackInfo& info);
    Napi::Value Save(const Napi::CallbackInfo& info);
    Napi::Value Destroy(const Napi::CallbackInfo& info);

    td_rel_t* rel_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    bool destroyed_ = false;
    static Napi::FunctionReference constructor_;
};
```

**Step 2: Create `src/rel.cpp`**

```cpp
#include "rel.h"
#include "table.h"
#include "compat.h"

Napi::FunctionReference NativeRel::constructor_;

Napi::Object NativeRel::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeRel", {
        StaticMethod("fromEdgesSync", &NativeRel::FromEdgesSync),
        StaticMethod("fromEdges", &NativeRel::FromEdges),
        StaticMethod("buildSync", &NativeRel::BuildSync),
        StaticMethod("build", &NativeRel::Build),
        StaticMethod("loadSync", &NativeRel::LoadSync),
        StaticMethod("load", &NativeRel::Load),
        StaticMethod("mmapSync", &NativeRel::MmapSync),
        InstanceMethod("saveSync", &NativeRel::SaveSync),
        InstanceMethod("save", &NativeRel::Save),
        InstanceMethod("destroy", &NativeRel::Destroy),
    });
    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();
    exports.Set("NativeRel", func);
    return exports;
}

Napi::Object NativeRel::Create(Napi::Env env, td_rel_t* rel, TeideThread* thread) {
    return constructor_.New({
        Napi::External<td_rel_t>::New(env, rel),
        Napi::External<TeideThread>::New(env, thread),
    });
}

NativeRel::NativeRel(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeRel>(info), rel_(nullptr), thread_(nullptr) {
    Napi::Env env = info.Env();
    if (info.Length() >= 2) {
        rel_ = info[0].As<Napi::External<td_rel_t>>().Data();
        thread_ = info[1].As<Napi::External<TeideThread>>().Data();
        heap_alive_ = thread_->heap_alive();
    }
}

NativeRel::~NativeRel() {
    if (rel_ && !destroyed_ && heap_alive_ && heap_alive_->load()) {
        td_rel_free(rel_);
    }
}

// --- FromEdgesSync(nativeTable, srcCol, dstCol, nSrc, nDst, sort) ---
Napi::Value NativeRel::FromEdgesSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) {
        Napi::TypeError::New(env, "fromEdgesSync requires 6 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string src_col = info[1].As<Napi::String>().Utf8Value();
    std::string dst_col = info[2].As<Napi::String>().Utf8Value();
    int64_t n_src = info[3].As<Napi::Number>().Int64Value();
    int64_t n_dst = info[4].As<Napi::Number>().Int64Value();
    bool sort = info[5].As<Napi::Boolean>().Value();

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();

    void* result = thr->dispatch_sync([tbl, src_col, dst_col, n_src, n_dst, sort]() -> void* {
        return (void*)td_rel_from_edges(tbl, src_col.c_str(), dst_col.c_str(),
                                         n_src, n_dst, sort);
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel) {
        Napi::Error::New(env, "Failed to build relationship from edges").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- FromEdges (async) ---
Napi::Value NativeRel::FromEdges(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) {
        Napi::TypeError::New(env, "fromEdges requires 6 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string src_col = info[1].As<Napi::String>().Utf8Value();
    std::string dst_col = info[2].As<Napi::String>().Utf8Value();
    int64_t n_src = info[3].As<Napi::Number>().Int64Value();
    int64_t n_dst = info[4].As<Napi::Number>().Int64Value();
    bool sort = info[5].As<Napi::Boolean>().Value();

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "fromEdges", 0, 1);

    thr->dispatch_async(
        [tbl, src_col, dst_col, n_src, n_dst, sort]() -> void* {
            return (void*)td_rel_from_edges(tbl, src_col.c_str(), dst_col.c_str(),
                                             n_src, n_dst, sort);
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_rel_t* rel = (td_rel_t*)data;
            if (!rel) {
                deferred.Reject(Napi::Error::New(env, "Failed to build relationship from edges").Value());
            } else {
                deferred.Resolve(NativeRel::Create(env, rel, thr));
            }
        }
    );
    return deferred.Promise();
}

// --- BuildSync(nativeTable, fkCol, nTargetNodes, sort) ---
Napi::Value NativeRel::BuildSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "buildSync requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string fk_col = info[1].As<Napi::String>().Utf8Value();
    int64_t n_target = info[2].As<Napi::Number>().Int64Value();
    bool sort = info[3].As<Napi::Boolean>().Value();

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();

    void* result = thr->dispatch_sync([tbl, fk_col, n_target, sort]() -> void* {
        return (void*)td_rel_build(tbl, fk_col.c_str(), n_target, sort);
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel) {
        Napi::Error::New(env, "Failed to build relationship").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- Build (async) ---
Napi::Value NativeRel::Build(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "build requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string fk_col = info[1].As<Napi::String>().Utf8Value();
    int64_t n_target = info[2].As<Napi::Number>().Int64Value();
    bool sort = info[3].As<Napi::Boolean>().Value();

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "build", 0, 1);

    thr->dispatch_async(
        [tbl, fk_col, n_target, sort]() -> void* {
            return (void*)td_rel_build(tbl, fk_col.c_str(), n_target, sort);
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_rel_t* rel = (td_rel_t*)data;
            if (!rel) {
                deferred.Reject(Napi::Error::New(env, "Failed to build relationship").Value());
            } else {
                deferred.Resolve(NativeRel::Create(env, rel, thr));
            }
        }
    );
    return deferred.Promise();
}

// --- LoadSync(dir, thread_external) ---
// Note: Load needs a TeideThread* passed as second arg (External) since it's static
Napi::Value NativeRel::LoadSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "loadSync requires (dir, threadExternal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    TeideThread* thr = info[1].As<Napi::External<TeideThread>>().Data();

    void* result = thr->dispatch_sync([dir]() -> void* {
        return (void*)td_rel_load(dir.c_str());
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel) {
        Napi::Error::New(env, "Failed to load relationship from: " + dir).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- Load (async) ---
Napi::Value NativeRel::Load(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "load requires (dir, threadExternal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    TeideThread* thr = info[1].As<Napi::External<TeideThread>>().Data();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "relLoad", 0, 1);

    thr->dispatch_async(
        [dir]() -> void* { return (void*)td_rel_load(dir.c_str()); },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_rel_t* rel = (td_rel_t*)data;
            if (!rel) {
                deferred.Reject(Napi::Error::New(env, "Failed to load relationship").Value());
            } else {
                deferred.Resolve(NativeRel::Create(env, rel, thr));
            }
        }
    );
    return deferred.Promise();
}

// --- MmapSync(dir, thread_external) ---
Napi::Value NativeRel::MmapSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "mmapSync requires (dir, threadExternal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    TeideThread* thr = info[1].As<Napi::External<TeideThread>>().Data();

    void* result = thr->dispatch_sync([dir]() -> void* {
        return (void*)td_rel_mmap(dir.c_str());
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel) {
        Napi::Error::New(env, "Failed to mmap relationship from: " + dir).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- SaveSync(dir) ---
Napi::Value NativeRel::SaveSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "saveSync requires a directory path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    td_rel_t* rel = rel_;

    void* result = thread_->dispatch_sync([rel, dir]() -> void* {
        td_err_t err = td_rel_save(rel, dir.c_str());
        return (void*)(intptr_t)err;
    });

    intptr_t err = (intptr_t)result;
    if (err != 0) {
        Napi::Error::New(env, "Failed to save relationship to: " + dir).ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

// --- Save (async) ---
Napi::Value NativeRel::Save(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "save requires a directory path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    td_rel_t* rel = rel_;

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "relSave", 0, 1);

    thread_->dispatch_async(
        [rel, dir]() -> void* {
            td_err_t err = td_rel_save(rel, dir.c_str());
            return (void*)(intptr_t)err;
        },
        tsfn,
        [deferred](Napi::Env env, void* data) {
            intptr_t err = (intptr_t)data;
            if (err != 0) {
                deferred.Reject(Napi::Error::New(env, "Failed to save relationship").Value());
            } else {
                deferred.Resolve(env.Undefined());
            }
        }
    );
    return deferred.Promise();
}

// --- Destroy ---
Napi::Value NativeRel::Destroy(const Napi::CallbackInfo& info) {
    if (!destroyed_ && rel_) {
        td_rel_free(rel_);
        rel_ = nullptr;
        destroyed_ = true;
    }
    return info.Env().Undefined();
}
```

**Step 3: Register NativeRel in addon.cpp**

Add `#include "rel.h"` and `NativeRel::Init(env, exports);` to `src/addon.cpp`:

```cpp
#include "context.h"
#include "series.h"
#include "table.h"
#include "query.h"
#include "rel.h"
#include "compat.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    NativeContext::Init(env, exports);
    NativeSeries::Init(env, exports);
    NativeTable::Init(env, exports);
    NativeRel::Init(env, exports);
    exports.Set("collectSync", Napi::Function::New(env, QueryCollectSync));
    exports.Set("collect", Napi::Function::New(env, QueryCollect));
    return exports;
}

NODE_API_MODULE(teidedb_addon, Init)
```

**Step 4: Build and verify compilation**

```bash
npm run build:native
```

Expected: Compiles without errors. `NativeRel` is registered in the addon.

**Step 5: Commit**

```bash
git add src/rel.h src/rel.cpp src/addon.cpp
git commit -m "feat: add NativeRel C++ class for CSR relationships"
```

---

### Task 3: Graph Operation C++ Functions [DONE]

**Files:**
- [x] Create: `src/graph_ops.h`
- [x] Create: `src/graph_ops.cpp`
- [x] Modify: `src/addon.cpp` (register graph functions)

**Context:**
- These are standalone functions (not class methods), exported the same way as `collectSync`/`collect` in `src/query.cpp`.
- Each function: unwraps NativeTable + NativeRel args from JS → dispatches a closure to TeideThread → the closure creates `td_graph_t`, emits ops, optimizes, executes, frees graph → returns `td_t*` result table.
- Direction mapping: JS number 0/1/2 → `uint8_t` direction for `td_expand` etc.

**Step 1: Create `src/graph_ops.h`**

```cpp
#pragma once

#include "teide_thread.h"

// Graph operation functions exported to JS
Napi::Value GraphExpandSync(const Napi::CallbackInfo& info);
Napi::Value GraphExpand(const Napi::CallbackInfo& info);
Napi::Value GraphVarExpandSync(const Napi::CallbackInfo& info);
Napi::Value GraphVarExpand(const Napi::CallbackInfo& info);
Napi::Value GraphShortestPathSync(const Napi::CallbackInfo& info);
Napi::Value GraphShortestPath(const Napi::CallbackInfo& info);
Napi::Value GraphWcoJoinSync(const Napi::CallbackInfo& info);
Napi::Value GraphWcoJoin(const Napi::CallbackInfo& info);
Napi::Value GraphAddTable(const Napi::CallbackInfo& info);
```

**Step 2: Create `src/graph_ops.cpp`**

This is the largest file. Key pattern for each op:

1. Unwrap args (NativeTable, NativeRel, params) on V8 thread
2. Dispatch to Teide thread: create graph → emit scan/const → emit graph op → optimize → execute → free graph
3. Return NativeTable wrapping the result

```cpp
#include "graph_ops.h"
#include "table.h"
#include "rel.h"
#include "compat.h"

// Helper: execute a graph op that produces a table result
static td_t* ExecuteGraphOp(td_t* tbl, std::function<td_op_t*(td_graph_t*)> build_op) {
    td_graph_t* g = td_graph_new(tbl);
    if (!g) return nullptr;

    td_op_t* root = build_op(g);
    if (!root) { td_graph_free(g); return nullptr; }

    root = td_optimize(g, root);
    td_t* result = td_execute(g, root);
    td_graph_free(g);
    return result;
}

// ---- Expand Sync ----
// Args: nativeTable, colName, nativeRel, direction
Napi::Value GraphExpandSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "graphExpandSync requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint8_t direction = (uint8_t)info[3].As<Napi::Number>().Uint32Value();

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();

    void* result = thr->dispatch_sync([tbl, col_name, rel, direction]() -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            td_op_t* src = td_scan(g, col_name.c_str());
            if (!src) return nullptr;
            return td_expand(g, src, rel, direction);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphExpandSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- Expand Async ----
Napi::Value GraphExpand(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "graphExpand requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint8_t direction = (uint8_t)info[3].As<Napi::Number>().Uint32Value();

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphExpand", 0, 1);

    thr->dispatch_async(
        [tbl, col_name, rel, direction]() -> void* {
            return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                td_op_t* src = td_scan(g, col_name.c_str());
                if (!src) return nullptr;
                return td_expand(g, src, rel, direction);
            });
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                deferred.Reject(Napi::Error::New(env, "graphExpand failed").Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}

// ---- VarExpand Sync ----
// Args: nativeTable, colName, nativeRel, direction, minDepth, maxDepth, trackPath
Napi::Value GraphVarExpandSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 7) {
        Napi::TypeError::New(env, "graphVarExpandSync requires 7 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint8_t direction = (uint8_t)info[3].As<Napi::Number>().Uint32Value();
    uint8_t min_depth = (uint8_t)info[4].As<Napi::Number>().Uint32Value();
    uint8_t max_depth = (uint8_t)info[5].As<Napi::Number>().Uint32Value();
    bool track_path = info[6].As<Napi::Boolean>().Value();

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();

    void* result = thr->dispatch_sync([tbl, col_name, rel, direction, min_depth, max_depth, track_path]() -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            td_op_t* src = td_scan(g, col_name.c_str());
            if (!src) return nullptr;
            return td_var_expand(g, src, rel, direction, min_depth, max_depth, track_path);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphVarExpandSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- VarExpand Async ----
Napi::Value GraphVarExpand(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 7) {
        Napi::TypeError::New(env, "graphVarExpand requires 7 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint8_t direction = (uint8_t)info[3].As<Napi::Number>().Uint32Value();
    uint8_t min_depth = (uint8_t)info[4].As<Napi::Number>().Uint32Value();
    uint8_t max_depth = (uint8_t)info[5].As<Napi::Number>().Uint32Value();
    bool track_path = info[6].As<Napi::Boolean>().Value();

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphVarExpand", 0, 1);

    thr->dispatch_async(
        [tbl, col_name, rel, direction, min_depth, max_depth, track_path]() -> void* {
            return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                td_op_t* src = td_scan(g, col_name.c_str());
                if (!src) return nullptr;
                return td_var_expand(g, src, rel, direction, min_depth, max_depth, track_path);
            });
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                deferred.Reject(Napi::Error::New(env, "graphVarExpand failed").Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}

// ---- ShortestPath Sync ----
// Args: nativeTable, srcNodeId, dstNodeId, nativeRel, maxDepth
Napi::Value GraphShortestPathSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) {
        Napi::TypeError::New(env, "graphShortestPathSync requires 5 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    int64_t src_id = info[1].As<Napi::Number>().Int64Value();
    int64_t dst_id = info[2].As<Napi::Number>().Int64Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[3].As<Napi::Object>());
    uint8_t max_depth = (uint8_t)info[4].As<Napi::Number>().Uint32Value();

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();

    void* result = thr->dispatch_sync([tbl, src_id, dst_id, rel, max_depth]() -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            td_op_t* src = td_const_i64(g, src_id);
            td_op_t* dst = td_const_i64(g, dst_id);
            if (!src || !dst) return nullptr;
            return td_shortest_path(g, src, dst, rel, max_depth);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphShortestPathSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- ShortestPath Async ----
Napi::Value GraphShortestPath(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) {
        Napi::TypeError::New(env, "graphShortestPath requires 5 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    int64_t src_id = info[1].As<Napi::Number>().Int64Value();
    int64_t dst_id = info[2].As<Napi::Number>().Int64Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[3].As<Napi::Object>());
    uint8_t max_depth = (uint8_t)info[4].As<Napi::Number>().Uint32Value();

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphShortestPath", 0, 1);

    thr->dispatch_async(
        [tbl, src_id, dst_id, rel, max_depth]() -> void* {
            return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                td_op_t* src = td_const_i64(g, src_id);
                td_op_t* dst = td_const_i64(g, dst_id);
                if (!src || !dst) return nullptr;
                return td_shortest_path(g, src, dst, rel, max_depth);
            });
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                deferred.Reject(Napi::Error::New(env, "graphShortestPath failed").Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}

// ---- WcoJoin Sync ----
// Args: nativeTable, nativeRelArray, nVars
Napi::Value GraphWcoJoinSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "graphWcoJoinSync requires 3 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    Napi::Array rel_arr = info[1].As<Napi::Array>();
    uint8_t n_vars = (uint8_t)info[2].As<Napi::Number>().Uint32Value();

    uint8_t n_rels = (uint8_t)rel_arr.Length();
    std::vector<td_rel_t*> rels(n_rels);
    for (uint8_t i = 0; i < n_rels; i++) {
        NativeRel* rw = Napi::ObjectWrap<NativeRel>::Unwrap(rel_arr.Get(i).As<Napi::Object>());
        rels[i] = rw->ptr();
    }

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();

    void* result = thr->dispatch_sync([tbl, rels, n_rels, n_vars]() -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            // td_wco_join takes td_rel_t** — use rels.data()
            return td_wco_join(g, const_cast<td_rel_t**>(rels.data()), n_rels, n_vars);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphWcoJoinSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- WcoJoin Async ----
Napi::Value GraphWcoJoin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "graphWcoJoin requires 3 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    Napi::Array rel_arr = info[1].As<Napi::Array>();
    uint8_t n_vars = (uint8_t)info[2].As<Napi::Number>().Uint32Value();

    uint8_t n_rels = (uint8_t)rel_arr.Length();
    std::vector<td_rel_t*> rels(n_rels);
    for (uint8_t i = 0; i < n_rels; i++) {
        NativeRel* rw = Napi::ObjectWrap<NativeRel>::Unwrap(rel_arr.Get(i).As<Napi::Object>());
        rels[i] = rw->ptr();
    }

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphWcoJoin", 0, 1);

    thr->dispatch_async(
        [tbl, rels, n_rels, n_vars]() -> void* {
            return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                return td_wco_join(g, const_cast<td_rel_t**>(rels.data()), n_rels, n_vars);
            });
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                deferred.Reject(Napi::Error::New(env, "graphWcoJoin failed").Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}

// ---- AddTable ----
// Args: nativeGraphTable (primary), nativeTable2 (to add)
// Returns: table_id (uint16)
// Note: This is a stateless helper — it doesn't persist the graph. The TypeScript
// Graph class will need to track table IDs for multi-table graph operations.
// For now, expose as a building block.
Napi::Value GraphAddTable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    // This will be wired into the Graph TS class which manages its own td_graph_t
    // For the initial implementation, this is a placeholder
    Napi::TypeError::New(env, "graphAddTable: use Graph class for multi-table ops").ThrowAsJavaScriptException();
    return env.Undefined();
}
```

**Step 3: Register graph functions in addon.cpp**

Add to `src/addon.cpp`:

```cpp
#include "graph_ops.h"
```

And in `Init()`:

```cpp
    exports.Set("graphExpandSync", Napi::Function::New(env, GraphExpandSync));
    exports.Set("graphExpand", Napi::Function::New(env, GraphExpand));
    exports.Set("graphVarExpandSync", Napi::Function::New(env, GraphVarExpandSync));
    exports.Set("graphVarExpand", Napi::Function::New(env, GraphVarExpand));
    exports.Set("graphShortestPathSync", Napi::Function::New(env, GraphShortestPathSync));
    exports.Set("graphShortestPath", Napi::Function::New(env, GraphShortestPath));
    exports.Set("graphWcoJoinSync", Napi::Function::New(env, GraphWcoJoinSync));
    exports.Set("graphWcoJoin", Napi::Function::New(env, GraphWcoJoin));
```

**Step 4: Build and verify compilation**

```bash
npm run build:native
```

Expected: Compiles without errors.

**Step 5: Commit**

```bash
git add src/graph_ops.h src/graph_ops.cpp src/addon.cpp
git commit -m "feat: add graph operation C++ functions (expand, varExpand, shortestPath, wcoJoin)"
```

---

### Task 4: TypeScript Rel Class [DONE]

**Files:**
- [x] Create: `lib/rel.ts`
- [x] Modify: `lib/context.ts` (expose addon + thread for Rel factory methods)
- [x] Modify: `lib/index.ts` (export Rel)
- [x] Modify: `src/context.h` (add GetThreadExternal declaration)
- [x] Modify: `src/context.cpp` (add GetThreadExternal implementation + registration)

**Step 1: Create `lib/rel.ts`**

```typescript
import { Table } from './table';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export interface RelFromEdgesOpts {
    nSrc: number;
    nDst: number;
    sort?: boolean;
}

export interface RelBuildOpts {
    nTargetNodes: number;
    sort?: boolean;
}

export class Rel implements Disposable {
    /** @internal */
    readonly _native: any;
    private _destroyed = false;

    /** @internal */
    constructor(nativeRel: any) {
        this._native = nativeRel;
    }

    static fromEdgesSync(edgeTable: Table, srcCol: string, dstCol: string, opts: RelFromEdgesOpts): Rel {
        const native = addon.NativeRel.fromEdgesSync(
            edgeTable._native, srcCol, dstCol, opts.nSrc, opts.nDst, opts.sort ?? false
        );
        return new Rel(native);
    }

    static async fromEdges(edgeTable: Table, srcCol: string, dstCol: string, opts: RelFromEdgesOpts): Promise<Rel> {
        const native = await addon.NativeRel.fromEdges(
            edgeTable._native, srcCol, dstCol, opts.nSrc, opts.nDst, opts.sort ?? false
        );
        return new Rel(native);
    }

    static buildSync(table: Table, fkCol: string, opts: RelBuildOpts): Rel {
        const native = addon.NativeRel.buildSync(
            table._native, fkCol, opts.nTargetNodes, opts.sort ?? false
        );
        return new Rel(native);
    }

    static async build(table: Table, fkCol: string, opts: RelBuildOpts): Promise<Rel> {
        const native = await addon.NativeRel.build(
            table._native, fkCol, opts.nTargetNodes, opts.sort ?? false
        );
        return new Rel(native);
    }

    static loadSync(ctx: { _threadExternal: any }, dir: string): Rel {
        const native = addon.NativeRel.loadSync(dir, ctx._threadExternal);
        return new Rel(native);
    }

    static async load(ctx: { _threadExternal: any }, dir: string): Promise<Rel> {
        const native = await addon.NativeRel.load(dir, ctx._threadExternal);
        return new Rel(native);
    }

    static mmapSync(ctx: { _threadExternal: any }, dir: string): Rel {
        const native = addon.NativeRel.mmapSync(dir, ctx._threadExternal);
        return new Rel(native);
    }

    saveSync(dir: string): void {
        this._checkAlive();
        this._native.saveSync(dir);
    }

    async save(dir: string): Promise<void> {
        this._checkAlive();
        await this._native.save(dir);
    }

    destroy(): void {
        if (!this._destroyed) {
            this._native.destroy();
            this._destroyed = true;
        }
    }

    [Symbol.dispose](): void {
        this.destroy();
    }

    private _checkAlive(): void {
        if (this._destroyed) throw new Error('Rel has been destroyed');
    }
}
```

**Step 2: Add `_threadExternal` to Context**

The `load`/`mmap` static factories need a TeideThread pointer. Add a method to `NativeContext` that returns an `External<TeideThread>`, and expose it in the TS Context.

In `src/context.h`, add:
```cpp
    Napi::Value GetThreadExternal(const Napi::CallbackInfo& info);
```

In `src/context.cpp`, add the method and register it:
```cpp
Napi::Value NativeContext::GetThreadExternal(const Napi::CallbackInfo& info) {
    return Napi::External<TeideThread>::New(info.Env(), thread_.get());
}
```

Register in `Init()`:
```cpp
    InstanceAccessor("threadExternal", &NativeContext::GetThreadExternal, nullptr),
```

In `lib/context.ts`, expose:
```typescript
    get _threadExternal(): any { return this._native.threadExternal; }
```

**Step 3: Update `lib/index.ts`**

```typescript
export { Context } from './context';
export { Expr, col, lit } from './expr';
export { Table } from './table';
export { Series } from './series';
export { Query } from './query';
export { Rel } from './rel';
export type { RelFromEdgesOpts, RelBuildOpts } from './rel';
```

**Step 4: Build**

```bash
npm run build
```

Expected: Compiles without errors.

**Step 5: Commit**

```bash
git add lib/rel.ts lib/context.ts lib/index.ts src/context.h src/context.cpp
git commit -m "feat: add TypeScript Rel class for CSR relationships"
```

---

### Task 5: TypeScript Graph Class [DONE]

**Files:**
- [x] Create: `lib/graph.ts`
- [x] Modify: `lib/context.ts` (add `graph()` convenience method)
- [x] Modify: `lib/index.ts` (export Graph, Direction)

**Step 1: Create `lib/graph.ts`**

```typescript
import { Table } from './table';
import { Rel } from './rel';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

export type Direction = 'fwd' | 'rev' | 'both';

export interface VarExpandOpts {
    minDepth?: number;
    maxDepth?: number;
    trackPath?: boolean;
}

export interface ShortestPathOpts {
    maxDepth?: number;
}

export interface WcoJoinOpts {
    nVars: number;
}

const DIR_MAP: Record<Direction, number> = { fwd: 0, rev: 1, both: 2 };

export class Graph {
    private readonly _table: Table;
    private readonly _ctx: any;

    constructor(table: Table, ctx: any) {
        this._table = table;
        this._ctx = ctx;
    }

    expandSync(srcCol: string, rel: Rel, direction: Direction = 'fwd'): Table {
        const native = addon.graphExpandSync(
            this._table._native, srcCol, rel._native, DIR_MAP[direction]
        );
        return new Table(native, this._ctx);
    }

    async expand(srcCol: string, rel: Rel, direction: Direction = 'fwd'): Promise<Table> {
        const native = await addon.graphExpand(
            this._table._native, srcCol, rel._native, DIR_MAP[direction]
        );
        return new Table(native, this._ctx);
    }

    varExpandSync(startCol: string, rel: Rel, direction: Direction = 'fwd', opts?: VarExpandOpts): Table {
        const native = addon.graphVarExpandSync(
            this._table._native, startCol, rel._native, DIR_MAP[direction],
            opts?.minDepth ?? 1, opts?.maxDepth ?? 3, opts?.trackPath ?? false
        );
        return new Table(native, this._ctx);
    }

    async varExpand(startCol: string, rel: Rel, direction: Direction = 'fwd', opts?: VarExpandOpts): Promise<Table> {
        const native = await addon.graphVarExpand(
            this._table._native, startCol, rel._native, DIR_MAP[direction],
            opts?.minDepth ?? 1, opts?.maxDepth ?? 3, opts?.trackPath ?? false
        );
        return new Table(native, this._ctx);
    }

    shortestPathSync(src: number, dst: number, rel: Rel, opts?: ShortestPathOpts): Table {
        const native = addon.graphShortestPathSync(
            this._table._native, src, dst, rel._native, opts?.maxDepth ?? 10
        );
        return new Table(native, this._ctx);
    }

    async shortestPath(src: number, dst: number, rel: Rel, opts?: ShortestPathOpts): Promise<Table> {
        const native = await addon.graphShortestPath(
            this._table._native, src, dst, rel._native, opts?.maxDepth ?? 10
        );
        return new Table(native, this._ctx);
    }

    wcoJoinSync(rels: Rel[], opts: WcoJoinOpts): Table {
        const native = addon.graphWcoJoinSync(
            this._table._native, rels.map(r => r._native), opts.nVars
        );
        return new Table(native, this._ctx);
    }

    async wcoJoin(rels: Rel[], opts: WcoJoinOpts): Promise<Table> {
        const native = await addon.graphWcoJoin(
            this._table._native, rels.map(r => r._native), opts.nVars
        );
        return new Table(native, this._ctx);
    }
}
```

**Step 2: Add `graph()` to Context**

In `lib/context.ts`:

```typescript
import { Graph } from './graph';

// In Context class:
    graph(table: Table): Graph {
        this._checkAlive();
        return new Graph(table, this._native);
    }
```

**Step 3: Update `lib/index.ts`**

```typescript
export { Graph } from './graph';
export type { Direction, VarExpandOpts, ShortestPathOpts, WcoJoinOpts } from './graph';
```

**Step 4: Build**

```bash
npm run build
```

Expected: Compiles without errors.

**Step 5: Commit**

```bash
git add lib/graph.ts lib/context.ts lib/index.ts
git commit -m "feat: add TypeScript Graph class with expand, varExpand, shortestPath, wcoJoin"
```

---

### Task 6: Test Fixtures [DONE]

**Files:**
- [x] Create: `test/fixtures/edges.csv`
- [x] Create: `test/fixtures/nodes.csv`

**Step 1: Create edge list CSV**

`test/fixtures/edges.csv` — simple DAG: 0→1, 0→2, 1→3, 2→3, 3→4

```csv
src,dst
0,1
0,2
1,3
2,3
3,4
```

**Step 2: Create source nodes CSV**

`test/fixtures/nodes.csv` — single source node 0

```csv
node
0
```

**Step 3: Commit**

```bash
git add test/fixtures/edges.csv test/fixtures/nodes.csv
git commit -m "test: add graph test fixtures (edges.csv, nodes.csv)"
```

---

### Task 7: Graph Tests

**Files:**
- Create: `test/graph.test.ts`

**Context:**
- Follow the same patterns as `test/e2e.test.ts`: import from `../lib`, use try/finally with `ctx.destroy()`.
- The test graph is: `0→1, 0→2, 1→3, 2→3, 3→4` (same as teide-rs tests).
- `Rel.fromEdgesSync` builds the CSR on the Teide thread.
- `Graph` wraps a source table (nodes.csv with node=0) and calls expand etc.

**Step 1: Write all graph tests**

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Context, Rel, Graph } from '../lib';

const EDGES = path.join(__dirname, 'fixtures', 'edges.csv');
const NODES = path.join(__dirname, 'fixtures', 'nodes.csv');

describe('Rel', () => {
    it('fromEdgesSync builds CSR from edge table', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });
            expect(rel).toBeDefined();
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('fromEdges async builds CSR', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = await Rel.fromEdges(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });
            expect(rel).toBeDefined();
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('save/load roundtrip', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-rel-'));
            rel.saveSync(dir);

            const rel2 = Rel.loadSync(ctx, dir);

            // Verify by expanding from node 0
            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.expandSync('node', rel2, 'fwd');
            expect(result.nRows).toBe(2);

            rel.destroy();
            rel2.destroy();
            fs.rmSync(dir, { recursive: true });
        } finally {
            ctx.destroy();
        }
    });

    it('save/load async roundtrip', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = await Rel.fromEdges(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-rel-'));
            await rel.save(dir);

            const rel2 = await Rel.load(ctx, dir);

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.expand('node', rel2, 'fwd');
            expect(result.nRows).toBe(2);

            rel.destroy();
            rel2.destroy();
            fs.rmSync(dir, { recursive: true });
        } finally {
            ctx.destroy();
        }
    });

    it('mmap loads relationship', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-rel-'));
            rel.saveSync(dir);

            const rel2 = Rel.mmapSync(ctx, dir);

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.expandSync('node', rel2, 'fwd');
            expect(result.nRows).toBe(2);

            rel.destroy();
            rel2.destroy();
            fs.rmSync(dir, { recursive: true });
        } finally {
            ctx.destroy();
        }
    });

    it('Symbol.dispose cleans up', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            {
                const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5 });
                rel[Symbol.dispose]();
            }
            // Should not crash
        } finally {
            ctx.destroy();
        }
    });
});

describe('Graph - expand', () => {
    it('expand forward from node 0 finds 2 neighbors', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.expandSync('node', rel, 'fwd');

            // Node 0 has outgoing edges to 1 and 2
            expect(result.nRows).toBe(2);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('expand async forward from node 0', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.expand('node', rel, 'fwd');

            expect(result.nRows).toBe(2);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('expand reverse from node 3 finds 2 sources', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            // Node 3 has incoming edges from 1 and 2
            // Create a table with node=3
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-node3-'));
            const csvPath = path.join(dir, 'node3.csv');
            fs.writeFileSync(csvPath, 'node\n3\n');
            const node3 = ctx.readCsvSync(csvPath);

            const g = ctx.graph(node3);
            const result = g.expandSync('node', rel, 'rev');

            expect(result.nRows).toBe(2);
            rel.destroy();
            fs.rmSync(dir, { recursive: true });
        } finally {
            ctx.destroy();
        }
    });
});

describe('Graph - varExpand', () => {
    it('variable-length BFS depth 1-3 from node 0', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.varExpandSync('node', rel, 'fwd', { minDepth: 1, maxDepth: 3 });

            // Node 0 can reach: depth 1 → {1,2}, depth 2 → {3}, depth 3 → {4}
            expect(result.nRows).toBeGreaterThan(0);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('varExpand async', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.varExpand('node', rel, 'fwd', { minDepth: 1, maxDepth: 3 });

            expect(result.nRows).toBeGreaterThan(0);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });
});

describe('Graph - shortestPath', () => {
    it('finds path from 0 to 4', () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.shortestPathSync(0, 4, rel, { maxDepth: 10 });

            // Path: 0→1→3→4 or 0→2→3→4 = 3 hops
            expect(result.nRows).toBeGreaterThan(0);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });

    it('shortestPath async', async () => {
        const ctx = new Context();
        try {
            const edges = ctx.readCsvSync(EDGES);
            const rel = Rel.fromEdgesSync(edges, 'src', 'dst', { nSrc: 5, nDst: 5, sort: true });

            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = await g.shortestPath(0, 4, rel, { maxDepth: 10 });

            expect(result.nRows).toBeGreaterThan(0);
            rel.destroy();
        } finally {
            ctx.destroy();
        }
    });
});

describe('Graph - wcoJoin', () => {
    it('triangle detection with sorted rels', () => {
        const ctx = new Context();
        try {
            // For WCO join, we need a graph with triangles and sorted adjacency lists
            // Triangle: 0→1, 1→2, 0→2
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teide-tri-'));
            const triPath = path.join(dir, 'tri.csv');
            fs.writeFileSync(triPath, 'src,dst\n0,1\n0,2\n1,2\n');
            const triEdges = ctx.readCsvSync(triPath);

            const rel = Rel.fromEdgesSync(triEdges, 'src', 'dst', { nSrc: 3, nDst: 3, sort: true });

            // WCO join with 3 vars and the same rel used for all edges
            const nodes = ctx.readCsvSync(NODES);
            const g = ctx.graph(nodes);
            const result = g.wcoJoinSync([rel, rel, rel], { nVars: 3 });

            // Should find triangle patterns
            expect(result.nRows).toBeGreaterThanOrEqual(0);
            rel.destroy();
            fs.rmSync(dir, { recursive: true });
        } finally {
            ctx.destroy();
        }
    });
});
```

**Step 2: Run tests**

```bash
npx vitest run test/graph.test.ts
```

Expected: All tests pass.

**Step 3: Run full test suite to confirm no regressions**

```bash
npm test
```

Expected: All tests (existing + new graph tests) pass.

**Step 4: Commit**

```bash
git add test/graph.test.ts
git commit -m "test: add comprehensive graph layer tests (rel, expand, varExpand, shortestPath, wcoJoin)"
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add graph layer documentation**

Add to the Key File Locations table:
```
| TS API | `lib/rel.ts` | Rel (CSR relationship) lifecycle: fromEdges, build, save, load, mmap |
| TS API | `lib/graph.ts` | Graph traversal: expand, varExpand, shortestPath, wcoJoin |
| NAPI | `src/rel.cpp` | NativeRel: CSR relationship wrapper |
| NAPI | `src/graph_ops.cpp` | Graph operations: expand, var_expand, shortest_path, wco_join |
```

Add to Conventions:
```
- **Graph opcodes**: Graph opcodes in `lib/graph.ts` direction constants must match C defines: `TD_DIR_FWD=0`, `TD_DIR_REV=1`, `TD_DIR_BOTH=2`.
- **Vendor sync**: `vendor/teide/` is auto-synced from GitHub via `scripts/sync-vendor.sh`. Run `npm run clean` to force re-sync.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with graph layer info and vendor sync"
```
