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
        InstanceMethod("writeCsvSync", &NativeContext::WriteCsvSync),
        InstanceMethod("writeCsv", &NativeContext::WriteCsv),
        InstanceMethod("saveTableSync", &NativeContext::SaveTableSync),
        InstanceMethod("loadTableSync", &NativeContext::LoadTableSync),
        InstanceAccessor("threadExternal", &NativeContext::GetThreadExternal, nullptr),
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

Napi::Value NativeContext::GetThreadExternal(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();
    return Napi::External<TeideThread>::New(env, thread_.get());
}

Napi::Value NativeContext::Destroy(const Napi::CallbackInfo& info) {
    if (!destroyed_ && thread_) {
        thread_->shutdown();
        destroyed_ = true;
    }
    return info.Env().Undefined();
}

static void parse_csv_opts(const Napi::Object& opts, char& delimiter, bool& header,
                           std::vector<int8_t>& col_types) {
    if (opts.Has("delimiter") && opts.Get("delimiter").IsString()) {
        std::string d = opts.Get("delimiter").As<Napi::String>().Utf8Value();
        if (!d.empty()) delimiter = d[0];
    }
    if (opts.Has("header") && opts.Get("header").IsBoolean()) {
        header = opts.Get("header").As<Napi::Boolean>().Value();
    }
    if (opts.Has("columnTypes") && opts.Get("columnTypes").IsArray()) {
        Napi::Array types = opts.Get("columnTypes").As<Napi::Array>();
        for (uint32_t i = 0; i < types.Length(); i++) {
            std::string t = types.Get(i).As<Napi::String>().Utf8Value();
            int8_t td_type = TD_F64;
            if (t == "bool")           td_type = TD_BOOL;
            else if (t == "u8")        td_type = TD_U8;
            else if (t == "i16")       td_type = TD_I16;
            else if (t == "i32")       td_type = TD_I32;
            else if (t == "i64")       td_type = TD_I64;
            else if (t == "f64")       td_type = TD_F64;
            else if (t == "sym")       td_type = TD_SYM;
            else if (t == "date")      td_type = TD_DATE;
            else if (t == "time")      td_type = TD_TIME;
            else if (t == "timestamp") td_type = TD_TIMESTAMP;
            col_types.push_back(td_type);
        }
    }
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
    bool has_opts = info.Length() >= 2 && info[1].IsObject();
    char delimiter = ',';
    bool header = true;
    std::vector<int8_t> col_types;

    if (has_opts) {
        parse_csv_opts(info[1].As<Napi::Object>(), delimiter, header, col_types);
    }

    void* result;
    if (has_opts) {
        result = thread_->dispatch_sync([path, delimiter, header, col_types]() -> void* {
            return (void*)td_read_csv_opts(path.c_str(), delimiter, header,
                                           col_types.empty() ? nullptr : col_types.data(),
                                           (int32_t)col_types.size());
        });
    } else {
        result = thread_->dispatch_sync([path]() -> void* {
            return (void*)td_read_csv(path.c_str());
        });
    }

    td_t* tbl = (td_t*)result;
    if (!tbl || TD_IS_ERR(tbl)) {
        std::string msg = "Failed to read CSV";
        if (tbl && TD_IS_ERR(tbl)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(tbl));
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
    bool has_opts = info.Length() >= 2 && info[1].IsObject();
    char delimiter = ',';
    bool header = true;
    std::vector<int8_t> col_types;

    if (has_opts) {
        parse_csv_opts(info[1].As<Napi::Object>(), delimiter, header, col_types);
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "readCsv", 0, 1);

    TeideThread* thr = thread_.get();
    if (has_opts) {
        thread_->dispatch_async(
            [path, delimiter, header, col_types]() -> void* {
                return (void*)td_read_csv_opts(path.c_str(), delimiter, header,
                                               col_types.empty() ? nullptr : col_types.data(),
                                               (int32_t)col_types.size());
            },
            tsfn,
            [deferred, thr](Napi::Env env, void* data) {
                td_t* tbl = (td_t*)data;
                if (!tbl || TD_IS_ERR(tbl)) {
                    std::string msg = "Failed to read CSV";
                    if (tbl && TD_IS_ERR(tbl)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(tbl));
                    deferred.Reject(Napi::Error::New(env, msg).Value());
                } else {
                    deferred.Resolve(NativeTable::Create(env, tbl, thr));
                }
            }
        );
    } else {
        thread_->dispatch_async(
            [path]() -> void* { return (void*)td_read_csv(path.c_str()); },
            tsfn,
            [deferred, thr](Napi::Env env, void* data) {
                td_t* tbl = (td_t*)data;
                if (!tbl || TD_IS_ERR(tbl)) {
                    std::string msg = "Failed to read CSV";
                    if (tbl && TD_IS_ERR(tbl)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(tbl));
                    deferred.Reject(Napi::Error::New(env, msg).Value());
                } else {
                    deferred.Resolve(NativeTable::Create(env, tbl, thr));
                }
            }
        );
    }

    return deferred.Promise();
}

Napi::Value NativeContext::WriteCsvSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsString()) {
        Napi::TypeError::New(env, "writeCsvSync(table, path)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string path = info[1].As<Napi::String>().Utf8Value();
    td_t* tbl = table->ptr();

    void* result = thread_->dispatch_sync([tbl, path]() -> void* {
        td_err_t err = td_write_csv(tbl, path.c_str());
        return (void*)(uintptr_t)err;
    });

    td_err_t err = (td_err_t)(uintptr_t)result;
    if (err != TD_OK) {
        Napi::Error::New(env, std::string("Failed to write CSV: ") + td_err_str(err))
            .ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

Napi::Value NativeContext::WriteCsv(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsString()) {
        Napi::TypeError::New(env, "writeCsv(table, path)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string path = info[1].As<Napi::String>().Utf8Value();
    td_t* tbl = table->ptr();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "writeCsv", 0, 1);

    td_retain(tbl);
    thread_->dispatch_async(
        [tbl, path]() -> void* {
            td_err_t err = td_write_csv(tbl, path.c_str());
            td_release(tbl);
            return (void*)(uintptr_t)err;
        },
        tsfn,
        [deferred](Napi::Env env, void* data) {
            td_err_t err = (td_err_t)(uintptr_t)data;
            if (err != TD_OK) {
                deferred.Reject(Napi::Error::New(env,
                    std::string("Failed to write CSV: ") + td_err_str(err)).Value());
            } else {
                deferred.Resolve(env.Undefined());
            }
        }
    );

    return deferred.Promise();
}

Napi::Value NativeContext::SaveTableSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsString()) {
        Napi::TypeError::New(env, "saveTableSync(table, dir)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string dir = info[1].As<Napi::String>().Utf8Value();
    std::string sym_path = dir + "/.sym";
    td_t* tbl = table->ptr();

    void* result = thread_->dispatch_sync([tbl, dir, sym_path]() -> void* {
        td_err_t err = td_splay_save(tbl, dir.c_str(), sym_path.c_str());
        return (void*)(uintptr_t)err;
    });

    td_err_t err = (td_err_t)(uintptr_t)result;
    if (err != TD_OK) {
        Napi::Error::New(env, std::string("Failed to save splayed table: ") + td_err_str(err))
            .ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

Napi::Value NativeContext::LoadTableSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    check_alive(env);
    if (env.IsExceptionPending()) return env.Undefined();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string dir path").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string dir = info[0].As<Napi::String>().Utf8Value();
    std::string sym_path = dir + "/.sym";

    void* result = thread_->dispatch_sync([dir, sym_path]() -> void* {
        return (void*)td_read_splayed(dir.c_str(), sym_path.c_str());
    });

    td_t* tbl = (td_t*)result;
    if (!tbl || TD_IS_ERR(tbl)) {
        std::string msg = "Failed to load splayed table";
        if (tbl && TD_IS_ERR(tbl)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(tbl));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return NativeTable::Create(env, tbl, thread_.get());
}
