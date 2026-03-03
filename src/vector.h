#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"
#include <string>

// Forward-declare td_t (C union defined in td.h, included via compat.h in .cpp files).
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
    // Static factories (called from JS)
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
