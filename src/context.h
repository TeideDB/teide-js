#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"

class NativeContext : public Napi::ObjectWrap<NativeContext> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    NativeContext(const Napi::CallbackInfo& info);
    ~NativeContext();

    TeideThread& thread() { return *thread_; }
    void check_alive(Napi::Env env);

    Napi::Value GetThreadExternal(const Napi::CallbackInfo& info);

private:
    Napi::Value Destroy(const Napi::CallbackInfo& info);
    Napi::Value ReadCsvSync(const Napi::CallbackInfo& info);
    Napi::Value ReadCsv(const Napi::CallbackInfo& info);
    Napi::Value WriteCsvSync(const Napi::CallbackInfo& info);
    Napi::Value WriteCsv(const Napi::CallbackInfo& info);
    Napi::Value SaveTableSync(const Napi::CallbackInfo& info);
    Napi::Value LoadTableSync(const Napi::CallbackInfo& info);
    Napi::Value LoadColSync(const Napi::CallbackInfo& info);
    Napi::Value MmapColSync(const Napi::CallbackInfo& info);
    Napi::Value ReadPartedSync(const Napi::CallbackInfo& info);
    Napi::Value ReadParted(const Napi::CallbackInfo& info);
    Napi::Value SaveSymbolsSync(const Napi::CallbackInfo& info);
    Napi::Value SaveSymbols(const Napi::CallbackInfo& info);
    Napi::Value LoadSymbolsSync(const Napi::CallbackInfo& info);
    Napi::Value LoadSymbols(const Napi::CallbackInfo& info);
    Napi::Value SaveMetaSync(const Napi::CallbackInfo& info);
    Napi::Value SaveMeta(const Napi::CallbackInfo& info);
    Napi::Value LoadMetaSync(const Napi::CallbackInfo& info);
    Napi::Value LoadMeta(const Napi::CallbackInfo& info);

    std::unique_ptr<TeideThread> thread_;
    bool destroyed_ = false;
};
