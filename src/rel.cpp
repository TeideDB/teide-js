#include "rel.h"
#include "table.h"
#include "compat.h"

Napi::FunctionReference NativeRel::constructor_;

Napi::Object NativeRel::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeRel", {
        StaticMethod("fromEdgesSync", &NativeRel::FromEdgesSync),
        StaticMethod("fromEdges", &NativeRel::FromEdges),
        StaticMethod("buildSync", &NativeRel::BuildSync),
        StaticMethod("build", &NativeRel::Build),
        StaticMethod("loadSync", &NativeRel::LoadSync),
        StaticMethod("load", &NativeRel::Load),
        StaticMethod("mmapSync", &NativeRel::MmapSync),
        StaticMethod("mmap", &NativeRel::Mmap),
        InstanceMethod("saveSync", &NativeRel::SaveSync),
        InstanceMethod("save", &NativeRel::Save),
        InstanceMethod("destroy", &NativeRel::Destroy),
    });
    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();
    exports.Set("NativeRel", func);
    return exports;
}

Napi::Object NativeRel::Create(Napi::Env env, td_rel_t* rel, TeideThread* thread) {
    return constructor_.New({
        Napi::External<td_rel_t>::New(env, rel),
        Napi::External<TeideThread>::New(env, thread),
    });
}

NativeRel::NativeRel(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeRel>(info), rel_(nullptr), thread_(nullptr) {
    Napi::Env env = info.Env();
    if (info.Length() >= 2) {
        rel_ = info[0].As<Napi::External<td_rel_t>>().Data();
        thread_ = info[1].As<Napi::External<TeideThread>>().Data();
        heap_alive_ = thread_->heap_alive();
    }
}

NativeRel::~NativeRel() {
    if (rel_ && !destroyed_ && heap_alive_ && heap_alive_->load()) {
        if (thread_ && thread_->is_running()) {
            td_rel_t* r = rel_;
            thread_->dispatch_sync([r]() -> void* {
                td_rel_free(r);
                return nullptr;
            });
        }
        // else: thread shut down, heap being torn down — accept leak
    }
}

// --- FromEdgesSync(nativeTable, srcCol, dstCol, nSrc, nDst, sort) ---
Napi::Value NativeRel::FromEdgesSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) {
        Napi::TypeError::New(env, "fromEdgesSync requires 6 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string src_col = info[1].As<Napi::String>().Utf8Value();
    std::string dst_col = info[2].As<Napi::String>().Utf8Value();
    int64_t n_src = info[3].As<Napi::Number>().Int64Value();
    int64_t n_dst = info[4].As<Napi::Number>().Int64Value();
    bool sort = info[5].As<Napi::Boolean>().Value();

    if (n_src <= 0 || n_dst <= 0) {
        Napi::RangeError::New(env, "nSrc and nDst must be positive").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thr->dispatch_sync([tbl, src_col, dst_col, n_src, n_dst, sort]() -> void* {
        return (void*)td_rel_from_edges(tbl, src_col.c_str(), dst_col.c_str(),
                                         n_src, n_dst, sort);
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel || TD_IS_ERR(rel)) {
        std::string msg = "Failed to build relationship from edges";
        if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- FromEdges (async) ---
Napi::Value NativeRel::FromEdges(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) {
        Napi::TypeError::New(env, "fromEdges requires 6 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string src_col = info[1].As<Napi::String>().Utf8Value();
    std::string dst_col = info[2].As<Napi::String>().Utf8Value();
    int64_t n_src = info[3].As<Napi::Number>().Int64Value();
    int64_t n_dst = info[4].As<Napi::Number>().Int64Value();
    bool sort = info[5].As<Napi::Boolean>().Value();

    if (n_src <= 0 || n_dst <= 0) {
        Napi::RangeError::New(env, "nSrc and nDst must be positive").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "fromEdges", 0, 1);

    td_retain(tbl);
    thr->dispatch_async(
        [tbl, src_col, dst_col, n_src, n_dst, sort]() -> void* {
            auto* r = (void*)td_rel_from_edges(tbl, src_col.c_str(), dst_col.c_str(),
                                                n_src, n_dst, sort);
            td_release(tbl);
            return r;
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_rel_t* rel = (td_rel_t*)data;
            if (!rel || TD_IS_ERR(rel)) {
                std::string msg = "Failed to build relationship from edges";
                if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeRel::Create(env, rel, thr));
            }
        }
    );
    return deferred.Promise();
}

// --- BuildSync(nativeTable, fkCol, nTargetNodes, sort) ---
Napi::Value NativeRel::BuildSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "buildSync requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string fk_col = info[1].As<Napi::String>().Utf8Value();
    int64_t n_target = info[2].As<Napi::Number>().Int64Value();
    bool sort = info[3].As<Napi::Boolean>().Value();

    if (n_target <= 0) {
        Napi::RangeError::New(env, "nTargetNodes must be positive").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thr->dispatch_sync([tbl, fk_col, n_target, sort]() -> void* {
        return (void*)td_rel_build(tbl, fk_col.c_str(), n_target, sort);
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel || TD_IS_ERR(rel)) {
        std::string msg = "Failed to build relationship";
        if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- Build (async) ---
Napi::Value NativeRel::Build(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "build requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string fk_col = info[1].As<Napi::String>().Utf8Value();
    int64_t n_target = info[2].As<Napi::Number>().Int64Value();
    bool sort = info[3].As<Napi::Boolean>().Value();

    if (n_target <= 0) {
        Napi::RangeError::New(env, "nTargetNodes must be positive").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    td_t* tbl = table->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "build", 0, 1);

    td_retain(tbl);
    thr->dispatch_async(
        [tbl, fk_col, n_target, sort]() -> void* {
            auto* r = (void*)td_rel_build(tbl, fk_col.c_str(), n_target, sort);
            td_release(tbl);
            return r;
        },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_rel_t* rel = (td_rel_t*)data;
            if (!rel || TD_IS_ERR(rel)) {
                std::string msg = "Failed to build relationship";
                if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeRel::Create(env, rel, thr));
            }
        }
    );
    return deferred.Promise();
}

// --- LoadSync(dir, thread_external) ---
Napi::Value NativeRel::LoadSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "loadSync requires (dir, threadExternal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    TeideThread* thr = info[1].As<Napi::External<TeideThread>>().Data();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thr->dispatch_sync([dir]() -> void* {
        return (void*)td_rel_load(dir.c_str());
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel || TD_IS_ERR(rel)) {
        std::string msg = "Failed to load relationship from: " + dir;
        if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- Load (async) ---
Napi::Value NativeRel::Load(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "load requires (dir, threadExternal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    TeideThread* thr = info[1].As<Napi::External<TeideThread>>().Data();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "relLoad", 0, 1);

    thr->dispatch_async(
        [dir]() -> void* { return (void*)td_rel_load(dir.c_str()); },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_rel_t* rel = (td_rel_t*)data;
            if (!rel || TD_IS_ERR(rel)) {
                std::string msg = "Failed to load relationship";
                if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeRel::Create(env, rel, thr));
            }
        }
    );
    return deferred.Promise();
}

// --- MmapSync(dir, thread_external) ---
Napi::Value NativeRel::MmapSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "mmapSync requires (dir, threadExternal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    TeideThread* thr = info[1].As<Napi::External<TeideThread>>().Data();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thr->dispatch_sync([dir]() -> void* {
        return (void*)td_rel_mmap(dir.c_str());
    });

    td_rel_t* rel = (td_rel_t*)result;
    if (!rel || TD_IS_ERR(rel)) {
        std::string msg = "Failed to mmap relationship from: " + dir;
        if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeRel::Create(env, rel, thr);
}

// --- Mmap (async) ---
Napi::Value NativeRel::Mmap(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "mmap requires (dir, threadExternal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    TeideThread* thr = info[1].As<Napi::External<TeideThread>>().Data();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "relMmap", 0, 1);

    thr->dispatch_async(
        [dir]() -> void* { return (void*)td_rel_mmap(dir.c_str()); },
        tsfn,
        [deferred, thr](Napi::Env env, void* data) {
            td_rel_t* rel = (td_rel_t*)data;
            if (!rel || TD_IS_ERR(rel)) {
                std::string msg = "Failed to mmap relationship";
                if (rel && TD_IS_ERR(rel)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(rel));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeRel::Create(env, rel, thr));
            }
        }
    );
    return deferred.Promise();
}

// --- SaveSync(dir) ---
Napi::Value NativeRel::SaveSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "saveSync requires a directory path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (destroyed_ || !rel_) {
        Napi::Error::New(env, "Cannot save: Rel has been destroyed").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (!thread_ || !thread_->is_running()) {
        Napi::Error::New(env, "Cannot save: context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    td_rel_t* rel = rel_;

    void* result = thread_->dispatch_sync([rel, dir]() -> void* {
        td_err_t err = td_rel_save(rel, dir.c_str());
        return (void*)(intptr_t)err;
    });

    intptr_t err = (intptr_t)result;
    if (err != 0) {
        std::string msg = "Failed to save relationship to: " + dir + ": " + td_err_str((td_err_t)err);
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

// --- Save (async) ---
Napi::Value NativeRel::Save(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "save requires a directory path").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (destroyed_ || !rel_) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Cannot save: Rel has been destroyed").Value());
        return d.Promise();
    }
    if (!thread_ || !thread_->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Cannot save: context has been shut down").Value());
        return d.Promise();
    }
    std::string dir = info[0].As<Napi::String>().Utf8Value();
    td_rel_t* rel = rel_;

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "relSave", 0, 1);

    // Prevent GC of NativeRel during async save (no retain/release for td_rel_t)
    auto self_ref = std::make_shared<Napi::ObjectReference>(
        Napi::Persistent(info.This().As<Napi::Object>()));

    thread_->dispatch_async(
        [rel, dir]() -> void* {
            td_err_t err = td_rel_save(rel, dir.c_str());
            return (void*)(intptr_t)err;
        },
        tsfn,
        [deferred, self_ref](Napi::Env env, void* data) {
            self_ref->Reset();
            intptr_t err = (intptr_t)data;
            if (err != 0) {
                std::string msg = std::string("Failed to save relationship: ") + td_err_str((td_err_t)err);
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(env.Undefined());
            }
        }
    );
    return deferred.Promise();
}

// --- Destroy ---
// Dispatches td_rel_free through the Teide thread so it serializes behind
// any in-flight async ops that captured the raw td_rel_t* pointer.
Napi::Value NativeRel::Destroy(const Napi::CallbackInfo& info) {
    if (!destroyed_ && rel_) {
        destroyed_ = true;
        td_rel_t* r = rel_;
        rel_ = nullptr;
        if (heap_alive_ && heap_alive_->load() && thread_ && thread_->is_running()) {
            thread_->dispatch_sync([r]() -> void* {
                td_rel_free(r);
                return nullptr;
            });
        }
    }
    return info.Env().Undefined();
}
