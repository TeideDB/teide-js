# teidedb Node.js NAPI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build zero-copy Node.js NAPI bindings for the Teide columnar dataframe engine with a dedicated Teide thread for non-blocking async execution.

**Architecture:** A C++ NAPI addon (node-addon-api + cmake-js) wraps the Teide C17 core. A dedicated background thread owns the Teide heap; all C calls are dispatched via an SPSC work queue. TypeScript wrappers provide a fluent, camelCase API with `col()`, `lit()`, `Expr`, `Query`, `Table`, `Series`.

**Tech Stack:** node-addon-api, cmake-js, TypeScript, vitest, Teide C core (vendored via symlink)

---

## Phase 1: Build System & Minimal Addon

### Task 1: Initialize npm package and TypeScript config

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "teidedb",
  "version": "0.1.0",
  "description": "Zero-copy Node.js bindings for the Teide columnar dataframe engine",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build:native": "cmake-js compile",
    "build:native:release": "cmake-js compile --release",
    "build:ts": "tsc",
    "build": "npm run build:native && npm run build:ts",
    "test": "vitest run",
    "clean": "cmake-js clean && rm -rf dist"
  },
  "keywords": ["dataframe", "columnar", "analytics", "napi"],
  "license": "MIT",
  "devDependencies": {
    "cmake-js": "^7.3.0",
    "node-addon-api": "^8.3.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "lib",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "node"
  },
  "include": ["lib/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
build/
*.node
```

**Step 4: Install dependencies**

Run: `cd /home/hetoku/data/work/teidedb/js && npm install`

**Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore package-lock.json
git commit -m "feat(js): init npm package with cmake-js and TypeScript"
```

---

### Task 2: Vendor the C core and create CMakeLists.txt

**Files:**
- Create: `vendor/teide` (symlink to `../../teide`)
- Create: `CMakeLists.txt`

**Step 1: Create vendor symlink**

```bash
mkdir -p vendor
ln -s ../../../teide vendor/teide
```

**Step 2: Create CMakeLists.txt**

```cmake
cmake_minimum_required(VERSION 3.15)
project(teidedb_addon LANGUAGES C CXX)

# C core: C17
set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

# Addon: C++17 (required by node-addon-api)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(TEIDE_PORTABLE "Build portable binary (no -march=native)" OFF)

# ---- Teide C core (static lib) ----
file(GLOB_RECURSE TEIDE_SOURCES CONFIGURE_DEPENDS "vendor/teide/src/**/*.c")
add_library(teide_core STATIC ${TEIDE_SOURCES})
target_include_directories(teide_core PUBLIC vendor/teide/include PRIVATE vendor/teide/src)

if(MSVC)
    target_compile_options(teide_core PRIVATE /O2 /DNDEBUG)
else()
    if(TEIDE_PORTABLE)
        target_compile_options(teide_core PRIVATE -O3 -mtune=generic -DNDEBUG)
    else()
        target_compile_options(teide_core PRIVATE -O3 -march=native -DNDEBUG)
    endif()
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_libraries(teide_core PUBLIC m pthread)
endif()

# ---- NAPI addon ----
file(GLOB_RECURSE ADDON_SOURCES CONFIGURE_DEPENDS "src/*.cpp")

# cmake-js provides: CMAKE_JS_INC, CMAKE_JS_LIB, CMAKE_JS_SRC
include_directories(${CMAKE_JS_INC})
add_library(${PROJECT_NAME} SHARED ${ADDON_SOURCES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} PRIVATE teide_core ${CMAKE_JS_LIB})

# node-addon-api headers
execute_process(
    COMMAND node -p "require('node-addon-api').include_dir"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NAPI_INCLUDE_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
target_include_directories(${PROJECT_NAME} PRIVATE ${NAPI_INCLUDE_DIR})
target_compile_definitions(${PROJECT_NAME} PRIVATE NAPI_VERSION=9 NAPI_DISABLE_CPP_EXCEPTIONS)
```

**Step 3: Commit**

```bash
git add CMakeLists.txt vendor
git commit -m "feat(js): add CMakeLists.txt and vendor C core symlink"
```

---

### Task 3: Create minimal addon that builds and loads

**Files:**
- Create: `src/addon.cpp`

**Step 1: Create src/addon.cpp**

```cpp
#include <napi.h>

extern "C" {
#include <teide/td.h>
}

Napi::String GetVersion(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), "0.1.0");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("version", Napi::Function::New(env, GetVersion));
    return exports;
}

NODE_API_MODULE(teidedb_addon, Init)
```

**Step 2: Build the native addon**

Run: `cd /home/hetoku/data/work/teidedb/js && npx cmake-js compile`
Expected: Builds successfully, produces `build/Release/teidedb_addon.node`

**Step 3: Write a smoke test**

Create `test/smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

describe('native addon', () => {
  it('loads and returns version', () => {
    expect(addon.version()).toBe('0.1.0');
  });
});
```

**Step 4: Run test**

Run: `cd /home/hetoku/data/work/teidedb/js && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/addon.cpp test/smoke.test.ts
git commit -m "feat(js): minimal NAPI addon builds and loads"
```

---

## Phase 2: Teide Thread & Context

### Task 4: Implement the Teide thread with SPSC work queue

**Files:**
- Create: `src/teide_thread.h`
- Create: `src/teide_thread.cpp`

This is the core threading infrastructure. A single background thread owns the Teide heap. Work items are dispatched via a mutex+condvar queue (simple, correct; SPSC lock-free can come later as optimization).

**Step 1: Create src/teide_thread.h**

```cpp
#pragma once
#include <napi.h>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <functional>
#include <atomic>

extern "C" {
#include <teide/td.h>
}

// Work item: a callable + a way to signal completion and return a result
struct WorkItem {
    std::function<void*()> work;          // runs on Teide thread, returns result
    std::function<void(void*)> on_done;   // runs on Teide thread after work, stores result
    void* result = nullptr;

    // For sync: caller blocks on this
    std::mutex mtx;
    std::condition_variable cv;
    bool done = false;
};

class TeideThread {
public:
    TeideThread();
    ~TeideThread();

    // Dispatch work synchronously (blocks caller until complete)
    void* dispatch_sync(std::function<void*()> work);

    // Dispatch work asynchronously (calls callback on main thread via tsfn)
    void dispatch_async(std::function<void*()> work,
                        Napi::ThreadSafeFunction tsfn,
                        std::function<void(Napi::Env, void*)> js_callback);

    // Shutdown the thread
    void shutdown();

    bool is_running() const { return running_.load(); }

private:
    void thread_main();

    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> shutdown_{false};

    std::mutex queue_mtx_;
    std::condition_variable queue_cv_;
    std::queue<std::shared_ptr<WorkItem>> queue_;
};
```

**Step 2: Create src/teide_thread.cpp**

```cpp
#include "teide_thread.h"

TeideThread::TeideThread() {
    running_ = true;
    thread_ = std::thread(&TeideThread::thread_main, this);
}

TeideThread::~TeideThread() {
    shutdown();
}

void TeideThread::thread_main() {
    // This thread owns the Teide heap
    td_heap_init();
    td_sym_init();

    while (!shutdown_.load()) {
        std::shared_ptr<WorkItem> item;
        {
            std::unique_lock<std::mutex> lock(queue_mtx_);
            queue_cv_.wait(lock, [&] { return !queue_.empty() || shutdown_.load(); });
            if (shutdown_.load() && queue_.empty()) break;
            if (queue_.empty()) continue;
            item = queue_.front();
            queue_.pop();
        }

        // Execute work on the Teide thread
        item->result = item->work();

        if (item->on_done) {
            item->on_done(item->result);
        }

        // Signal sync waiters
        {
            std::lock_guard<std::mutex> lock(item->mtx);
            item->done = true;
        }
        item->cv.notify_one();
    }

    td_pool_destroy();
    td_sym_destroy();
    td_heap_destroy();
    running_ = false;
}

void* TeideThread::dispatch_sync(std::function<void*()> work) {
    auto item = std::make_shared<WorkItem>();
    item->work = std::move(work);

    {
        std::lock_guard<std::mutex> lock(queue_mtx_);
        queue_.push(item);
    }
    queue_cv_.notify_one();

    // Block until the Teide thread completes this item
    std::unique_lock<std::mutex> lock(item->mtx);
    item->cv.wait(lock, [&] { return item->done; });
    return item->result;
}

void TeideThread::dispatch_async(std::function<void*()> work,
                                  Napi::ThreadSafeFunction tsfn,
                                  std::function<void(Napi::Env, void*)> js_callback) {
    auto cb = std::make_shared<std::function<void(Napi::Env, void*)>>(std::move(js_callback));
    auto item = std::make_shared<WorkItem>();
    item->work = std::move(work);
    item->on_done = [tsfn, cb](void* result) mutable {
        tsfn.BlockingCall(result, [cb](Napi::Env env, Napi::Function, void* data) {
            (*cb)(env, data);
        });
        tsfn.Release();
    };

    {
        std::lock_guard<std::mutex> lock(queue_mtx_);
        queue_.push(item);
    }
    queue_cv_.notify_one();
}

void TeideThread::shutdown() {
    if (!running_.load()) return;
    shutdown_ = true;
    queue_cv_.notify_one();
    if (thread_.joinable()) thread_.join();
}
```

**Step 3: Build to verify compilation**

Run: `cd /home/hetoku/data/work/teidedb/js && npx cmake-js compile`
Expected: Compiles cleanly (files not yet wired into addon.cpp)

**Step 4: Commit**

```bash
git add src/teide_thread.h src/teide_thread.cpp
git commit -m "feat(js): implement Teide thread with work queue dispatch"
```

---

### Task 5: Implement native Context class

**Files:**
- Create: `src/context.h`
- Create: `src/context.cpp`
- Modify: `src/addon.cpp`

**Step 1: Create src/context.h**

```cpp
#pragma once
#include <napi.h>
#include "teide_thread.h"

class NativeContext : public Napi::ObjectWrap<NativeContext> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    NativeContext(const Napi::CallbackInfo& info);
    ~NativeContext();

    TeideThread& thread() { return *thread_; }

    // Check if context is valid (not destroyed)
    void check_alive(Napi::Env env);

private:
    Napi::Value Destroy(const Napi::CallbackInfo& info);
    Napi::Value ReadCsvSync(const Napi::CallbackInfo& info);
    Napi::Value ReadCsv(const Napi::CallbackInfo& info);

    std::unique_ptr<TeideThread> thread_;
    bool destroyed_ = false;
};
```

**Step 2: Create src/context.cpp**

```cpp
#include "context.h"

Napi::Object NativeContext::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeContext", {
        InstanceMethod("destroy", &NativeContext::Destroy),
        InstanceMethod("readCsvSync", &NativeContext::ReadCsvSync),
        InstanceMethod("readCsv", &NativeContext::ReadCsv),
    });
    exports.Set("NativeContext", func);
    return exports;
}

NativeContext::NativeContext(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeContext>(info) {
    thread_ = std::make_unique<TeideThread>();
}

NativeContext::~NativeContext() {
    if (!destroyed_ && thread_) {
        thread_->shutdown();
    }
}

void NativeContext::check_alive(Napi::Env env) {
    if (destroyed_) {
        Napi::Error::New(env, "Context has been destroyed").ThrowAsJavaScriptException();
    }
}

Napi::Value NativeContext::Destroy(const Napi::CallbackInfo& info) {
    if (!destroyed_ && thread_) {
        thread_->shutdown();
        destroyed_ = true;
    }
    return info.Env().Undefined();
}

Napi::Value NativeContext::ReadCsvSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string path argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    void* result = thread_->dispatch_sync([path]() -> void* {
        return (void*)td_read_csv(path.c_str());
    });

    td_t* tbl = (td_t*)result;
    if (TD_IS_ERR(tbl)) {
        Napi::Error::New(env, std::string("Failed to read CSV: ") + td_err_str(TD_ERR_CODE(tbl)))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Return raw pointer as external for now; Task 7 wraps it in Table
    return Napi::External<td_t>::New(env, tbl);
}

Napi::Value NativeContext::ReadCsv(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string path argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "readCsv", 0, 1);

    thread_->dispatch_async(
        [path]() -> void* {
            return (void*)td_read_csv(path.c_str());
        },
        tsfn,
        [deferred](Napi::Env env, void* data) {
            td_t* tbl = (td_t*)data;
            if (TD_IS_ERR(tbl)) {
                deferred.Reject(
                    Napi::Error::New(env, std::string("Failed to read CSV: ") + td_err_str(TD_ERR_CODE(tbl))).Value()
                );
            } else {
                deferred.Resolve(Napi::External<td_t>::New(env, tbl));
            }
        }
    );

    return deferred.Promise();
}
```

**Step 3: Update src/addon.cpp**

```cpp
#include <napi.h>
#include "context.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    NativeContext::Init(env, exports);
    return exports;
}

NODE_API_MODULE(teidedb_addon, Init)
```

**Step 4: Build and test**

Run: `npx cmake-js compile`
Expected: Compiles successfully

Update `test/smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

describe('NativeContext', () => {
  it('creates and destroys without error', () => {
    const ctx = new addon.NativeContext();
    ctx.destroy();
  });

  it('throws after destroy', () => {
    const ctx = new addon.NativeContext();
    ctx.destroy();
    expect(() => ctx.readCsvSync('nonexistent.csv')).toThrow();
  });
});
```

Run: `npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/context.h src/context.cpp src/addon.cpp test/smoke.test.ts
git commit -m "feat(js): NativeContext with Teide thread, readCsv sync/async"
```

---

## Phase 3: Table & Series (Zero-Copy)

### Task 6: Implement native Series with zero-copy TypedArray

**Files:**
- Create: `src/series.h`
- Create: `src/series.cpp`

**Step 1: Create src/series.h**

```cpp
#pragma once
#include <napi.h>

extern "C" {
#include <teide/td.h>
}

class TeideThread;

class NativeSeries : public Napi::ObjectWrap<NativeSeries> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_t* vec, const std::string& name,
                               int8_t dtype, TeideThread* thread);
    NativeSeries(const Napi::CallbackInfo& info);

    td_t* ptr() const { return vec_; }

private:
    Napi::Value GetDtype(const Napi::CallbackInfo& info);
    Napi::Value GetLength(const Napi::CallbackInfo& info);
    Napi::Value GetName(const Napi::CallbackInfo& info);
    Napi::Value GetData(const Napi::CallbackInfo& info);
    Napi::Value GetNullBitmap(const Napi::CallbackInfo& info);
    Napi::Value GetIndices(const Napi::CallbackInfo& info);
    Napi::Value GetDictionary(const Napi::CallbackInfo& info);

    // Create a zero-copy TypedArray backed by td_retain/td_release
    Napi::TypedArray CreateZeroCopyArray(Napi::Env env, void* data, int64_t length,
                                          size_t elem_size, napi_typedarray_type arr_type);

    td_t* vec_;
    std::string name_;
    int8_t dtype_;
    TeideThread* thread_;  // for release callback dispatch
    Napi::Reference<Napi::TypedArray> cached_data_;

    static Napi::FunctionReference constructor_;
};
```

**Step 2: Create src/series.cpp**

```cpp
#include "series.h"
#include "teide_thread.h"

Napi::FunctionReference NativeSeries::constructor_;

Napi::Object NativeSeries::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeSeries", {
        InstanceAccessor("dtype", &NativeSeries::GetDtype, nullptr),
        InstanceAccessor("length", &NativeSeries::GetLength, nullptr),
        InstanceAccessor("name", &NativeSeries::GetName, nullptr),
        InstanceAccessor("data", &NativeSeries::GetData, nullptr),
        InstanceAccessor("nullBitmap", &NativeSeries::GetNullBitmap, nullptr),
        InstanceAccessor("indices", &NativeSeries::GetIndices, nullptr),
        InstanceAccessor("dictionary", &NativeSeries::GetDictionary, nullptr),
    });
    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();
    exports.Set("NativeSeries", func);
    return exports;
}

Napi::Object NativeSeries::Create(Napi::Env env, td_t* vec, const std::string& name,
                                    int8_t dtype, TeideThread* thread) {
    Napi::Object obj = constructor_.New({});
    NativeSeries* self = Napi::ObjectWrap<NativeSeries>::Unwrap(obj);
    self->vec_ = vec;
    self->name_ = name;
    self->dtype_ = dtype;
    self->thread_ = thread;
    return obj;
}

NativeSeries::NativeSeries(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeSeries>(info), vec_(nullptr), dtype_(0), thread_(nullptr) {}

static const char* dtype_name(int8_t t) {
    switch (t) {
        case TD_BOOL: return "bool";
        case TD_U8: return "u8";
        case TD_I16: return "i16";
        case TD_I32: return "i32";
        case TD_I64: return "i64";
        case TD_F64: return "f64";
        case TD_DATE: return "date";
        case TD_TIMESTAMP: return "timestamp";
        case TD_SYM: return "sym";
        default: return "unknown";
    }
}

Napi::Value NativeSeries::GetDtype(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), dtype_name(dtype_));
}

Napi::Value NativeSeries::GetLength(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), (double)td_len(vec_));
}

Napi::Value NativeSeries::GetName(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), name_);
}

Napi::TypedArray NativeSeries::CreateZeroCopyArray(
    Napi::Env env, void* data, int64_t length,
    size_t elem_size, napi_typedarray_type arr_type) {

    // Retain the vector so it stays alive while JS holds the ArrayBuffer
    td_retain(vec_);
    td_t* vec_ref = vec_;

    // Create external ArrayBuffer pointing at C data
    // Release callback fires when GC collects the ArrayBuffer
    auto ab = Napi::ArrayBuffer::New(
        env, data, (size_t)(length * elem_size),
        [vec_ref](Napi::Env, void*) {
            td_release(vec_ref);
        }
    );

    return Napi::TypedArray::New(env, arr_type, ab, 0, (size_t)length);
}

// Resolve data pointer, handling slices
static void* resolve_data_ptr(td_t* vec, int8_t dtype) {
    uint8_t attrs = vec->attrs;
    if (attrs & TD_ATTR_SLICE) {
        td_t* parent = vec->slice_parent;
        int64_t offset = vec->slice_offset;
        size_t esz = td_sym_elem_size(dtype, attrs);
        return (uint8_t*)td_data(parent) + offset * esz;
    }
    return td_data(vec);
}

Napi::Value NativeSeries::GetData(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!cached_data_.IsEmpty()) {
        return cached_data_.Value();
    }

    if (dtype_ == TD_SYM) {
        Napi::Error::New(env, "Use .indices and .dictionary for symbol columns").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* data = resolve_data_ptr(vec_, dtype_);
    int64_t len = td_len(vec_);

    napi_typedarray_type arr_type;
    size_t elem_size;

    switch (dtype_) {
        case TD_F64:
            arr_type = napi_float64_array; elem_size = 8; break;
        case TD_I64: case TD_TIMESTAMP:
            arr_type = napi_bigint64_array; elem_size = 8; break;
        case TD_I32: case TD_DATE:
            arr_type = napi_int32_array; elem_size = 4; break;
        case TD_I16:
            arr_type = napi_int16_array; elem_size = 2; break;
        case TD_BOOL: case TD_U8:
            arr_type = napi_uint8_array; elem_size = 1; break;
        default:
            Napi::Error::New(env, std::string("Unsupported dtype for .data: ") + dtype_name(dtype_))
                .ThrowAsJavaScriptException();
            return env.Undefined();
    }

    Napi::TypedArray result = CreateZeroCopyArray(env, data, len, elem_size, arr_type);
    cached_data_ = Napi::Persistent(result);
    return result;
}

Napi::Value NativeSeries::GetNullBitmap(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!(vec_->attrs & TD_ATTR_HAS_NULLS)) {
        return env.Null();
    }
    // External nullmap or inline (16 bytes)
    if (vec_->attrs & TD_ATTR_NULLMAP_EXT) {
        td_t* ext = vec_->ext_nullmap;
        if (!ext) return env.Null();
        td_retain(ext);
        int64_t nbytes = (td_len(vec_) + 7) / 8;
        auto ab = Napi::ArrayBuffer::New(env, td_data(ext), (size_t)nbytes,
            [ext](Napi::Env, void*) { td_release(ext); });
        return Napi::Uint8Array::New(env, (size_t)nbytes, ab, 0);
    }
    // Inline: 16 bytes at offset 0 of td_t
    size_t nbytes = std::min((int64_t)16, (td_len(vec_) + 7) / 8);
    td_retain(vec_);
    td_t* vec_ref = vec_;
    auto ab = Napi::ArrayBuffer::New(env, vec_->nullmap, nbytes,
        [vec_ref](Napi::Env, void*) { td_release(vec_ref); });
    return Napi::Uint8Array::New(env, nbytes, ab, 0);
}

Napi::Value NativeSeries::GetIndices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (dtype_ != TD_SYM) {
        Napi::Error::New(env, ".indices is only available for symbol columns").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* data = resolve_data_ptr(vec_, dtype_);
    int64_t len = td_len(vec_);
    uint8_t width = vec_->attrs & TD_SYM_W_MASK;

    napi_typedarray_type arr_type;
    size_t elem_size;

    switch (width) {
        case TD_SYM_W8:  arr_type = napi_uint8_array;  elem_size = 1; break;
        case TD_SYM_W16: arr_type = napi_uint16_array; elem_size = 2; break;
        case TD_SYM_W32: arr_type = napi_uint32_array; elem_size = 4; break;
        default:
            Napi::Error::New(env, "Unsupported SYM width").ThrowAsJavaScriptException();
            return env.Undefined();
    }

    return CreateZeroCopyArray(env, data, len, elem_size, arr_type);
}

Napi::Value NativeSeries::GetDictionary(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (dtype_ != TD_SYM) {
        Napi::Error::New(env, ".dictionary is only available for symbol columns").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Build string array from symbol table
    // We need to know the max index in this column
    uint32_t count = td_sym_count();
    Napi::Array arr = Napi::Array::New(env, count);

    for (uint32_t i = 0; i < count; i++) {
        td_t* s = td_sym_str((int64_t)i);
        if (s) {
            const char* str = td_str_ptr(s);
            size_t len = td_str_len(s);
            arr.Set(i, Napi::String::New(env, str, len));
        } else {
            arr.Set(i, Napi::String::New(env, ""));
        }
    }

    return arr;
}
```

Note: `td_sym_count()` and `td_sym_str()` are called from the main thread here. Since these read from the symbol table which is only written during CSV load / graph execution (both on the Teide thread), this is safe for read-only access after collect(). If this becomes a concern, dispatch to the Teide thread.

**Step 3: Register in addon.cpp**

Update `src/addon.cpp`:
```cpp
#include <napi.h>
#include "context.h"
#include "series.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    NativeContext::Init(env, exports);
    NativeSeries::Init(env, exports);
    return exports;
}

NODE_API_MODULE(teidedb_addon, Init)
```

**Step 4: Build**

Run: `npx cmake-js compile`
Expected: Compiles successfully

**Step 5: Commit**

```bash
git add src/series.h src/series.cpp src/addon.cpp
git commit -m "feat(js): NativeSeries with zero-copy TypedArray backed by td_retain/release"
```

---

### Task 7: Implement native Table wrapper

**Files:**
- Create: `src/table.h`
- Create: `src/table.cpp`
- Modify: `src/addon.cpp`

**Step 1: Create src/table.h**

```cpp
#pragma once
#include <napi.h>

extern "C" {
#include <teide/td.h>
}

class TeideThread;

class NativeTable : public Napi::ObjectWrap<NativeTable> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_t* tbl, TeideThread* thread);
    NativeTable(const Napi::CallbackInfo& info);

    td_t* ptr() const { return tbl_; }
    TeideThread* thread() const { return thread_; }

private:
    Napi::Value GetNRows(const Napi::CallbackInfo& info);
    Napi::Value GetNCols(const Napi::CallbackInfo& info);
    Napi::Value GetColumns(const Napi::CallbackInfo& info);
    Napi::Value Col(const Napi::CallbackInfo& info);

    td_t* tbl_;
    TeideThread* thread_;
    static Napi::FunctionReference constructor_;
};
```

**Step 2: Create src/table.cpp**

```cpp
#include "table.h"
#include "series.h"

Napi::FunctionReference NativeTable::constructor_;

Napi::Object NativeTable::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeTable", {
        InstanceAccessor("nRows", &NativeTable::GetNRows, nullptr),
        InstanceAccessor("nCols", &NativeTable::GetNCols, nullptr),
        InstanceAccessor("columns", &NativeTable::GetColumns, nullptr),
        InstanceMethod("col", &NativeTable::Col),
    });
    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();
    exports.Set("NativeTable", func);
    return exports;
}

Napi::Object NativeTable::Create(Napi::Env env, td_t* tbl, TeideThread* thread) {
    Napi::Object obj = constructor_.New({});
    NativeTable* self = Napi::ObjectWrap<NativeTable>::Unwrap(obj);
    self->tbl_ = tbl;
    self->thread_ = thread;
    return obj;
}

NativeTable::NativeTable(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeTable>(info), tbl_(nullptr), thread_(nullptr) {}

Napi::Value NativeTable::GetNRows(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), (double)td_table_nrows(tbl_));
}

Napi::Value NativeTable::GetNCols(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), (double)td_table_ncols(tbl_));
}

Napi::Value NativeTable::GetColumns(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int64_t ncols = td_table_ncols(tbl_);
    Napi::Array arr = Napi::Array::New(env, (size_t)ncols);

    for (int64_t i = 0; i < ncols; i++) {
        int64_t name_id = td_table_col_name(tbl_, i);
        td_t* sym = td_sym_str(name_id);
        if (sym) {
            const char* str = td_str_ptr(sym);
            size_t len = td_str_len(sym);
            arr.Set((uint32_t)i, Napi::String::New(env, str, len));
        } else {
            arr.Set((uint32_t)i, Napi::String::New(env, "V" + std::to_string(i)));
        }
    }
    return arr;
}

Napi::Value NativeTable::Col(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected column name string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();

    // Find column by name: intern the name, then look up
    int64_t name_id = td_sym_find(name.c_str(), name.size());
    if (name_id < 0) {
        Napi::Error::New(env, "Column not found: " + name).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    td_t* col = td_table_get_col(tbl_, name_id);
    if (!col) {
        Napi::Error::New(env, "Column not found: " + name).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int8_t dtype = td_type(col);
    return NativeSeries::Create(env, col, name, dtype, thread_);
}
```

**Step 3: Update context.cpp to return NativeTable instead of External**

In `src/context.cpp`, update ReadCsvSync and ReadCsv to return NativeTable:

Add `#include "table.h"` at top.

Replace the External returns with:
```cpp
// In ReadCsvSync, replace: return Napi::External<td_t>::New(env, tbl);
return NativeTable::Create(env, tbl, thread_.get());

// In ReadCsv's on_done callback, replace the deferred.Resolve:
deferred.Resolve(NativeTable::Create(env, (td_t*)data, /* need thread ptr */));
```

For async, the thread pointer needs to be captured. Store a raw `TeideThread*` in the lambda:
```cpp
TeideThread* thr = thread_.get();
// ... in the js_callback lambda:
deferred.Resolve(NativeTable::Create(env, (td_t*)data, thr));
```

**Step 4: Register in addon.cpp**

```cpp
#include <napi.h>
#include "context.h"
#include "series.h"
#include "table.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    NativeContext::Init(env, exports);
    NativeSeries::Init(env, exports);
    NativeTable::Init(env, exports);
    return exports;
}

NODE_API_MODULE(teidedb_addon, Init)
```

**Step 5: Write test with a real CSV**

Create `test/fixtures/small.csv`:
```csv
id,name,value
1,alpha,10.5
2,beta,20.3
3,gamma,30.1
```

Create `test/table.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'teidedb_addon.node'));

describe('Table & Series', () => {
  it('reads CSV and accesses columns (sync)', () => {
    const ctx = new addon.NativeContext();
    try {
      const tbl = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      expect(tbl.nRows).toBe(3);
      expect(tbl.nCols).toBe(3);
      expect(tbl.columns).toEqual(['id', 'name', 'value']);

      const values = tbl.col('value');
      expect(values.dtype).toBe('f64');
      expect(values.length).toBe(3);

      const data = values.data;
      expect(data).toBeInstanceOf(Float64Array);
      expect(data[0]).toBeCloseTo(10.5);
      expect(data[1]).toBeCloseTo(20.3);
      expect(data[2]).toBeCloseTo(30.1);
    } finally {
      ctx.destroy();
    }
  });

  it('reads CSV async', async () => {
    const ctx = new addon.NativeContext();
    try {
      const tbl = await ctx.readCsv(path.join(__dirname, 'fixtures', 'small.csv'));
      expect(tbl.nRows).toBe(3);
    } finally {
      ctx.destroy();
    }
  });

  it('accesses symbol columns', () => {
    const ctx = new addon.NativeContext();
    try {
      const tbl = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      const names = tbl.col('name');
      expect(names.dtype).toBe('sym');
      expect(names.indices).toBeInstanceOf(Uint8Array);
      expect(names.dictionary).toContain('alpha');
    } finally {
      ctx.destroy();
    }
  });
});
```

**Step 6: Build and test**

Run: `npx cmake-js compile && npx vitest run`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/table.h src/table.cpp src/context.cpp src/addon.cpp test/table.test.ts test/fixtures/small.csv
git commit -m "feat(js): NativeTable and Series with zero-copy column access"
```

---

## Phase 4: TypeScript API Layer

### Task 8: Create TypeScript Expr class with expression tree

**Files:**
- Create: `lib/expr.ts`

**Step 1: Create lib/expr.ts**

This is pure TypeScript — no native code. Builds an expression tree that gets serialized to C graph nodes during collect().

```typescript
export type ExprKind = 'col' | 'lit' | 'binop' | 'unop' | 'agg' | 'alias';

// Agg opcodes (must match C defines)
export const OP_SUM = 50;
export const OP_PROD = 51;
export const OP_MIN = 52;
export const OP_MAX = 53;
export const OP_COUNT = 54;
export const OP_AVG = 55;
export const OP_FIRST = 56;
export const OP_LAST = 57;

export class Expr {
    constructor(
        public readonly kind: ExprKind,
        public readonly params: Record<string, unknown> = {},
    ) {}

    // Binary ops
    add(other: Expr | number | string): Expr { return binop('add', this, wrap(other)); }
    sub(other: Expr | number | string): Expr { return binop('sub', this, wrap(other)); }
    mul(other: Expr | number | string): Expr { return binop('mul', this, wrap(other)); }
    div(other: Expr | number | string): Expr { return binop('div', this, wrap(other)); }
    mod(other: Expr | number | string): Expr { return binop('mod', this, wrap(other)); }

    // Comparison
    eq(other: Expr | number | string): Expr { return binop('eq', this, wrap(other)); }
    ne(other: Expr | number | string): Expr { return binop('ne', this, wrap(other)); }
    lt(other: Expr | number | string): Expr { return binop('lt', this, wrap(other)); }
    le(other: Expr | number | string): Expr { return binop('le', this, wrap(other)); }
    gt(other: Expr | number | string): Expr { return binop('gt', this, wrap(other)); }
    ge(other: Expr | number | string): Expr { return binop('ge', this, wrap(other)); }

    // Logical
    and(other: Expr): Expr { return binop('and', this, other); }
    or(other: Expr): Expr { return binop('or', this, other); }

    // Unary
    not(): Expr { return new Expr('unop', { op: 'not', arg: this }); }
    neg(): Expr { return new Expr('unop', { op: 'neg', arg: this }); }
    abs(): Expr { return new Expr('unop', { op: 'abs', arg: this }); }
    sqrt(): Expr { return new Expr('unop', { op: 'sqrt', arg: this }); }
    log(): Expr { return new Expr('unop', { op: 'log', arg: this }); }
    exp(): Expr { return new Expr('unop', { op: 'exp', arg: this }); }
    ceil(): Expr { return new Expr('unop', { op: 'ceil', arg: this }); }
    floor(): Expr { return new Expr('unop', { op: 'floor', arg: this }); }
    isNull(): Expr { return new Expr('unop', { op: 'isnull', arg: this }); }

    // Aggregations
    sum(): Expr { return new Expr('agg', { op: OP_SUM, arg: this }); }
    mean(): Expr { return new Expr('agg', { op: OP_AVG, arg: this }); }
    min(): Expr { return new Expr('agg', { op: OP_MIN, arg: this }); }
    max(): Expr { return new Expr('agg', { op: OP_MAX, arg: this }); }
    count(): Expr { return new Expr('agg', { op: OP_COUNT, arg: this }); }
    first(): Expr { return new Expr('agg', { op: OP_FIRST, arg: this }); }
    last(): Expr { return new Expr('agg', { op: OP_LAST, arg: this }); }

    // Rename
    alias(name: string): Expr { return new Expr('alias', { name, arg: this }); }
}

export function col(name: string): Expr {
    return new Expr('col', { name });
}

export function lit(value: number | string | boolean): Expr {
    return new Expr('lit', { value });
}

function wrap(x: Expr | number | string | boolean): Expr {
    return x instanceof Expr ? x : lit(x);
}

function binop(op: string, left: Expr, right: Expr): Expr {
    return new Expr('binop', { op, left, right });
}
```

**Step 2: Write test**

Create `test/expr.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { col, lit, Expr } from '../lib/expr';

describe('Expr tree', () => {
  it('builds column reference', () => {
    const e = col('price');
    expect(e.kind).toBe('col');
    expect(e.params.name).toBe('price');
  });

  it('builds binary expression', () => {
    const e = col('price').gt(0);
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('gt');
  });

  it('builds aggregation', () => {
    const e = col('price').sum();
    expect(e.kind).toBe('agg');
    expect(e.params.op).toBe(50); // OP_SUM
  });

  it('builds chained expression', () => {
    const e = col('a').add(col('b')).mul(lit(2));
    expect(e.kind).toBe('binop');
    expect(e.params.op).toBe('mul');
  });
});
```

**Step 3: Run test**

Run: `npx vitest run test/expr.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add lib/expr.ts test/expr.test.ts
git commit -m "feat(js): TypeScript Expr class with full expression tree builder"
```

---

### Task 9: Implement native graph emission and query execution

**Files:**
- Create: `src/query.h`
- Create: `src/query.cpp`
- Modify: `src/addon.cpp`

This is the critical C++ code that takes a serialized expression tree (as JS objects) and emits C graph nodes, then optimizes and executes.

**Step 1: Create src/query.h**

```cpp
#pragma once
#include <napi.h>

extern "C" {
#include <teide/td.h>
}

class TeideThread;

class NativeQuery : public Napi::ObjectWrap<NativeQuery> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    NativeQuery(const Napi::CallbackInfo& info);

private:
    // Execute a query plan: takes table ptr + ops array, returns Table
    Napi::Value CollectSync(const Napi::CallbackInfo& info);
    Napi::Value Collect(const Napi::CallbackInfo& info);

    // Internal: emit an expr tree into graph nodes
    static td_op_t* EmitExpr(td_graph_t* g, Napi::Object expr);

    // Internal: execute ops list against a table
    static td_t* ExecutePlan(td_t* tbl, Napi::Array ops);
};
```

**Step 2: Create src/query.cpp**

```cpp
#include "query.h"
#include "table.h"
#include "teide_thread.h"
#include <vector>
#include <string>

Napi::Object NativeQuery::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeQuery", {
        InstanceMethod("collectSync", &NativeQuery::CollectSync),
        InstanceMethod("collect", &NativeQuery::Collect),
    });
    exports.Set("NativeQuery", func);
    return exports;
}

NativeQuery::NativeQuery(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeQuery>(info) {}

// Recursively emit graph nodes from a JS Expr object
td_op_t* EmitExprFromObject(td_graph_t* g, Napi::Object expr) {
    std::string kind = expr.Get("kind").As<Napi::String>().Utf8Value();
    Napi::Object params = expr.Get("params").As<Napi::Object>();

    if (kind == "col") {
        std::string name = params.Get("name").As<Napi::String>().Utf8Value();
        return td_scan(g, name.c_str());
    }
    else if (kind == "lit") {
        Napi::Value val = params.Get("value");
        if (val.IsNumber()) {
            double d = val.As<Napi::Number>().DoubleValue();
            // Check if integer
            if (d == (double)(int64_t)d && d >= -9007199254740992.0 && d <= 9007199254740992.0) {
                return td_const_i64(g, (int64_t)d);
            }
            return td_const_f64(g, d);
        }
        if (val.IsBoolean()) {
            return td_const_bool(g, val.As<Napi::Boolean>().Value());
        }
        if (val.IsString()) {
            std::string s = val.As<Napi::String>().Utf8Value();
            return td_const_str(g, s.c_str());
        }
        return nullptr;
    }
    else if (kind == "binop") {
        std::string op = params.Get("op").As<Napi::String>().Utf8Value();
        td_op_t* left = EmitExprFromObject(g, params.Get("left").As<Napi::Object>());
        td_op_t* right = EmitExprFromObject(g, params.Get("right").As<Napi::Object>());

        if (op == "add") return td_add(g, left, right);
        if (op == "sub") return td_sub(g, left, right);
        if (op == "mul") return td_mul(g, left, right);
        if (op == "div") return td_div(g, left, right);
        if (op == "mod") return td_mod(g, left, right);
        if (op == "eq")  return td_eq(g, left, right);
        if (op == "ne")  return td_ne(g, left, right);
        if (op == "lt")  return td_lt(g, left, right);
        if (op == "le")  return td_le(g, left, right);
        if (op == "gt")  return td_gt(g, left, right);
        if (op == "ge")  return td_ge(g, left, right);
        if (op == "and") return td_and(g, left, right);
        if (op == "or")  return td_or(g, left, right);
        return nullptr;
    }
    else if (kind == "unop") {
        std::string op = params.Get("op").As<Napi::String>().Utf8Value();
        td_op_t* arg = EmitExprFromObject(g, params.Get("arg").As<Napi::Object>());

        if (op == "neg")    return td_neg(g, arg);
        if (op == "abs")    return td_abs(g, arg);
        if (op == "not")    return td_not(g, arg);
        if (op == "sqrt")   return td_sqrt_op(g, arg);
        if (op == "log")    return td_log_op(g, arg);
        if (op == "exp")    return td_exp_op(g, arg);
        if (op == "ceil")   return td_ceil_op(g, arg);
        if (op == "floor")  return td_floor_op(g, arg);
        if (op == "isnull") return td_isnull(g, arg);
        return nullptr;
    }
    else if (kind == "agg") {
        int opcode = params.Get("op").As<Napi::Number>().Int32Value();
        td_op_t* arg = EmitExprFromObject(g, params.Get("arg").As<Napi::Object>());

        switch (opcode) {
            case OP_SUM:   return td_sum(g, arg);
            case OP_PROD:  return td_prod(g, arg);
            case OP_MIN:   return td_min_op(g, arg);
            case OP_MAX:   return td_max_op(g, arg);
            case OP_COUNT: return td_count(g, arg);
            case OP_AVG:   return td_avg(g, arg);
            case OP_FIRST: return td_first(g, arg);
            case OP_LAST:  return td_last(g, arg);
        }
        return nullptr;
    }
    else if (kind == "alias") {
        return EmitExprFromObject(g, params.Get("arg").As<Napi::Object>());
    }

    return nullptr;
}

// Serialized op format from TypeScript:
// { type: 'filter', expr: Expr }
// { type: 'group', keys: string[], aggs: Expr[] }
// { type: 'sort', cols: string[], descs: boolean[] }
// { type: 'head', n: number }

// Execute a plan on the Teide thread
struct PlanData {
    td_t* tbl;
    // Serialized plan steps (extracted from JS before dispatch)
    struct FilterOp { /* expr tree serialized */ };
    struct GroupOp {
        std::vector<std::string> keys;
        std::vector<int> agg_opcodes;
        // For each agg, we need the inner expr's column name
        // Simplified: for now, aggs must be col("x").sum() pattern
    };
    // ... simplified for initial impl
};

Napi::Value NativeQuery::CollectSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Args: nativeTable, opsArray (JS objects describing the query plan)
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (nativeTable, ops)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    Napi::Array ops = info[1].As<Napi::Array>();

    td_t* tbl_ptr = table->ptr();
    TeideThread* thread = table->thread();

    // Build the entire graph on the Teide thread since all td_* calls must happen there.
    // We serialize the JS ops into a simple format, then reconstruct on the Teide thread.

    // For the initial implementation, we serialize the ops to a string-based plan
    // that the Teide thread can interpret without JS objects.
    // This avoids the problem of JS objects not being accessible from another thread.

    // Serialize ops into a vector of plan steps
    struct PlanStep {
        std::string type;
        // filter
        std::string filter_json; // serialized expr tree
        // group
        std::vector<std::string> group_keys;
        std::vector<uint16_t> agg_opcodes;
        std::vector<std::string> agg_col_names;
        // sort
        std::vector<std::string> sort_cols;
        std::vector<bool> sort_descs;
        // head
        int64_t head_n;
    };

    std::vector<PlanStep> plan;

    // Helper to extract column name from a simple expr (col("x") or col("x").agg())
    auto extract_col_name = [](Napi::Object expr) -> std::string {
        std::string kind = expr.Get("kind").As<Napi::String>().Utf8Value();
        Napi::Object params = expr.Get("params").As<Napi::Object>();
        if (kind == "col") {
            return params.Get("name").As<Napi::String>().Utf8Value();
        }
        if (kind == "agg" || kind == "alias") {
            Napi::Object inner = params.Get("arg").As<Napi::Object>();
            return extract_col_name(inner);
        }
        if (kind == "binop" || kind == "unop") {
            // For complex expressions, we'd need full serialization
            // For now, return empty (unsupported)
            return "";
        }
        return "";
    };

    auto extract_agg_opcode = [](Napi::Object expr) -> uint16_t {
        std::string kind = expr.Get("kind").As<Napi::String>().Utf8Value();
        if (kind == "agg") {
            return (uint16_t)expr.Get("params").As<Napi::Object>()
                .Get("op").As<Napi::Number>().Int32Value();
        }
        return 0;
    };

    for (uint32_t i = 0; i < ops.Length(); i++) {
        Napi::Object op = ops.Get(i).As<Napi::Object>();
        std::string type = op.Get("type").As<Napi::String>().Utf8Value();
        PlanStep step;
        step.type = type;

        if (type == "filter") {
            // For filter, we need full expr tree serialization.
            // For now, store the expr object reference — we'll emit it on the main thread
            // before dispatching. This works because graph building is fast.
            // Actually, we need to build on the Teide thread. Let's serialize.

            // Simple filter serialization: col("x").gt(N) pattern
            // For the full version, we'd serialize the entire tree to JSON-like struct.
            // Let's do it properly: serialize recursively.
            step.filter_json = ""; // placeholder — see full serialization below
        }
        else if (type == "group") {
            Napi::Array keys = op.Get("keys").As<Napi::Array>();
            for (uint32_t k = 0; k < keys.Length(); k++) {
                step.group_keys.push_back(keys.Get(k).As<Napi::String>().Utf8Value());
            }
            Napi::Array aggs = op.Get("aggs").As<Napi::Array>();
            for (uint32_t a = 0; a < aggs.Length(); a++) {
                Napi::Object agg_expr = aggs.Get(a).As<Napi::Object>();
                step.agg_opcodes.push_back(extract_agg_opcode(agg_expr));
                step.agg_col_names.push_back(extract_col_name(agg_expr));
            }
        }
        else if (type == "sort") {
            Napi::Array cols = op.Get("cols").As<Napi::Array>();
            Napi::Array descs = op.Get("descs").As<Napi::Array>();
            for (uint32_t c = 0; c < cols.Length(); c++) {
                step.sort_cols.push_back(cols.Get(c).As<Napi::String>().Utf8Value());
                step.sort_descs.push_back(descs.Get(c).As<Napi::Boolean>().Value());
            }
        }
        else if (type == "head") {
            step.head_n = op.Get("n").As<Napi::Number>().Int64Value();
        }

        plan.push_back(std::move(step));
    }

    // For filter expressions, we need a recursive serialization.
    // Re-parse the ops to serialize filter exprs into a C++-friendly tree.

    // Serialized expression tree node (C++ struct, thread-safe)
    struct ExprNode {
        std::string kind;
        std::string op;
        std::string col_name;
        double num_val = 0;
        bool bool_val = false;
        std::string str_val;
        int agg_opcode = 0;
        std::shared_ptr<ExprNode> left, right, arg;
    };

    std::function<std::shared_ptr<ExprNode>(Napi::Object)> serialize_expr;
    serialize_expr = [&](Napi::Object expr) -> std::shared_ptr<ExprNode> {
        auto node = std::make_shared<ExprNode>();
        node->kind = expr.Get("kind").As<Napi::String>().Utf8Value();
        Napi::Object params = expr.Get("params").As<Napi::Object>();

        if (node->kind == "col") {
            node->col_name = params.Get("name").As<Napi::String>().Utf8Value();
        }
        else if (node->kind == "lit") {
            Napi::Value val = params.Get("value");
            if (val.IsNumber()) node->num_val = val.As<Napi::Number>().DoubleValue();
            else if (val.IsBoolean()) node->bool_val = val.As<Napi::Boolean>().Value();
            else if (val.IsString()) node->str_val = val.As<Napi::String>().Utf8Value();
        }
        else if (node->kind == "binop") {
            node->op = params.Get("op").As<Napi::String>().Utf8Value();
            node->left = serialize_expr(params.Get("left").As<Napi::Object>());
            node->right = serialize_expr(params.Get("right").As<Napi::Object>());
        }
        else if (node->kind == "unop") {
            node->op = params.Get("op").As<Napi::String>().Utf8Value();
            node->arg = serialize_expr(params.Get("arg").As<Napi::Object>());
        }
        else if (node->kind == "agg") {
            node->agg_opcode = params.Get("op").As<Napi::Number>().Int32Value();
            node->arg = serialize_expr(params.Get("arg").As<Napi::Object>());
        }
        else if (node->kind == "alias") {
            node->col_name = params.Get("name").As<Napi::String>().Utf8Value();
            node->arg = serialize_expr(params.Get("arg").As<Napi::Object>());
        }

        return node;
    };

    // Rebuild plan with serialized filter exprs
    struct FullPlanStep {
        std::string type;
        std::shared_ptr<ExprNode> filter_expr;
        std::vector<std::string> group_keys;
        std::vector<uint16_t> agg_opcodes;
        std::vector<std::shared_ptr<ExprNode>> agg_exprs;
        std::vector<std::string> sort_cols;
        std::vector<bool> sort_descs;
        int64_t head_n = 0;
    };

    std::vector<FullPlanStep> full_plan;
    for (uint32_t i = 0; i < ops.Length(); i++) {
        Napi::Object op = ops.Get(i).As<Napi::Object>();
        std::string type = op.Get("type").As<Napi::String>().Utf8Value();
        FullPlanStep step;
        step.type = type;

        if (type == "filter") {
            step.filter_expr = serialize_expr(op.Get("expr").As<Napi::Object>());
        }
        else if (type == "group") {
            Napi::Array keys = op.Get("keys").As<Napi::Array>();
            for (uint32_t k = 0; k < keys.Length(); k++)
                step.group_keys.push_back(keys.Get(k).As<Napi::String>().Utf8Value());
            Napi::Array aggs = op.Get("aggs").As<Napi::Array>();
            for (uint32_t a = 0; a < aggs.Length(); a++)
                step.agg_exprs.push_back(serialize_expr(aggs.Get(a).As<Napi::Object>()));
        }
        else if (type == "sort") {
            Napi::Array cols = op.Get("cols").As<Napi::Array>();
            Napi::Array descs = op.Get("descs").As<Napi::Array>();
            for (uint32_t c = 0; c < cols.Length(); c++) {
                step.sort_cols.push_back(cols.Get(c).As<Napi::String>().Utf8Value());
                step.sort_descs.push_back(descs.Get(c).As<Napi::Boolean>().Value());
            }
        }
        else if (type == "head") {
            step.head_n = op.Get("n").As<Napi::Number>().Int64Value();
        }

        full_plan.push_back(std::move(step));
    }

    // Emit C graph nodes from serialized ExprNode (runs on Teide thread)
    std::function<td_op_t*(td_graph_t*, const std::shared_ptr<ExprNode>&)> emit_node;
    emit_node = [&](td_graph_t* g, const std::shared_ptr<ExprNode>& n) -> td_op_t* {
        if (n->kind == "col") return td_scan(g, n->col_name.c_str());
        if (n->kind == "lit") {
            double d = n->num_val;
            if (!n->str_val.empty()) return td_const_str(g, n->str_val.c_str());
            if (n->bool_val || d == 0) {
                // Distinguish bool from number: check if str_val empty and num_val is 0
                // Simple heuristic: if it's exactly 0 or 1 and was bool, use bool
                // TODO: improve type detection in serialization
            }
            if (d == (double)(int64_t)d) return td_const_i64(g, (int64_t)d);
            return td_const_f64(g, d);
        }
        if (n->kind == "binop") {
            td_op_t* l = emit_node(g, n->left);
            td_op_t* r = emit_node(g, n->right);
            if (n->op == "add") return td_add(g, l, r);
            if (n->op == "sub") return td_sub(g, l, r);
            if (n->op == "mul") return td_mul(g, l, r);
            if (n->op == "div") return td_div(g, l, r);
            if (n->op == "mod") return td_mod(g, l, r);
            if (n->op == "eq")  return td_eq(g, l, r);
            if (n->op == "ne")  return td_ne(g, l, r);
            if (n->op == "lt")  return td_lt(g, l, r);
            if (n->op == "le")  return td_le(g, l, r);
            if (n->op == "gt")  return td_gt(g, l, r);
            if (n->op == "ge")  return td_ge(g, l, r);
            if (n->op == "and") return td_and(g, l, r);
            if (n->op == "or")  return td_or(g, l, r);
        }
        if (n->kind == "unop") {
            td_op_t* a = emit_node(g, n->arg);
            if (n->op == "neg")    return td_neg(g, a);
            if (n->op == "abs")    return td_abs(g, a);
            if (n->op == "not")    return td_not(g, a);
            if (n->op == "sqrt")   return td_sqrt_op(g, a);
            if (n->op == "log")    return td_log_op(g, a);
            if (n->op == "exp")    return td_exp_op(g, a);
            if (n->op == "ceil")   return td_ceil_op(g, a);
            if (n->op == "floor")  return td_floor_op(g, a);
            if (n->op == "isnull") return td_isnull(g, a);
        }
        if (n->kind == "agg") {
            td_op_t* a = emit_node(g, n->arg);
            switch (n->agg_opcode) {
                case OP_SUM:   return td_sum(g, a);
                case OP_PROD:  return td_prod(g, a);
                case OP_MIN:   return td_min_op(g, a);
                case OP_MAX:   return td_max_op(g, a);
                case OP_COUNT: return td_count(g, a);
                case OP_AVG:   return td_avg(g, a);
                case OP_FIRST: return td_first(g, a);
                case OP_LAST:  return td_last(g, a);
            }
        }
        if (n->kind == "alias") return emit_node(g, n->arg);
        return nullptr;
    };

    // Dispatch to Teide thread
    void* result = thread->dispatch_sync([&]() -> void* {
        td_graph_t* g = td_graph_new(tbl_ptr);
        td_op_t* current = nullptr;
        td_op_t* filter_pred = nullptr;

        for (auto& step : full_plan) {
            if (step.type == "filter") {
                td_op_t* pred = emit_node(g, step.filter_expr);
                if (!current) {
                    filter_pred = filter_pred ? td_and(g, filter_pred, pred) : pred;
                } else {
                    current = td_filter(g, current, pred);
                }
            }
            else if (step.type == "group") {
                uint8_t n_keys = (uint8_t)step.group_keys.size();
                std::vector<td_op_t*> key_nodes;
                for (auto& k : step.group_keys)
                    key_nodes.push_back(td_scan(g, k.c_str()));

                std::vector<uint16_t> agg_ops;
                std::vector<td_op_t*> agg_ins;
                for (auto& agg_expr : step.agg_exprs) {
                    if (agg_expr->kind == "agg") {
                        agg_ops.push_back((uint16_t)agg_expr->agg_opcode);
                        agg_ins.push_back(emit_node(g, agg_expr->arg));
                    }
                }

                // Apply pending filter as filter_mask
                if (filter_pred) {
                    td_t* mask = td_execute(g, filter_pred);
                    if (mask && !TD_IS_ERR(mask)) {
                        td_retain(mask);
                        // Direct field access to set filter_mask
                        g->selection = mask;
                    }
                    filter_pred = nullptr;
                }

                current = td_group(g, key_nodes.data(), n_keys,
                                    agg_ops.data(), agg_ins.data(), (uint8_t)agg_ops.size());
            }
            else if (step.type == "sort") {
                uint8_t n_cols = (uint8_t)step.sort_cols.size();
                td_op_t* table_node = current ? current : td_const_table(g, tbl_ptr);

                if (filter_pred) {
                    table_node = td_filter(g, table_node, filter_pred);
                    filter_pred = nullptr;
                }

                std::vector<td_op_t*> key_nodes;
                std::vector<uint8_t> descs;
                for (size_t c = 0; c < step.sort_cols.size(); c++) {
                    key_nodes.push_back(td_scan(g, step.sort_cols[c].c_str()));
                    descs.push_back(step.sort_descs[c] ? 1 : 0);
                }

                current = td_sort_op(g, table_node, key_nodes.data(), descs.data(), nullptr, n_cols);
            }
            else if (step.type == "head") {
                if (!current) current = td_const_table(g, tbl_ptr);
                if (filter_pred) {
                    current = td_filter(g, current, filter_pred);
                    filter_pred = nullptr;
                }
                current = td_head(g, current, step.head_n);
            }
        }

        if (!current) current = td_const_table(g, tbl_ptr);
        if (filter_pred) current = td_filter(g, current, filter_pred);

        td_op_t* root = td_optimize(g, current);
        td_t* result = td_execute(g, root);
        td_graph_free(g);
        return (void*)result;
    });

    td_t* result_tbl = (td_t*)result;
    if (TD_IS_ERR(result_tbl)) {
        Napi::Error::New(env, std::string("Query execution failed: ") + td_err_str(TD_ERR_CODE(result_tbl)))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return NativeTable::Create(env, result_tbl, thread);
}

Napi::Value NativeQuery::Collect(const Napi::CallbackInfo& info) {
    // Async version: same serialization, dispatch via dispatch_async
    // For now, delegate to collectSync wrapped in a resolved promise
    // TODO: implement proper async dispatch
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    try {
        Napi::Value result = CollectSync(info);
        deferred.Resolve(result);
    } catch (const Napi::Error& e) {
        deferred.Reject(e.Value());
    }

    return deferred.Promise();
}
```

**Step 3: Register in addon.cpp**

Add `#include "query.h"` and `NativeQuery::Init(env, exports);`

**Step 4: Build**

Run: `npx cmake-js compile`
Expected: Compiles successfully

**Step 5: Commit**

```bash
git add src/query.h src/query.cpp src/addon.cpp
git commit -m "feat(js): NativeQuery with graph emission and sync/async execution"
```

---

### Task 10: Create TypeScript Query, Table, Series, Context wrappers

**Files:**
- Create: `lib/series.ts`
- Create: `lib/table.ts`
- Create: `lib/query.ts`
- Create: `lib/context.ts`
- Create: `lib/index.ts`

**Step 1: Create lib/series.ts**

```typescript
const addon = require('../build/Release/teidedb_addon.node');

export class Series {
    constructor(private readonly _native: any) {}

    get dtype(): string { return this._native.dtype; }
    get length(): number { return this._native.length; }
    get name(): string { return this._native.name; }
    get data(): Float64Array | BigInt64Array | Int32Array | Int16Array | Uint8Array {
        return this._native.data;
    }
    get nullBitmap(): Uint8Array | null { return this._native.nullBitmap; }
    get indices(): Uint8Array | Uint16Array | Uint32Array { return this._native.indices; }
    get dictionary(): string[] { return this._native.dictionary; }
}
```

**Step 2: Create lib/table.ts**

```typescript
import { Series } from './series';
import { Query } from './query';
import { Expr } from './expr';

export class Table {
    constructor(
        public readonly _native: any,
        private readonly _ctx: any,
    ) {}

    get nRows(): number { return this._native.nRows; }
    get nCols(): number { return this._native.nCols; }
    get columns(): string[] { return this._native.columns; }

    col(name: string): Series {
        return new Series(this._native.col(name));
    }

    filter(expr: Expr): Query {
        return new Query(this._native, this._ctx).filter(expr);
    }

    groupBy(...cols: string[]): GroupBy {
        return new Query(this._native, this._ctx).groupBy(...cols);
    }

    sort(col: string, opts?: { descending?: boolean }): Query;
    sort(...cols: string[]): Query;
    sort(...args: any[]): Query {
        return new Query(this._native, this._ctx).sort(...args);
    }

    head(n: number): Query {
        return new Query(this._native, this._ctx).head(n);
    }
}

export class GroupBy {
    constructor(
        private readonly _query: Query,
        private readonly _keys: string[],
    ) {}

    agg(...exprs: Expr[]): Query {
        return this._query._addGroupOp(this._keys, exprs);
    }
}
```

**Step 3: Create lib/query.ts**

```typescript
import { Expr } from './expr';
import { Table, GroupBy } from './table';

const addon = require('../build/Release/teidedb_addon.node');

interface Op {
    type: string;
    [key: string]: any;
}

export class Query {
    private _ops: Op[] = [];

    constructor(
        private readonly _nativeTable: any,
        private readonly _ctx: any,
    ) {}

    filter(expr: Expr): Query {
        this._ops.push({ type: 'filter', expr });
        return this;
    }

    groupBy(...cols: string[]): GroupBy {
        return new GroupBy(this, cols);
    }

    /** @internal */
    _addGroupOp(keys: string[], aggs: Expr[]): Query {
        this._ops.push({ type: 'group', keys, aggs });
        return this;
    }

    sort(col: string, opts?: { descending?: boolean }): Query;
    sort(...cols: string[]): Query;
    sort(...args: any[]): Query {
        if (typeof args[0] === 'string' && typeof args[1] === 'object' && !Array.isArray(args[1])) {
            const col = args[0] as string;
            const opts = args[1] as { descending?: boolean };
            this._ops.push({
                type: 'sort',
                cols: [col],
                descs: [opts?.descending ?? false],
            });
        } else {
            const cols = args.filter(a => typeof a === 'string') as string[];
            this._ops.push({
                type: 'sort',
                cols,
                descs: cols.map(() => false),
            });
        }
        return this;
    }

    head(n: number): Query {
        this._ops.push({ type: 'head', n });
        return this;
    }

    collectSync(): Table {
        const q = new addon.NativeQuery();
        const result = q.collectSync(this._nativeTable, this._ops);
        return new Table(result, this._ctx);
    }

    async collect(): Promise<Table> {
        const q = new addon.NativeQuery();
        const result = await q.collect(this._nativeTable, this._ops);
        return new Table(result, this._ctx);
    }
}
```

**Step 4: Create lib/context.ts**

```typescript
import { Table } from './table';

const addon = require('../build/Release/teidedb_addon.node');

export class Context {
    private _native: any;
    private _destroyed = false;

    constructor() {
        this._native = new addon.NativeContext();
    }

    readCsvSync(path: string): Table {
        this._checkAlive();
        return new Table(this._native.readCsvSync(path), this._native);
    }

    async readCsv(path: string): Promise<Table> {
        this._checkAlive();
        const nativeTable = await this._native.readCsv(path);
        return new Table(nativeTable, this._native);
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
        if (this._destroyed) throw new Error('Context has been destroyed');
    }
}
```

**Step 5: Create lib/index.ts**

```typescript
export { Context } from './context';
export { Expr, col, lit } from './expr';
export { Table } from './table';
export { Series } from './series';
export { Query } from './query';
```

**Step 6: Build TypeScript**

Run: `npx tsc`
Expected: Compiles without errors

**Step 7: Commit**

```bash
git add lib/
git commit -m "feat(js): TypeScript API wrappers — Context, Table, Series, Query, Expr"
```

---

## Phase 5: End-to-End Test

### Task 11: Write integration test for full query pipeline

**Files:**
- Create: `test/e2e.test.ts`

**Step 1: Create test/e2e.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import { Context, col, lit } from '../lib';

describe('End-to-end query', () => {
  it('filter + group + sort + collect', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));

      expect(df.nRows).toBe(3);
      expect(df.columns).toEqual(['id', 'name', 'value']);

      // Simple filter
      const filtered = df.filter(col('value').gt(15)).collectSync();
      expect(filtered.nRows).toBe(2);

      // Access zero-copy data
      const values = filtered.col('value');
      expect(values.data).toBeInstanceOf(Float64Array);
      expect(values.data[0]).toBeCloseTo(20.3);
    } finally {
      ctx.destroy();
    }
  });

  it('async collect', async () => {
    const ctx = new Context();
    try {
      const df = await ctx.readCsv(path.join(__dirname, 'fixtures', 'small.csv'));
      const result = await df.filter(col('value').gt(15)).collect();
      expect(result.nRows).toBe(2);
    } finally {
      ctx.destroy();
    }
  });

  it('symbol column access', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      const names = df.col('name');
      expect(names.dtype).toBe('sym');
      expect(names.indices).toBeDefined();
      expect(names.dictionary.length).toBeGreaterThan(0);
      expect(names.dictionary).toContain('alpha');
    } finally {
      ctx.destroy();
    }
  });

  it('head', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'small.csv'));
      const result = df.head(2).collectSync();
      expect(result.nRows).toBe(2);
    } finally {
      ctx.destroy();
    }
  });
});
```

**Step 2: Create a larger test fixture**

Create `test/fixtures/sales.csv`:
```csv
category,product,price,quantity
electronics,laptop,999.99,10
electronics,phone,699.99,25
electronics,tablet,449.99,15
clothing,shirt,29.99,100
clothing,pants,49.99,80
clothing,jacket,89.99,40
food,bread,3.99,200
food,milk,4.99,150
food,cheese,7.99,120
```

Add test:
```typescript
it('group by with aggregation', () => {
    const ctx = new Context();
    try {
      const df = ctx.readCsvSync(path.join(__dirname, 'fixtures', 'sales.csv'));
      const result = df
        .groupBy('category')
        .agg(col('price').sum(), col('quantity').mean())
        .sort('price_sum', { descending: true })
        .collectSync();

      expect(result.nRows).toBe(3);
      expect(result.columns).toContain('category');
    } finally {
      ctx.destroy();
    }
});
```

**Step 3: Run tests**

Run: `npx cmake-js compile && npx tsc && npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add test/e2e.test.ts test/fixtures/sales.csv
git commit -m "test(js): end-to-end integration tests for full query pipeline"
```

---

## Summary

| Phase | Tasks | What it builds |
|-------|-------|----------------|
| 1 | 1-3 | package.json, CMake, minimal addon that compiles and loads |
| 2 | 4-5 | Teide thread with work queue, NativeContext with readCsv |
| 3 | 6-7 | NativeSeries (zero-copy TypedArray) + NativeTable |
| 4 | 8-10 | TypeScript Expr/Query/Table/Series/Context wrappers |
| 5 | 11 | End-to-end integration tests |

Each task is designed to be independently buildable and testable. The native addon compiles and produces working output after every task starting from Task 3.
