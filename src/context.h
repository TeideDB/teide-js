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

private:
    Napi::Value Destroy(const Napi::CallbackInfo& info);
    Napi::Value ReadCsvSync(const Napi::CallbackInfo& info);
    Napi::Value ReadCsv(const Napi::CallbackInfo& info);

    std::unique_ptr<TeideThread> thread_;
    bool destroyed_ = false;
};
