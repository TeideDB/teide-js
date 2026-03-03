#include "selection.h"
#include "context.h"
#include "vector.h"
#include "compat.h"

extern "C" {
#include <teide/td.h>
}

Napi::FunctionReference NativeSelection::constructor_;
Napi::FunctionReference NativeSelection::vec_ctor_;

// ---------------------------------------------------------------------------
// Init / Create / Constructor / Destructor
// ---------------------------------------------------------------------------

Napi::Object NativeSelection::Init(Napi::Env env, Napi::Object exports) {
    // Save reference to NativeVector constructor for instanceof checks.
    vec_ctor_ = Napi::Persistent(exports.Get("NativeVector").As<Napi::Function>());
    vec_ctor_.SuppressDestruct();

    Napi::Function func = DefineClass(env, "NativeSelection", {
        StaticMethod("newSync", &NativeSelection::NewSync),
        StaticMethod("fromPredSync", &NativeSelection::FromPredSync),
        InstanceMethod("and_", &NativeSelection::And),
        InstanceMethod("recompute", &NativeSelection::Recompute),
        InstanceAccessor("nRows", &NativeSelection::GetNRows, nullptr),
        InstanceAccessor("type", &NativeSelection::GetType, nullptr),
    });

    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();

    exports.Set("NativeSelection", func);
    return exports;
}

Napi::Object NativeSelection::Create(Napi::Env env, td_t* sel, TeideThread* thread) {
    Napi::Object obj = constructor_.New({
        Napi::External<td_t>::New(env, sel),
        Napi::External<TeideThread>::New(env, thread),
    });
    return obj;
}

NativeSelection::NativeSelection(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeSelection>(info), sel_(nullptr), thread_(nullptr) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "NativeSelection: internal constructor requires 2 arguments")
            .ThrowAsJavaScriptException();
        return;
    }

    sel_ = info[0].As<Napi::External<td_t>>().Data();
    thread_ = info[1].As<Napi::External<TeideThread>>().Data();
    heap_alive_ = thread_->heap_alive();

    if (sel_) td_retain(sel_);
}

NativeSelection::~NativeSelection() {
    if (sel_ && heap_alive_ && heap_alive_->load()) td_release(sel_);
}

// ---------------------------------------------------------------------------
// Static factories
// ---------------------------------------------------------------------------

Napi::Value NativeSelection::NewSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeSelection.newSync(ctx, nrows)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t nrows = (int64_t)info[1].As<Napi::Number>().Int64Value();

    void* result = thread->dispatch_sync([nrows]() -> void* {
        return (void*)td_sel_new(nrows);
    });

    td_t* sel = (td_t*)result;
    if (!sel || TD_IS_ERR(sel)) {
        Napi::Error::New(env, "Failed to create selection").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeSelection::Create(env, sel, thread);
}

Napi::Value NativeSelection::FromPredSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "NativeSelection.fromPredSync(boolVec)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object obj = info[0].As<Napi::Object>();
    if (!obj.InstanceOf(vec_ctor_.Value())) {
        Napi::TypeError::New(env, "fromPredSync: argument must be a NativeVector")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeVector* vec = Napi::ObjectWrap<NativeVector>::Unwrap(obj);
    td_t* vec_ptr = vec->ptr();
    TeideThread* thread = vec->thread();

    void* result = thread->dispatch_sync([vec_ptr]() -> void* {
        return (void*)td_sel_from_pred(vec_ptr);
    });

    td_t* sel = (td_t*)result;
    if (!sel || TD_IS_ERR(sel)) {
        Napi::Error::New(env, "Failed to create selection from predicate").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeSelection::Create(env, sel, thread);
}

// ---------------------------------------------------------------------------
// Instance methods
// ---------------------------------------------------------------------------

Napi::Value NativeSelection::And(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "and_(other)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object obj = info[0].As<Napi::Object>();
    if (!obj.InstanceOf(constructor_.Value())) {
        Napi::TypeError::New(env, "and_: argument must be a NativeSelection")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeSelection* other = Napi::ObjectWrap<NativeSelection>::Unwrap(obj);
    td_t* a = sel_;
    td_t* b = other->sel_;

    void* result = thread_->dispatch_sync([a, b]() -> void* {
        return (void*)td_sel_and(a, b);
    });

    td_t* sel = (td_t*)result;
    if (!sel || TD_IS_ERR(sel)) {
        Napi::Error::New(env, "Failed to AND selections").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeSelection::Create(env, sel, thread_);
}

void NativeSelection::Recompute(const Napi::CallbackInfo& info) {
    td_t* s = sel_;
    thread_->dispatch_sync([s]() -> void* {
        td_sel_recompute(s);
        return nullptr;
    });
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

Napi::Value NativeSelection::GetNRows(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), (double)td_len(sel_));
}

Napi::Value NativeSelection::GetType(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), "sel");
}
