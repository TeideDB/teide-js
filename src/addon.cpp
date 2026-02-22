// context.h pulls in teide_thread.h -> <napi.h> and C++ headers.
// series.h and table.h also pull in teide_thread.h -> <napi.h>.
// query.h also pulls in teide_thread.h -> <napi.h>.
// compat.h with its C-atomic shim must come after all C++ headers.
#include "context.h"
#include "series.h"
#include "table.h"
#include "query.h"
#include "compat.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    NativeContext::Init(env, exports);
    NativeSeries::Init(env, exports);
    NativeTable::Init(env, exports);
    exports.Set("collectSync", Napi::Function::New(env, QueryCollectSync));
    exports.Set("collect", Napi::Function::New(env, QueryCollect));
    return exports;
}

NODE_API_MODULE(teidedb_addon, Init)
