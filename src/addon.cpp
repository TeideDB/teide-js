// context.h pulls in teide_thread.h -> <napi.h> and C++ headers.
// series.h and table.h also pull in teide_thread.h -> <napi.h>.
// query.h also pulls in teide_thread.h -> <napi.h>.
// compat.h with its C-atomic shim must come after all C++ headers.
#include "context.h"
#include "series.h"
#include "table.h"
#include "query.h"
#include "rel.h"
#include "graph_ops.h"
#include "compat.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    NativeContext::Init(env, exports);
    NativeSeries::Init(env, exports);
    NativeTable::Init(env, exports);
    NativeRel::Init(env, exports);
    exports.Set("collectSync", Napi::Function::New(env, QueryCollectSync));
    exports.Set("collect", Napi::Function::New(env, QueryCollect));
    exports.Set("graphExpandSync", Napi::Function::New(env, GraphExpandSync));
    exports.Set("graphExpand", Napi::Function::New(env, GraphExpand));
    exports.Set("graphVarExpandSync", Napi::Function::New(env, GraphVarExpandSync));
    exports.Set("graphVarExpand", Napi::Function::New(env, GraphVarExpand));
    exports.Set("graphShortestPathSync", Napi::Function::New(env, GraphShortestPathSync));
    exports.Set("graphShortestPath", Napi::Function::New(env, GraphShortestPath));
    exports.Set("graphWcoJoinSync", Napi::Function::New(env, GraphWcoJoinSync));
    exports.Set("graphWcoJoin", Napi::Function::New(env, GraphWcoJoin));
    exports.Set("tableFromArraysSync", Napi::Function::New(env, TableFromArraysSync));
    return exports;
}

NODE_API_MODULE(teidedb_addon, Init)
