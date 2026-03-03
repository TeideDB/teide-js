#pragma once

#include "teide_thread.h"
#include <string>

extern "C" {
    typedef union td_t td_t;
    typedef struct td_rel td_rel_t;
}

class TeideThread;

class NativeRel : public Napi::ObjectWrap<NativeRel> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object Create(Napi::Env env, td_rel_t* rel, TeideThread* thread);
    NativeRel(const Napi::CallbackInfo& info);
    ~NativeRel();

    td_rel_t* ptr() const { return rel_; }
    TeideThread* thread() const { return thread_; }

private:
    // Static factory methods
    static Napi::Value FromEdgesSync(const Napi::CallbackInfo& info);
    static Napi::Value FromEdges(const Napi::CallbackInfo& info);
    static Napi::Value BuildSync(const Napi::CallbackInfo& info);
    static Napi::Value Build(const Napi::CallbackInfo& info);
    static Napi::Value LoadSync(const Napi::CallbackInfo& info);
    static Napi::Value Load(const Napi::CallbackInfo& info);
    static Napi::Value MmapSync(const Napi::CallbackInfo& info);

    // Instance methods
    Napi::Value SaveSync(const Napi::CallbackInfo& info);
    Napi::Value Save(const Napi::CallbackInfo& info);
    Napi::Value Destroy(const Napi::CallbackInfo& info);

    td_rel_t* rel_;
    TeideThread* thread_;
    std::shared_ptr<std::atomic<bool>> heap_alive_;
    bool destroyed_ = false;
    static Napi::FunctionReference constructor_;
};
