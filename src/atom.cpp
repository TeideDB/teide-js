// atom.h MUST come first -- it pulls in teide_thread.h which brings
// <napi.h>, <atomic>, and other C++ headers before the C-atomic shim.
#include "atom.h"
#include "context.h"
#include "compat.h"

#include <cstring>

Napi::FunctionReference NativeAtom::constructor_;

// ---------------------------------------------------------------------------
// Type name helper (atom types are negative)
// ---------------------------------------------------------------------------

static const char* AtomTypeName(int8_t t) {
    switch (t) {
        case TD_ATOM_BOOL:      return "bool";
        case TD_ATOM_U8:        return "u8";
        case TD_ATOM_I16:       return "i16";
        case TD_ATOM_I32:       return "i32";
        case TD_ATOM_I64:       return "i64";
        case TD_ATOM_F64:       return "f64";
        case TD_ATOM_STR:       return "str";
        case TD_ATOM_SYM:       return "sym";
        case TD_ATOM_DATE:      return "date";
        case TD_ATOM_TIME:      return "time";
        case TD_ATOM_TIMESTAMP: return "timestamp";
        case TD_ATOM_GUID:      return "guid";
        default:                return "unknown";
    }
}

// ---------------------------------------------------------------------------
// Init / Create / Constructor / Destructor
// ---------------------------------------------------------------------------

Napi::Object NativeAtom::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeAtom", {
        StaticMethod("bool", &NativeAtom::Bool),
        StaticMethod("u8", &NativeAtom::U8),
        StaticMethod("i16", &NativeAtom::I16),
        StaticMethod("i32", &NativeAtom::I32),
        StaticMethod("i64", &NativeAtom::I64),
        StaticMethod("f64", &NativeAtom::F64),
        StaticMethod("str", &NativeAtom::Str),
        StaticMethod("sym", &NativeAtom::Sym),
        StaticMethod("date", &NativeAtom::Date),
        StaticMethod("time", &NativeAtom::Time),
        StaticMethod("timestamp", &NativeAtom::Timestamp),
        StaticMethod("guid", &NativeAtom::Guid),
        InstanceAccessor("value", &NativeAtom::GetValue, nullptr),
        InstanceAccessor("type", &NativeAtom::GetType, nullptr),
    });

    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();

    exports.Set("NativeAtom", func);
    return exports;
}

Napi::Object NativeAtom::Create(Napi::Env env, td_t* atom, TeideThread* thread) {
    Napi::Object obj = constructor_.New({
        Napi::External<td_t>::New(env, atom),
        Napi::External<TeideThread>::New(env, thread),
    });
    return obj;
}

NativeAtom::NativeAtom(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeAtom>(info), atom_(nullptr), thread_(nullptr) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "NativeAtom: internal constructor requires 2 arguments")
            .ThrowAsJavaScriptException();
        return;
    }

    atom_ = info[0].As<Napi::External<td_t>>().Data();
    thread_ = info[1].As<Napi::External<TeideThread>>().Data();
    heap_alive_ = thread_->heap_alive();

    if (atom_) td_retain(atom_);
}

NativeAtom::~NativeAtom() {
    if (atom_ && heap_alive_ && heap_alive_->load()) td_release(atom_);
}

// ---------------------------------------------------------------------------
// Static factories — each dispatches to the Teide thread
// ---------------------------------------------------------------------------

Napi::Value NativeAtom::Bool(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "NativeAtom.bool(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    bool val = info[1].As<Napi::Boolean>().Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_bool(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create bool atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::U8(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeAtom.u8(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    uint8_t val = (uint8_t)info[1].As<Napi::Number>().Uint32Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_u8(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create u8 atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::I16(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeAtom.i16(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int16_t val = (int16_t)info[1].As<Napi::Number>().Int32Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_i16(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create i16 atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::I32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeAtom.i32(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int32_t val = info[1].As<Napi::Number>().Int32Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_i32(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create i32 atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::I64(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || (!info[1].IsNumber() && !info[1].IsBigInt())) {
        Napi::TypeError::New(env, "NativeAtom.i64(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t val;
    if (info[1].IsBigInt()) {
        bool lossless;
        val = info[1].As<Napi::BigInt>().Int64Value(&lossless);
    } else {
        val = info[1].As<Napi::Number>().Int64Value();
    }

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_i64(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create i64 atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::F64(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeAtom.f64(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    double val = info[1].As<Napi::Number>().DoubleValue();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_f64(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create f64 atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::Str(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsString()) {
        Napi::TypeError::New(env, "NativeAtom.str(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    std::string val = info[1].As<Napi::String>().Utf8Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_str(val.c_str(), val.size());
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create str atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::Sym(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeAtom.sym(ctx, id)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t val = info[1].As<Napi::Number>().Int64Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_sym(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create sym atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::Date(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeAtom.date(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t val = info[1].As<Napi::Number>().Int64Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_date(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create date atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::Time(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "NativeAtom.time(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t val = info[1].As<Napi::Number>().Int64Value();

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_time(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create time atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::Timestamp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || (!info[1].IsNumber() && !info[1].IsBigInt())) {
        Napi::TypeError::New(env, "NativeAtom.timestamp(ctx, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    int64_t val;
    if (info[1].IsBigInt()) {
        bool lossless;
        val = info[1].As<Napi::BigInt>().Int64Value(&lossless);
    } else {
        val = info[1].As<Napi::Number>().Int64Value();
    }

    void* result = thread->dispatch_sync([val]() -> void* {
        return (void*)td_timestamp(val);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create timestamp atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

Napi::Value NativeAtom::Guid(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsTypedArray()) {
        Napi::TypeError::New(env, "NativeAtom.guid(ctx, uint8Array)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    Napi::TypedArray ta = info[1].As<Napi::TypedArray>();

    if (ta.ByteLength() < 16) {
        Napi::TypeError::New(env, "GUID requires 16 bytes").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Copy the 16 bytes for safe transfer to Teide thread
    uint8_t bytes[16];
    Napi::ArrayBuffer ab = ta.ArrayBuffer();
    memcpy(bytes, (uint8_t*)ab.Data() + ta.ByteOffset(), 16);

    void* result = thread->dispatch_sync([bytes]() -> void* {
        return (void*)td_guid(bytes);
    });
    td_t* atom = (td_t*)result;
    if (!atom || TD_IS_ERR(atom)) {
        Napi::Error::New(env, "Failed to create guid atom").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeAtom::Create(env, atom, thread);
}

// ---------------------------------------------------------------------------
// Instance accessors
// ---------------------------------------------------------------------------

Napi::Value NativeAtom::GetValue(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int8_t type = td_type(atom_);

    switch (type) {
        case TD_ATOM_BOOL:      return Napi::Boolean::New(env, atom_->b8 != 0);
        case TD_ATOM_U8:        return Napi::Number::New(env, atom_->u8);
        case TD_ATOM_I16:       return Napi::Number::New(env, atom_->i16);
        case TD_ATOM_I32:       return Napi::Number::New(env, atom_->i32);
        case TD_ATOM_I64:       return Napi::BigInt::New(env, atom_->i64);
        case TD_ATOM_F64:       return Napi::Number::New(env, atom_->f64);
        case TD_ATOM_STR: {
            const char* s = td_str_ptr(atom_);
            size_t len = td_str_len(atom_);
            return Napi::String::New(env, s, len);
        }
        case TD_ATOM_SYM:       return Napi::BigInt::New(env, atom_->i64);
        case TD_ATOM_DATE:      return Napi::BigInt::New(env, atom_->i64);
        case TD_ATOM_TIME:      return Napi::BigInt::New(env, atom_->i64);
        case TD_ATOM_TIMESTAMP: return Napi::BigInt::New(env, atom_->i64);
        case TD_ATOM_GUID: {
            // GUID is stored as obj pointer to a 16-byte block
            // Return as a Uint8Array copy
            if (!atom_->obj) return env.Null();
            const uint8_t* src = (const uint8_t*)td_data(atom_->obj);
            auto buf = Napi::ArrayBuffer::New(env, 16);
            memcpy(buf.Data(), src, 16);
            return Napi::Uint8Array::New(env, 16, buf, 0);
        }
        default:
            return env.Null();
    }
}

Napi::Value NativeAtom::GetType(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), AtomTypeName(td_type(atom_)));
}
