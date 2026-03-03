// vector.h MUST come first -- it pulls in teide_thread.h which brings
// <napi.h>, <atomic>, and other C++ headers before the C-atomic shim.
#include "vector.h"
#include "context.h"
#include "compat.h"

#include <cstring>

Napi::FunctionReference NativeVector::constructor_;

// ---------------------------------------------------------------------------
// Type string <-> int8_t conversion helpers
// ---------------------------------------------------------------------------

static int8_t ParseType(const std::string& s) {
    if (s == "f64")       return TD_F64;
    if (s == "i64")       return TD_I64;
    if (s == "i32")       return TD_I32;
    if (s == "i16")       return TD_I16;
    if (s == "u8")        return TD_U8;
    if (s == "bool")      return TD_BOOL;
    if (s == "date")      return TD_DATE;
    if (s == "time")      return TD_TIME;
    if (s == "timestamp") return TD_TIMESTAMP;
    if (s == "guid")      return TD_GUID;
    if (s == "sym")       return TD_SYM;
    return -128; // invalid
}

static const char* TypeName(int8_t t) {
    switch (t) {
        case TD_F64:       return "f64";
        case TD_I64:       return "i64";
        case TD_I32:       return "i32";
        case TD_I16:       return "i16";
        case TD_U8:        return "u8";
        case TD_BOOL:      return "bool";
        case TD_DATE:      return "date";
        case TD_TIME:      return "time";
        case TD_TIMESTAMP: return "timestamp";
        case TD_GUID:      return "guid";
        case TD_SYM:       return "sym";
        default:           return "unknown";
    }
}

// ---------------------------------------------------------------------------
// Init / Create / Constructor / Destructor
// ---------------------------------------------------------------------------

Napi::Object NativeVector::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeVector", {
        StaticMethod("newSync", &NativeVector::NewSync),
        StaticMethod("fromRawSync", &NativeVector::FromRawSync),
        InstanceMethod("append", &NativeVector::Append),
        InstanceMethod("set", &NativeVector::Set),
        InstanceMethod("get", &NativeVector::Get),
        InstanceMethod("slice", &NativeVector::Slice),
        InstanceMethod("concat", &NativeVector::Concat),
        InstanceMethod("setNull", &NativeVector::SetNull),
        InstanceMethod("isNull", &NativeVector::IsNull),
        InstanceAccessor("length", &NativeVector::GetLength, nullptr),
        InstanceAccessor("type", &NativeVector::GetType, nullptr),
    });

    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();

    exports.Set("NativeVector", func);
    return exports;
}

Napi::Object NativeVector::Create(Napi::Env env, td_t* vec, TeideThread* thread) {
    Napi::Object obj = constructor_.New({
        Napi::External<td_t>::New(env, vec),
        Napi::External<TeideThread>::New(env, thread),
    });
    return obj;
}

NativeVector::NativeVector(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeVector>(info), vec_(nullptr), thread_(nullptr) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "NativeVector: internal constructor requires 2 arguments")
            .ThrowAsJavaScriptException();
        return;
    }

    vec_ = info[0].As<Napi::External<td_t>>().Data();
    thread_ = info[1].As<Napi::External<TeideThread>>().Data();
    heap_alive_ = thread_->heap_alive();

    if (vec_) td_retain(vec_);
}

NativeVector::~NativeVector() {
    if (vec_ && heap_alive_ && heap_alive_->load()) td_release(vec_);
}

// ---------------------------------------------------------------------------
// Static factories
// ---------------------------------------------------------------------------

Napi::Value NativeVector::NewSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsString() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "NativeVector.newSync(ctx, type, capacity)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    std::string type_str = info[1].As<Napi::String>().Utf8Value();
    int64_t capacity = (int64_t)info[2].As<Napi::Number>().Int64Value();
    if (capacity < 0) {
        Napi::RangeError::New(env, "Capacity must be non-negative").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int8_t type = ParseType(type_str);
    if (type == -128) {
        Napi::TypeError::New(env, "Unknown type: " + type_str).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thread->dispatch_sync([type, capacity]() -> void* {
        td_t* vec = td_vec_new(type, capacity);
        return (void*)vec;
    });

    td_t* vec = (td_t*)result;
    if (!vec || TD_IS_ERR(vec)) {
        Napi::Error::New(env, "Failed to create vector").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeVector::Create(env, vec, thread);
}

Napi::Value NativeVector::FromRawSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsString() || !info[2].IsTypedArray()) {
        Napi::TypeError::New(env, "NativeVector.fromRawSync(ctx, type, typedArray)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeContext* ctx = Napi::ObjectWrap<NativeContext>::Unwrap(info[0].As<Napi::Object>());
    TeideThread* thread = &ctx->thread();
    std::string type_str = info[1].As<Napi::String>().Utf8Value();
    Napi::TypedArray ta = info[2].As<Napi::TypedArray>();

    int8_t type = ParseType(type_str);
    if (type == -128) {
        Napi::TypeError::New(env, "Unknown type: " + type_str).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Copy data from the TypedArray into a std::vector for safe transfer to Teide thread
    size_t byte_len = ta.ByteLength();
    size_t esz = td_elem_size(type);
    if (esz == 0) {
        Napi::TypeError::New(env, "Type has zero element size").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (byte_len % esz != 0) {
        Napi::TypeError::New(env, "TypedArray byte length is not a multiple of target type element size")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int64_t count = (int64_t)(byte_len / esz);
    std::vector<uint8_t> buf(byte_len);
    Napi::ArrayBuffer ab = ta.ArrayBuffer();
    memcpy(buf.data(), (uint8_t*)ab.Data() + ta.ByteOffset(), byte_len);

    void* result = thread->dispatch_sync([type, count, buf = std::move(buf)]() -> void* {
        td_t* vec = td_vec_from_raw(type, buf.data(), count);
        return (void*)vec;
    });

    td_t* vec = (td_t*)result;
    if (!vec || TD_IS_ERR(vec)) {
        Napi::Error::New(env, "Failed to create vector from raw data").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeVector::Create(env, vec, thread);
}

// ---------------------------------------------------------------------------
// Instance methods
// ---------------------------------------------------------------------------

Napi::Value NativeVector::Append(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1) {
        Napi::TypeError::New(env, "append(value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int8_t type = td_type(vec_);

    // Serialize the value into a buffer on V8 thread
    union { double f64; int64_t i64; int32_t i32; int16_t i16; uint8_t u8; } val;
    const void* elem = &val;

    switch (type) {
        case TD_F64:
            val.f64 = info[0].As<Napi::Number>().DoubleValue();
            break;
        case TD_I64:
        case TD_TIMESTAMP:
            val.i64 = info[0].As<Napi::Number>().Int64Value();
            break;
        case TD_DATE:
        case TD_TIME:
            val.i32 = info[0].As<Napi::Number>().Int32Value();
            break;
        case TD_I32:
            val.i32 = info[0].As<Napi::Number>().Int32Value();
            break;
        case TD_I16:
            val.i16 = (int16_t)info[0].As<Napi::Number>().Int32Value();
            break;
        case TD_U8:
            val.u8 = (uint8_t)info[0].As<Napi::Number>().Uint32Value();
            break;
        case TD_BOOL:
            if (info[0].IsBoolean())
                val.u8 = info[0].As<Napi::Boolean>().Value() ? 1 : 0;
            else
                val.u8 = (uint8_t)info[0].As<Napi::Number>().Uint32Value();
            break;
        default:
            Napi::TypeError::New(env, "Unsupported type for append").ThrowAsJavaScriptException();
            return env.Undefined();
    }

    // Copy elem data for safe transfer
    uint8_t elem_buf[8];
    size_t esz = td_elem_size(type);
    memcpy(elem_buf, elem, esz);

    td_t* old_vec = vec_;
    void* result = thread_->dispatch_sync([old_vec, elem_buf]() -> void* {
        return (void*)td_vec_append(old_vec, elem_buf);
    });

    td_t* new_vec = (td_t*)result;
    if (!new_vec || TD_IS_ERR(new_vec)) {
        Napi::Error::New(env, "Failed to append to vector").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Return a new NativeVector wrapping the result
    return NativeVector::Create(env, new_vec, thread_);
}

Napi::Value NativeVector::Set(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "set(index, value)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t idx = info[0].As<Napi::Number>().Int64Value();
    int8_t type = td_type(vec_);

    union { double f64; int64_t i64; int32_t i32; int16_t i16; uint8_t u8; } val;
    switch (type) {
        case TD_F64:       val.f64 = info[1].As<Napi::Number>().DoubleValue(); break;
        case TD_I64:
        case TD_TIMESTAMP: val.i64 = info[1].As<Napi::Number>().Int64Value(); break;
        case TD_DATE:
        case TD_TIME:      val.i32 = info[1].As<Napi::Number>().Int32Value(); break;
        case TD_I32:       val.i32 = info[1].As<Napi::Number>().Int32Value(); break;
        case TD_I16:       val.i16 = (int16_t)info[1].As<Napi::Number>().Int32Value(); break;
        case TD_U8:        val.u8 = (uint8_t)info[1].As<Napi::Number>().Uint32Value(); break;
        case TD_BOOL:
            if (info[1].IsBoolean())
                val.u8 = info[1].As<Napi::Boolean>().Value() ? 1 : 0;
            else
                val.u8 = (uint8_t)info[1].As<Napi::Number>().Uint32Value();
            break;
        default:
            Napi::TypeError::New(env, "Unsupported type for set").ThrowAsJavaScriptException();
            return env.Undefined();
    }

    uint8_t elem_buf[8];
    size_t esz = td_elem_size(type);
    memcpy(elem_buf, &val, esz);

    td_t* vec = vec_;
    void* result = thread_->dispatch_sync([vec, idx, elem_buf]() -> void* {
        return (void*)td_vec_set(vec, idx, elem_buf);
    });

    td_t* new_vec = (td_t*)result;
    if (!new_vec || TD_IS_ERR(new_vec)) {
        Napi::Error::New(env, "Failed to set vector element").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    // td_vec_set may return the same or a new pointer (COW). Update internal pointer.
    // Since we retain on construction, we need to handle the swap carefully.
    if (new_vec && new_vec != vec_) {
        td_retain(new_vec);
        if (heap_alive_ && heap_alive_->load()) td_release(vec_);
        vec_ = new_vec;
    }
    return env.Undefined();
}

Napi::Value NativeVector::Get(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "get(index)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t idx = info[0].As<Napi::Number>().Int64Value();

    if (idx < 0 || idx >= td_len(vec_)) {
        Napi::RangeError::New(env, "Index out of range").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Check null
    if (td_vec_is_null(vec_, idx)) {
        return env.Null();
    }

    int8_t type = td_type(vec_);
    void* elem = td_vec_get(vec_, idx);
    if (!elem) return env.Null();

    switch (type) {
        case TD_F64:       return Napi::Number::New(env, *(double*)elem);
        case TD_I64:
        case TD_TIMESTAMP: return Napi::BigInt::New(env, *(int64_t*)elem);
        case TD_DATE:
        case TD_TIME:      return Napi::Number::New(env, *(int32_t*)elem);
        case TD_I32:       return Napi::Number::New(env, *(int32_t*)elem);
        case TD_I16:       return Napi::Number::New(env, *(int16_t*)elem);
        case TD_U8:        return Napi::Number::New(env, *(uint8_t*)elem);
        case TD_BOOL:      return Napi::Boolean::New(env, *(uint8_t*)elem != 0);
        default:
            return env.Null();
    }
}

Napi::Value NativeVector::Slice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "slice(offset, length)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t offset = info[0].As<Napi::Number>().Int64Value();
    int64_t len = info[1].As<Napi::Number>().Int64Value();

    td_t* vec = vec_;
    void* result = thread_->dispatch_sync([vec, offset, len]() -> void* {
        return (void*)td_vec_slice(vec, offset, len);
    });

    td_t* sliced = (td_t*)result;
    if (!sliced || TD_IS_ERR(sliced)) {
        Napi::Error::New(env, "Failed to slice vector").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeVector::Create(env, sliced, thread_);
}

Napi::Value NativeVector::Concat(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "concat(otherVector)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeVector* other = Napi::ObjectWrap<NativeVector>::Unwrap(info[0].As<Napi::Object>());
    td_t* a = vec_;
    td_t* b = other->vec_;

    void* result = thread_->dispatch_sync([a, b]() -> void* {
        return (void*)td_vec_concat(a, b);
    });

    td_t* merged = (td_t*)result;
    if (!merged || TD_IS_ERR(merged)) {
        Napi::Error::New(env, "Failed to concat vectors").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeVector::Create(env, merged, thread_);
}

void NativeVector::SetNull(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "setNull(index, isNull)").ThrowAsJavaScriptException();
        return;
    }

    int64_t idx = info[0].As<Napi::Number>().Int64Value();
    bool is_null = info[1].As<Napi::Boolean>().Value();

    if (idx < 0 || idx >= td_len(vec_)) {
        Napi::RangeError::New(env, "Index out of bounds").ThrowAsJavaScriptException();
        return;
    }

    td_t* vec = vec_;
    thread_->dispatch_sync([vec, idx, is_null]() -> void* {
        td_vec_set_null(vec, idx, is_null);
        return nullptr;
    });
}

Napi::Value NativeVector::IsNull(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "isNull(index)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t idx = info[0].As<Napi::Number>().Int64Value();
    if (idx < 0 || idx >= td_len(vec_)) {
        Napi::RangeError::New(env, "Index out of bounds").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Boolean::New(env, td_vec_is_null(vec_, idx));
}

Napi::Value NativeVector::GetLength(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), (double)td_len(vec_));
}

Napi::Value NativeVector::GetType(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), TypeName(td_type(vec_)));
}
