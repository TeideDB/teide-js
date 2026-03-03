#include "list.h"
#include "context.h"
#include "vector.h"
#include "atom.h"
#include "compat.h"

extern "C" {
#include <teide/td.h>
}

Napi::FunctionReference NativeList::constructor_;
Napi::FunctionReference NativeList::vec_ctor_;
Napi::FunctionReference NativeList::atom_ctor_;

// ---------------------------------------------------------------------------
// Init / Create / Constructor / Destructor
// ---------------------------------------------------------------------------

Napi::Object NativeList::Init(Napi::Env env, Napi::Object exports) {
    // Save references to other native constructors for instanceof checks.
    // NativeVector and NativeAtom must be Init'd before NativeList.
    vec_ctor_ = Napi::Persistent(exports.Get("NativeVector").As<Napi::Function>());
    vec_ctor_.SuppressDestruct();
    atom_ctor_ = Napi::Persistent(exports.Get("NativeAtom").As<Napi::Function>());
    atom_ctor_.SuppressDestruct();

    Napi::Function func = DefineClass(env, "NativeList", {
        StaticMethod("newSync", &NativeList::NewSync),
        InstanceMethod("append", &NativeList::Append),
        InstanceMethod("get", &NativeList::Get),
        InstanceMethod("set", &NativeList::Set),
        InstanceAccessor("length", &NativeList::GetLength, nullptr),
        InstanceAccessor("type", &NativeList::GetType, nullptr),
    });

    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();

    exports.Set("NativeList", func);
    return exports;
}

Napi::Object NativeList::Create(Napi::Env env, td_t* list, TeideThread* thread) {
    Napi::Object obj = constructor_.New({
        Napi::External<td_t>::New(env, list),
        Napi::External<TeideThread>::New(env, thread),
    });
    return obj;
}

NativeList::NativeList(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeList>(info), list_(nullptr), thread_(nullptr) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "NativeList: internal constructor requires 2 arguments")
            .ThrowAsJavaScriptException();
        return;
    }

    list_ = info[0].As<Napi::External<td_t>>().Data();
    thread_ = info[1].As<Napi::External<TeideThread>>().Data();
    heap_alive_ = thread_->heap_alive();

    if (list_) td_retain(list_);
}

NativeList::~NativeList() {
    if (list_ && heap_alive_ && heap_alive_->load()) td_release(list_);
}

// ---------------------------------------------------------------------------
// Helper: extract td_t* from any native wrapper
// ---------------------------------------------------------------------------

td_t* NativeList::ExtractItemPtr(Napi::Env env, Napi::Value val) {
    if (!val.IsObject()) return nullptr;
    Napi::Object obj = val.As<Napi::Object>();

    if (obj.InstanceOf(vec_ctor_.Value())) {
        return Napi::ObjectWrap<NativeVector>::Unwrap(obj)->ptr();
    }
    if (obj.InstanceOf(atom_ctor_.Value())) {
        return Napi::ObjectWrap<NativeAtom>::Unwrap(obj)->ptr();
    }
    if (obj.InstanceOf(constructor_.Value())) {
        return Napi::ObjectWrap<NativeList>::Unwrap(obj)->ptr();
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// Static factory
// ---------------------------------------------------------------------------

Napi::Value NativeList::NewSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeList.newSync(ctx, capacity)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t capacity = (int64_t)info[1].As<Napi::Number>().Int64Value();

    void* result = thread->dispatch_sync([capacity]() -> void* {
        return (void*)td_list_new(capacity);
    });

    td_t* list = (td_t*)result;
    if (!list || TD_IS_ERR(list)) {
        Napi::Error::New(env, "Failed to create list").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeList::Create(env, list, thread);
}

// ---------------------------------------------------------------------------
// Instance methods
// ---------------------------------------------------------------------------

Napi::Value NativeList::Append(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1) {
        Napi::TypeError::New(env, "append(item)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    td_t* item = ExtractItemPtr(env, info[0]);
    if (!item) {
        Napi::TypeError::New(env, "append: argument must be a NativeVector, NativeAtom, or NativeList")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    td_t* old_list = list_;
    void* result = thread_->dispatch_sync([old_list, item]() -> void* {
        return (void*)td_list_append(old_list, item);
    });

    td_t* new_list = (td_t*)result;
    if (!new_list || TD_IS_ERR(new_list)) {
        Napi::Error::New(env, "Failed to append to list").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeList::Create(env, new_list, thread_);
}

Napi::Value NativeList::Get(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "get(index)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t idx = (int64_t)info[0].As<Napi::Number>().Int64Value();
    td_t* old_list = list_;

    void* result = thread_->dispatch_sync([old_list, idx]() -> void* {
        return (void*)td_list_get(old_list, idx);
    });

    td_t* item = (td_t*)result;
    if (!item || TD_IS_ERR(item)) {
        return env.Null();
    }

    int8_t type = td_type(item);
    if (type == TD_LIST) {
        return NativeList::Create(env, item, thread_);
    } else if (type < 0) {
        return NativeAtom::Create(env, item, thread_);
    } else {
        return NativeVector::Create(env, item, thread_);
    }
}

void NativeList::Set(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "set(index, item)").ThrowAsJavaScriptException();
        return;
    }

    int64_t idx = (int64_t)info[0].As<Napi::Number>().Int64Value();
    td_t* item = ExtractItemPtr(env, info[1]);
    if (!item) {
        Napi::TypeError::New(env, "set: second argument must be a NativeVector, NativeAtom, or NativeList")
            .ThrowAsJavaScriptException();
        return;
    }

    td_t* old_list = list_;
    void* result = thread_->dispatch_sync([old_list, idx, item]() -> void* {
        return (void*)td_list_set(old_list, idx, item);
    });

    td_t* new_list = (td_t*)result;
    if (!new_list || TD_IS_ERR(new_list)) {
        Napi::Error::New(env, "Failed to set list element").ThrowAsJavaScriptException();
        return;
    }

    // If COW happened, update the internal pointer with proper ref counting.
    if (new_list && new_list != list_) {
        td_retain(new_list);
        if (heap_alive_ && heap_alive_->load()) td_release(list_);
        list_ = new_list;
    }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

Napi::Value NativeList::GetLength(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), (double)td_len(list_));
}

Napi::Value NativeList::GetType(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), "list");
}
