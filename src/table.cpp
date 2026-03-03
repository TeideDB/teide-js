// table.h MUST come first -- it pulls in teide_thread.h which brings
// <napi.h>, <atomic>, and other C++ headers before the C-atomic shim.
#include "table.h"
#include "context.h"
#include "series.h"
#include "vector.h"
#include <cstring>
#include "compat.h"

Napi::FunctionReference NativeTable::constructor_;

Napi::Object NativeTable::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeTable", {
        InstanceAccessor("nRows", &NativeTable::GetNRows, nullptr),
        InstanceAccessor("nCols", &NativeTable::GetNCols, nullptr),
        InstanceAccessor("columns", &NativeTable::GetColumns, nullptr),
        InstanceMethod("col", &NativeTable::Col),
        InstanceMethod("addCol", &NativeTable::AddCol),
        InstanceMethod("getColByIndex", &NativeTable::GetColByIndex),
        InstanceMethod("setColName", &NativeTable::SetColName),
        InstanceMethod("schema", &NativeTable::Schema),
    });
    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();
    exports.Set("NativeTable", func);
    return exports;
}

Napi::Object NativeTable::Create(Napi::Env env, td_t* tbl, TeideThread* thread) {
    Napi::Object obj = constructor_.New({
        Napi::External<td_t>::New(env, tbl),
        Napi::External<TeideThread>::New(env, thread),
    });
    return obj;
}

NativeTable::NativeTable(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeTable>(info), tbl_(nullptr), thread_(nullptr) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "NativeTable: internal constructor requires 2 arguments")
            .ThrowAsJavaScriptException();
        return;
    }
    tbl_ = info[0].As<Napi::External<td_t>>().Data();
    thread_ = info[1].As<Napi::External<TeideThread>>().Data();
    heap_alive_ = thread_->heap_alive();

    if (tbl_) td_retain(tbl_);
}

NativeTable::~NativeTable() {
    if (tbl_ && heap_alive_ && heap_alive_->load()) td_release(tbl_);
}

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
            arr.Set((uint32_t)i, Napi::String::New(env, td_str_ptr(sym), td_str_len(sym)));
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

    // Find column by name: look up the symbol ID (don't intern -- just find)
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

Napi::Value NativeTable::AddCol(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "addCol(name, vector)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    NativeVector* vec = Napi::ObjectWrap<NativeVector>::Unwrap(info[1].As<Napi::Object>());
    td_t* vec_ptr = vec->ptr();
    td_t* tbl = tbl_;

    void* result = thread_->dispatch_sync([tbl, name, vec_ptr]() -> void* {
        int64_t name_id = td_sym_intern(name.c_str(), name.size());
        td_retain(vec_ptr);
        return (void*)td_table_add_col(tbl, name_id, vec_ptr);
    });

    td_t* new_tbl = (td_t*)result;
    if (new_tbl && new_tbl != tbl_) {
        td_retain(new_tbl);
        if (heap_alive_ && heap_alive_->load()) td_release(tbl_);
    }
    tbl_ = new_tbl;
    return env.Undefined();
}

Napi::Value NativeTable::GetColByIndex(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "getColByIndex(index)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t idx = (int64_t)info[0].As<Napi::Number>().Int64Value();
    td_t* col = td_table_get_col_idx(tbl_, idx);
    if (!col) {
        Napi::Error::New(env, "Column index out of range").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t name_id = td_table_col_name(tbl_, idx);
    td_t* sym = td_sym_str(name_id);
    std::string name = sym ? std::string(td_str_ptr(sym), td_str_len(sym))
                           : "V" + std::to_string(idx);

    int8_t dtype = td_type(col);
    return NativeSeries::Create(env, col, name, dtype, thread_);
}

Napi::Value NativeTable::SetColName(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        Napi::TypeError::New(env, "setColName(index, name)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t idx = (int64_t)info[0].As<Napi::Number>().Int64Value();
    std::string name = info[1].As<Napi::String>().Utf8Value();
    td_t* tbl = tbl_;

    thread_->dispatch_sync([tbl, idx, name]() -> void* {
        int64_t name_id = td_sym_intern(name.c_str(), name.size());
        td_table_set_col_name(tbl, idx, name_id);
        return nullptr;
    });

    return env.Undefined();
}

Napi::Value NativeTable::Schema(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    td_t* schema = td_table_schema(tbl_);
    if (!schema || TD_IS_ERR(schema)) {
        Napi::Error::New(env, "Failed to get table schema").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int8_t dtype = td_type(schema);
    return NativeSeries::Create(env, schema, ".d", dtype, thread_);
}

// ---- Standalone function: TableNewSync ----

Napi::Value TableNewSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Expected (NativeContext, ncols)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t ncols = (int64_t)info[1].As<Napi::Number>().Int64Value();

    void* result = thread->dispatch_sync([ncols]() -> void* {
        return (void*)td_table_new(ncols);
    });

    td_t* tbl = (td_t*)result;
    if (TD_IS_ERR(tbl)) {
        Napi::Error::New(env, std::string("Table creation failed: ") + td_err_str(TD_ERR_CODE(tbl)))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, tbl, thread);
}

// ---- Column serialization (shared by sync/async) ----

struct ColSpec {
    std::string name;
    int8_t type;
    std::vector<double> f64_data;
    std::vector<int64_t> i64_data;
    std::vector<uint8_t> bool_data;
    std::vector<std::string> str_data;
    int64_t length;
};

// Serialize JS column data into ColSpec vector on V8 thread.
// Returns true on success, false if an exception was thrown.
static bool SerializeColumns(Napi::Env env, Napi::Object data,
                             std::vector<ColSpec>& cols) {
    Napi::Array keys = data.GetPropertyNames();
    uint32_t ncols = keys.Length();
    cols.resize(ncols);

    for (uint32_t i = 0; i < ncols; i++) {
        cols[i].name = keys.Get(i).As<Napi::String>().Utf8Value();
        Napi::Value val = data.Get(cols[i].name);

        if (val.IsTypedArray()) {
            Napi::TypedArray ta = val.As<Napi::TypedArray>();
            cols[i].length = (int64_t)ta.ElementLength();
            napi_typedarray_type taType = ta.TypedArrayType();

            if (taType == napi_float64_array) {
                cols[i].type = TD_F64;
                auto buf = val.As<Napi::Float64Array>();
                cols[i].f64_data.assign(buf.Data(), buf.Data() + cols[i].length);
            } else if (taType == napi_int32_array) {
                cols[i].type = TD_I32;
                auto buf = val.As<Napi::Int32Array>();
                cols[i].i64_data.resize((size_t)cols[i].length);
                for (int64_t j = 0; j < cols[i].length; j++)
                    cols[i].i64_data[(size_t)j] = buf[j];
            } else if (taType == napi_bigint64_array) {
                cols[i].type = TD_I64;
                Napi::ArrayBuffer ab = ta.ArrayBuffer();
                int64_t* src = reinterpret_cast<int64_t*>(
                    static_cast<uint8_t*>(ab.Data()) + ta.ByteOffset());
                cols[i].i64_data.assign(src, src + cols[i].length);
            } else if (taType == napi_float32_array) {
                cols[i].type = TD_F64;
                auto buf = val.As<Napi::Float32Array>();
                cols[i].f64_data.resize((size_t)cols[i].length);
                for (int64_t j = 0; j < cols[i].length; j++)
                    cols[i].f64_data[(size_t)j] = (double)buf[j];
            } else {
                cols[i].type = TD_F64;
                cols[i].f64_data.resize((size_t)cols[i].length);
                Napi::ArrayBuffer ab = ta.ArrayBuffer();
                uint8_t* raw = static_cast<uint8_t*>(ab.Data()) + ta.ByteOffset();
                for (int64_t j = 0; j < cols[i].length; j++)
                    cols[i].f64_data[(size_t)j] = (double)raw[j];
            }
        } else if (val.IsArray()) {
            Napi::Array arr = val.As<Napi::Array>();
            cols[i].length = (int64_t)arr.Length();
            if (arr.Length() == 0) {
                cols[i].type = TD_F64;
                continue;
            }
            Napi::Value first = arr.Get((uint32_t)0);
            if (first.IsBoolean()) {
                cols[i].type = TD_BOOL;
                cols[i].bool_data.resize((size_t)cols[i].length);
                for (uint32_t j = 0; j < arr.Length(); j++)
                    cols[i].bool_data[j] = arr.Get(j).As<Napi::Boolean>().Value() ? 1 : 0;
            } else if (first.IsString()) {
                cols[i].type = TD_SYM;
                cols[i].str_data.resize((size_t)cols[i].length);
                for (uint32_t j = 0; j < arr.Length(); j++)
                    cols[i].str_data[j] = arr.Get(j).As<Napi::String>().Utf8Value();
            } else {
                cols[i].type = TD_F64;
                cols[i].f64_data.resize((size_t)cols[i].length);
                for (uint32_t j = 0; j < arr.Length(); j++)
                    cols[i].f64_data[j] = arr.Get(j).As<Napi::Number>().DoubleValue();
            }
        } else {
            Napi::TypeError::New(env, "Column value must be an Array or TypedArray")
                .ThrowAsJavaScriptException();
            return false;
        }
    }
    return true;
}

// Build a table from serialized column specs on Teide thread.
static void* BuildTableFromCols(std::vector<ColSpec>& cols) {
    uint32_t ncols = (uint32_t)cols.size();
    td_t* tbl = td_table_new((int64_t)ncols);
    if (TD_IS_ERR(tbl)) return tbl;

    for (uint32_t i = 0; i < ncols; i++) {
        int64_t name_id = td_sym_intern(cols[i].name.c_str(), cols[i].name.size());
        int64_t len = cols[i].length;
        td_t* vec = nullptr;

        if (cols[i].type == TD_SYM) {
            uint8_t width = td_sym_dict_width(td_sym_count() + (uint32_t)len);
            vec = td_sym_vec_new(width, len);
            if (TD_IS_ERR(vec)) return vec;
            vec->len = len;
            for (int64_t j = 0; j < len; j++) {
                int64_t sid = td_sym_intern(cols[i].str_data[(size_t)j].c_str(),
                                             cols[i].str_data[(size_t)j].size());
                td_write_sym(td_data(vec), j, (uint64_t)sid, TD_SYM, vec->attrs);
            }
        } else {
            vec = td_vec_new(cols[i].type, len);
            if (TD_IS_ERR(vec)) return vec;
            vec->len = len;
            void* dst = td_data(vec);
            if (cols[i].type == TD_F64) {
                memcpy(dst, cols[i].f64_data.data(), (size_t)len * sizeof(double));
            } else if (cols[i].type == TD_I64) {
                memcpy(dst, cols[i].i64_data.data(), (size_t)len * sizeof(int64_t));
            } else if (cols[i].type == TD_I32) {
                int32_t* dst32 = (int32_t*)dst;
                for (int64_t j = 0; j < len; j++)
                    dst32[j] = (int32_t)cols[i].i64_data[(size_t)j];
            } else if (cols[i].type == TD_BOOL) {
                memcpy(dst, cols[i].bool_data.data(), (size_t)len);
            }
        }
        tbl = td_table_add_col(tbl, name_id, vec);
        td_release(vec);
    }
    return (void*)tbl;
}

// ---- Standalone function: TableFromArraysSync ----

Napi::Value TableFromArraysSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "Expected (NativeContext, object)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    Napi::Object data = info[1].As<Napi::Object>();

    std::vector<ColSpec> cols;
    if (!SerializeColumns(env, data, cols)) return env.Undefined();

    void* result = thread->dispatch_sync([&cols]() -> void* {
        return BuildTableFromCols(cols);
    });

    td_t* tbl = (td_t*)result;
    if (TD_IS_ERR(tbl)) {
        Napi::Error::New(env, std::string("Table creation failed: ") + td_err_str(TD_ERR_CODE(tbl)))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, tbl, thread);
}

// ---- Standalone function: TableFromArrays (async) ----

Napi::Value TableFromArrays(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "Expected (NativeContext, object)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    Napi::Object data = info[1].As<Napi::Object>();

    // Serialize on V8 thread into a shared_ptr so the lambda owns the data
    auto cols = std::make_shared<std::vector<ColSpec>>();
    if (!SerializeColumns(env, data, *cols)) return env.Undefined();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "tableFromArrays", 0, 1);

    thread->dispatch_async(
        [cols]() -> void* {
            return BuildTableFromCols(*cols);
        },
        tsfn,
        [deferred, thread](Napi::Env env, void* data) {
            td_t* tbl = (td_t*)data;
            if (!tbl || TD_IS_ERR(tbl)) {
                std::string msg = "Table creation failed";
                if (tbl && TD_IS_ERR(tbl))
                    msg += std::string(": ") + td_err_str(TD_ERR_CODE(tbl));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, tbl, thread));
            }
        }
    );

    return deferred.Promise();
}
