// table.h MUST come first -- it pulls in teide_thread.h which brings
// <napi.h>, <atomic>, and other C++ headers before the C-atomic shim.
#include "table.h"
#include "series.h"
#include "compat.h"

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
