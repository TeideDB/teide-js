// series.h MUST come first -- it pulls in teide_thread.h which brings
// <napi.h>, <atomic>, and other C++ headers before the C-atomic shim.
#include "series.h"
#include "compat.h"

#include <cstring>

Napi::FunctionReference NativeSeries::constructor_;

Napi::Object NativeSeries::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "NativeSeries", {
        InstanceAccessor("dtype", &NativeSeries::GetDtype, nullptr),
        InstanceAccessor("length", &NativeSeries::GetLength, nullptr),
        InstanceAccessor("name", &NativeSeries::GetName, nullptr),
        InstanceAccessor("data", &NativeSeries::GetData, nullptr),
        InstanceAccessor("nullBitmap", &NativeSeries::GetNullBitmap, nullptr),
        InstanceAccessor("indices", &NativeSeries::GetIndices, nullptr),
        InstanceAccessor("dictionary", &NativeSeries::GetDictionary, nullptr),
    });

    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();

    exports.Set("NativeSeries", func);
    return exports;
}

Napi::Object NativeSeries::Create(Napi::Env env, td_t* vec,
                                   const std::string& name, int8_t dtype,
                                   TeideThread* thread) {
    Napi::Object obj = constructor_.New({
        Napi::External<td_t>::New(env, vec),
        Napi::String::New(env, name),
        Napi::Number::New(env, dtype),
        Napi::External<TeideThread>::New(env, thread),
    });
    return obj;
}

NativeSeries::NativeSeries(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeSeries>(info),
      vec_(nullptr), dtype_(0), thread_(nullptr) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "NativeSeries: internal constructor requires 4 arguments")
            .ThrowAsJavaScriptException();
        return;
    }

    vec_ = info[0].As<Napi::External<td_t>>().Data();
    name_ = info[1].As<Napi::String>().Utf8Value();
    dtype_ = (int8_t)info[2].As<Napi::Number>().Int32Value();
    thread_ = info[3].As<Napi::External<TeideThread>>().Data();
    heap_alive_ = thread_->heap_alive();

    // Retain the vector for the lifetime of this wrapper
    td_retain(vec_);
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

Napi::Value NativeSeries::GetDtype(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), dtype_);
}

Napi::Value NativeSeries::GetLength(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), (double)vec_->len);
}

Napi::Value NativeSeries::GetName(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), name_);
}

// ---------------------------------------------------------------------------
// Zero-copy data access
// ---------------------------------------------------------------------------

Napi::Value NativeSeries::GetData(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Return cached value if available
    if (!cached_data_.IsEmpty()) {
        return cached_data_.Value();
    }

    // Symbol columns expose indices/dictionary, not raw data
    if (dtype_ == TD_SYM) {
        Napi::TypeError::New(env, "Symbol columns: use .indices and .dictionary instead of .data")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t length = vec_->len;
    void* data_ptr = ResolveDataPtr(vec_, dtype_);

    napi_typedarray_type arr_type;
    size_t elem_size;

    switch (dtype_) {
        case TD_F64:
            arr_type = napi_float64_array;
            elem_size = 8;
            break;
        case TD_I64:
        case TD_TIMESTAMP:
            arr_type = napi_bigint64_array;
            elem_size = 8;
            break;
        case TD_I32:
        case TD_DATE:
            arr_type = napi_int32_array;
            elem_size = 4;
            break;
        case TD_I16:
            arr_type = napi_int16_array;
            elem_size = 2;
            break;
        case TD_BOOL:
        case TD_U8:
            arr_type = napi_uint8_array;
            elem_size = 1;
            break;
        default:
            Napi::TypeError::New(env, "Unsupported dtype for zero-copy data access")
                .ThrowAsJavaScriptException();
            return env.Undefined();
    }

    Napi::Value result = CreateZeroCopyArray(env, data_ptr, length,
                                              elem_size, arr_type);
    cached_data_ = Napi::Persistent(result);
    return result;
}

Napi::Value NativeSeries::GetNullBitmap(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    uint8_t attrs = vec_->attrs;
    if (!(attrs & TD_ATTR_HAS_NULLS)) {
        return env.Null();
    }

    // Null bitmap is stored in the first 16 bytes of the header (inline)
    // or in an external nullmap when TD_ATTR_NULLMAP_EXT is set.
    if (attrs & TD_ATTR_NULLMAP_EXT) {
        td_t* ext = vec_->ext_nullmap;
        if (!ext) return env.Null();
        // External nullmap is a vector of bytes; expose as zero-copy Uint8Array
        int64_t nbytes = (vec_->len + 7) / 8;
        return CreateZeroCopyArray(env, td_data(ext), nbytes, 1, napi_uint8_array);
    }

    // Inline nullmap: 16 bytes in the header -- copy to avoid aliasing issues
    // since the header bytes overlap with slice_parent/slice_offset.
    // For non-slice vectors with inline nulls (<=128 rows), copy the 16 bytes.
    size_t nbytes = (size_t)((vec_->len + 7) / 8);
    if (nbytes > 16) nbytes = 16;
    auto ab = Napi::ArrayBuffer::New(env, nbytes);
    memcpy(ab.Data(), vec_->nullmap, nbytes);
    return Napi::Uint8Array::New(env, nbytes, ab, 0);
}

// ---------------------------------------------------------------------------
// Symbol column accessors
// ---------------------------------------------------------------------------

Napi::Value NativeSeries::GetIndices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (dtype_ != TD_SYM) {
        Napi::TypeError::New(env, ".indices is only available on symbol columns")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int64_t length = vec_->len;
    void* data_ptr = ResolveDataPtr(vec_, dtype_);

    uint8_t width = vec_->attrs & TD_SYM_W_MASK;
    napi_typedarray_type arr_type;
    size_t elem_size;

    switch (width) {
        case TD_SYM_W8:
            arr_type = napi_uint8_array;
            elem_size = 1;
            break;
        case TD_SYM_W16:
            arr_type = napi_uint16_array;
            elem_size = 2;
            break;
        case TD_SYM_W32:
            arr_type = napi_uint32_array;
            elem_size = 4;
            break;
        default:
            Napi::TypeError::New(env, "Unsupported symbol width")
                .ThrowAsJavaScriptException();
            return env.Undefined();
    }

    return CreateZeroCopyArray(env, data_ptr, length, elem_size, arr_type);
}

Napi::Value NativeSeries::GetDictionary(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (dtype_ != TD_SYM) {
        Napi::TypeError::New(env, ".dictionary is only available on symbol columns")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t count = td_sym_count();
    Napi::Array arr = Napi::Array::New(env, count);
    for (uint32_t i = 0; i < count; i++) {
        td_t* s = td_sym_str((int64_t)i);
        if (s) {
            arr.Set(i, Napi::String::New(env, td_str_ptr(s), td_str_len(s)));
        } else {
            arr.Set(i, Napi::String::New(env, ""));
        }
    }
    return arr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct BufRef {
    td_t* vec;
    std::shared_ptr<std::atomic<bool>> heap_alive;
};

Napi::Value NativeSeries::CreateZeroCopyArray(
    Napi::Env env, void* data, int64_t length,
    size_t elem_size, napi_typedarray_type arr_type) {

    td_retain(vec_);
    auto ref = new BufRef{vec_, heap_alive_};

    // Create external ArrayBuffer pointing directly at C data.
    // The release callback calls td_release when GC collects the buffer,
    // but only if the heap is still alive (not torn down by shutdown).
    napi_value ab_val;
    napi_status status = napi_create_external_arraybuffer(
        env, data, (size_t)(length * elem_size),
        [](napi_env /*env*/, void* /*data*/, void* hint) {
            auto r = (BufRef*)hint;
            if (r->heap_alive->load()) td_release(r->vec);
            delete r;
        },
        (void*)ref,
        &ab_val
    );
    if (status != napi_ok) {
        td_release(ref->vec);
        delete ref;
        Napi::Error::New(env, "Failed to create external ArrayBuffer")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Wrap as the appropriate TypedArray
    napi_value typed_arr;
    status = napi_create_typedarray(env, arr_type, (size_t)length, ab_val, 0, &typed_arr);
    if (status != napi_ok) {
        Napi::Error::New(env, "Failed to create TypedArray")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return Napi::Value(env, typed_arr);
}

void* NativeSeries::ResolveDataPtr(td_t* vec, int8_t dtype) {
    uint8_t attrs = vec->attrs;
    if (attrs & TD_ATTR_SLICE) {
        td_t* parent = vec->slice_parent;
        int64_t offset = vec->slice_offset;
        size_t esz = td_sym_elem_size(dtype, attrs);
        return (uint8_t*)td_data(parent) + offset * esz;
    }
    return td_data(vec);
}
