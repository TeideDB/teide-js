#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"

// Forward-declare td_t (C union defined in td.h, included via compat.h in .cpp files).
extern "C" { typedef union td_t td_t; }

class TeideThread;

class NativeSelection : public Napi::ObjectWrap<NativeSelection> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_t* sel, TeideThread* thread);
    NativeSelection(const Napi::CallbackInfo& info);
    ~NativeSelection();

    td_t* ptr() const { return sel_; }
    TeideThread* thread() const { return thread_; }

private:
    // Static factories (called from JS)
    static Napi::Value NewSync(const Napi::CallbackInfo& info);
    static Napi::Value FromPredSync(const Napi::CallbackInfo& info);

    // Instance methods
    Napi::Value And(const Napi::CallbackInfo& info);
    void Recompute(const Napi::CallbackInfo& info);
    Napi::Value GetNRows(const Napi::CallbackInfo& info);
    Napi::Value GetType(const Napi::CallbackInfo& info);

    td_t* sel_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    static Napi::FunctionReference constructor_;
    static Napi::FunctionReference vec_ctor_;
};
