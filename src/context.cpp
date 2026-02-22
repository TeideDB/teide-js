// context.h MUST come first — it pulls in teide_thread.h which brings
// <napi.h>, <atomic>, and other C++ headers before the C-atomic shim.
#include "context.h"
#include "table.h"
#include "compat.h"

Napi::Object NativeContext::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeContext", {
        InstanceMethod("destroy", &NativeContext::Destroy),
        InstanceMethod("readCsvSync", &NativeContext::ReadCsvSync),
        InstanceMethod("readCsv", &NativeContext::ReadCsv),
    });
    exports.Set("NativeContext", func);
    return exports;
}

NativeContext::NativeContext(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeContext>(info) {
    thread_ = std::make_unique<TeideThread>();
}

NativeContext::~NativeContext() {
    if (!destroyed_ && thread_) thread_->shutdown();
}

void NativeContext::check_alive(Napi::Env env) {
    if (destroyed_) {
        Napi::Error::New(env, "Context has been destroyed").ThrowAsJavaScriptException();
    }
}

Napi::Value NativeContext::Destroy(const Napi::CallbackInfo& info) {
    if (!destroyed_ && thread_) {
        thread_->shutdown();
        destroyed_ = true;
    }
    return info.Env().Undefined();
}

Napi::Value NativeContext::ReadCsvSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string path").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    void* result = thread_->dispatch_sync([path]() -> void* {
        return (void*)td_read_csv(path.c_str());
    });

    td_t* tbl = (td_t*)result;
    if (TD_IS_ERR(tbl)) {
        std::string msg = "Failed to read CSV: ";
        msg += td_err_str(TD_ERR_CODE(tbl));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return NativeTable::Create(env, tbl, thread_.get());
}

Napi::Value NativeContext::ReadCsv(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string path").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "readCsv", 0, 1);

    TeideThread* thr = thread_.get();
    thread_->dispatch_async(
        [path]() -> void* { return (void*)td_read_csv(path.c_str()); },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_t* tbl = (td_t*)data;
            if (TD_IS_ERR(tbl)) {
                deferred.Reject(Napi::Error::New(env,
                    std::string("Failed to read CSV: ") + td_err_str(TD_ERR_CODE(tbl))).Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, (td_t*)data, thr));
            }
        }
    );

    return deferred.Promise();
}
