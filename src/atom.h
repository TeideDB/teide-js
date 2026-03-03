#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"

// Forward-declare td_t (C union defined in td.h, included via compat.h in .cpp files).
extern "C" { typedef union td_t td_t; }

class TeideThread;

class NativeAtom : public Napi::ObjectWrap<NativeAtom> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_t* atom, TeideThread* thread);
    NativeAtom(const Napi::CallbackInfo& info);
    ~NativeAtom();

    td_t* ptr() const { return atom_; }
    TeideThread* thread() const { return thread_; }

private:
    // Static factories (called from JS)
    static Napi::Value Bool(const Napi::CallbackInfo& info);
    static Napi::Value U8(const Napi::CallbackInfo& info);
    static Napi::Value I16(const Napi::CallbackInfo& info);
    static Napi::Value I32(const Napi::CallbackInfo& info);
    static Napi::Value I64(const Napi::CallbackInfo& info);
    static Napi::Value F64(const Napi::CallbackInfo& info);
    static Napi::Value Str(const Napi::CallbackInfo& info);
    static Napi::Value Sym(const Napi::CallbackInfo& info);
    static Napi::Value Date(const Napi::CallbackInfo& info);
    static Napi::Value Time(const Napi::CallbackInfo& info);
    static Napi::Value Timestamp(const Napi::CallbackInfo& info);
    static Napi::Value Guid(const Napi::CallbackInfo& info);

    // Instance accessors
    Napi::Value GetValue(const Napi::CallbackInfo& info);
    Napi::Value GetType(const Napi::CallbackInfo& info);

    td_t* atom_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    static Napi::FunctionReference constructor_;
};
