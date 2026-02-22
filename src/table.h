#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"
#include <string>

// Forward-declare td_t (C union defined in td.h, included via compat.h in .cpp files).
extern "C" { typedef union td_t td_t; }

class TeideThread;

class NativeTable : public Napi::ObjectWrap<NativeTable> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_t* tbl, TeideThread* thread);
    NativeTable(const Napi::CallbackInfo& info);
    ~NativeTable();

    td_t* ptr() const { return tbl_; }
    TeideThread* thread() const { return thread_; }

private:
    Napi::Value GetNRows(const Napi::CallbackInfo& info);
    Napi::Value GetNCols(const Napi::CallbackInfo& info);
    Napi::Value GetColumns(const Napi::CallbackInfo& info);
    Napi::Value Col(const Napi::CallbackInfo& info);

    td_t* tbl_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    static Napi::FunctionReference constructor_;
};
