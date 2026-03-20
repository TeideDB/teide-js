#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"

// Forward-declare td_t (C union defined in td.h, included via compat.h in .cpp files).
extern "C" { typedef union td_t td_t; }

class TeideThread;

class NativeList : public Napi::ObjectWrap<NativeList> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_t* list, TeideThread* thread);
    NativeList(const Napi::CallbackInfo& info);
    ~NativeList();

    td_t* ptr() const { return list_; }
    TeideThread* thread() const { return thread_; }

private:
    // Static factory (called from JS)
    static Napi::Value NewSync(const Napi::CallbackInfo& info);

    // Instance methods
    Napi::Value Append(const Napi::CallbackInfo& info);
    Napi::Value Get(const Napi::CallbackInfo& info);
    void Set(const Napi::CallbackInfo& info);
    Napi::Value GetLength(const Napi::CallbackInfo& info);
    Napi::Value GetType(const Napi::CallbackInfo& info);

    // Helper: extract td_t* from a NativeVector, NativeAtom, or NativeList
    static td_t* ExtractItemPtr(Napi::Env env, Napi::Value val);

    td_t* list_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    static Napi::FunctionReference constructor_;
    static Napi::FunctionReference vec_ctor_;
    static Napi::FunctionReference atom_ctor_;
};
