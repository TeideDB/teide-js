#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"
#include <string>

// Forward-declare td_t (C union defined in td.h, included via compat.h
// in .cpp files). The header only uses pointers, so a forward decl suffices.
extern "C" { typedef union td_t td_t; }

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

    Napi::Value CreateZeroCopyArray(Napi::Env env, void* data, int64_t length,
                                     size_t elem_size, napi_typedarray_type arr_type);
    static void* ResolveDataPtr(td_t* vec, int8_t dtype);

    td_t* vec_;
    std::string name_;
    int8_t dtype_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    Napi::Reference<Napi::Value> cached_data_;
    static Napi::FunctionReference constructor_;
};
