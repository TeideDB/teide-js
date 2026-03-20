#include "graph_ops.h"
#include "table.h"
#include "rel.h"
#include "compat.h"

// Helper: execute a graph op that produces a table result
static td_t* ExecuteGraphOp(td_t* tbl, std::function<td_op_t*(td_graph_t*)> build_op) {
    td_graph_t* g = td_graph_new(tbl);
    if (!g) return nullptr;

    td_op_t* root = build_op(g);
    if (!root) { td_graph_free(g); return nullptr; }

    root = td_optimize(g, root);
    if (!root) { td_graph_free(g); return nullptr; }
    td_t* result = td_execute(g, root);
    td_graph_free(g);
    return result;
}

// ---- Expand Sync ----
// Args: nativeTable, colName, nativeRel, direction
Napi::Value GraphExpandSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "graphExpandSync requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint32_t direction_raw = info[3].As<Napi::Number>().Uint32Value();

    if (table->thread() != rel_wrap->thread()) {
        Napi::Error::New(env, "Table and Rel must belong to the same Context").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (direction_raw > 2) {
        Napi::RangeError::New(env, "direction must be 0 (fwd), 1 (rev), or 2 (both)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t direction = (uint8_t)direction_raw;

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thr->dispatch_sync([tbl, col_name, rel, direction]() -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            td_op_t* src = td_scan(g, col_name.c_str());
            if (!src) return nullptr;
            return td_expand(g, src, rel, direction);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphExpandSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- Expand Async ----
Napi::Value GraphExpand(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "graphExpand requires 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint32_t direction_raw = info[3].As<Napi::Number>().Uint32Value();

    if (table->thread() != rel_wrap->thread()) {
        Napi::Error::New(env, "Table and Rel must belong to the same Context").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (direction_raw > 2) {
        Napi::RangeError::New(env, "direction must be 0 (fwd), 1 (rev), or 2 (both)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t direction = (uint8_t)direction_raw;

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphExpand", 0, 1);

    // Prevent GC of NativeRel during async execution (no retain/release for td_rel_t)
    auto rel_ref = std::make_shared<Napi::ObjectReference>(
        Napi::Persistent(info[2].As<Napi::Object>()));

    td_retain(tbl);
    thr->dispatch_async(
        [tbl, col_name, rel, direction]() -> void* {
            void* r = (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                td_op_t* src = td_scan(g, col_name.c_str());
                if (!src) return nullptr;
                return td_expand(g, src, rel, direction);
            });
            td_release(tbl);
            return r;
        },
        tsfn,
        [deferred, thr, rel_ref](Napi::Env env, void* data) {
            rel_ref->Reset();
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                std::string msg = "graphExpand failed";
                if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}

// ---- VarExpand Sync ----
// Args: nativeTable, colName, nativeRel, direction, minDepth, maxDepth, trackPath
Napi::Value GraphVarExpandSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 7) {
        Napi::TypeError::New(env, "graphVarExpandSync requires 7 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint32_t direction_raw = info[3].As<Napi::Number>().Uint32Value();
    uint32_t min_depth_raw = info[4].As<Napi::Number>().Uint32Value();
    uint32_t max_depth_raw = info[5].As<Napi::Number>().Uint32Value();
    bool track_path = info[6].As<Napi::Boolean>().Value();

    if (table->thread() != rel_wrap->thread()) {
        Napi::Error::New(env, "Table and Rel must belong to the same Context").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (direction_raw > 2) {
        Napi::RangeError::New(env, "direction must be 0 (fwd), 1 (rev), or 2 (both)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (min_depth_raw > 255 || max_depth_raw > 255) {
        Napi::RangeError::New(env, "minDepth/maxDepth must be 0-255").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (min_depth_raw > max_depth_raw) {
        Napi::RangeError::New(env, "minDepth must be <= maxDepth").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t direction = (uint8_t)direction_raw;
    uint8_t min_depth = (uint8_t)min_depth_raw;
    uint8_t max_depth = (uint8_t)max_depth_raw;

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thr->dispatch_sync([tbl, col_name, rel, direction, min_depth, max_depth, track_path]() -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            td_op_t* src = td_scan(g, col_name.c_str());
            if (!src) return nullptr;
            return td_var_expand(g, src, rel, direction, min_depth, max_depth, track_path);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphVarExpandSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- VarExpand Async ----
Napi::Value GraphVarExpand(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 7) {
        Napi::TypeError::New(env, "graphVarExpand requires 7 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    std::string col_name = info[1].As<Napi::String>().Utf8Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[2].As<Napi::Object>());
    uint32_t direction_raw = info[3].As<Napi::Number>().Uint32Value();
    uint32_t min_depth_raw = info[4].As<Napi::Number>().Uint32Value();
    uint32_t max_depth_raw = info[5].As<Napi::Number>().Uint32Value();
    bool track_path = info[6].As<Napi::Boolean>().Value();

    if (table->thread() != rel_wrap->thread()) {
        Napi::Error::New(env, "Table and Rel must belong to the same Context").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (direction_raw > 2) {
        Napi::RangeError::New(env, "direction must be 0 (fwd), 1 (rev), or 2 (both)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (min_depth_raw > 255 || max_depth_raw > 255) {
        Napi::RangeError::New(env, "minDepth/maxDepth must be 0-255").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (min_depth_raw > max_depth_raw) {
        Napi::RangeError::New(env, "minDepth must be <= maxDepth").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t direction = (uint8_t)direction_raw;
    uint8_t min_depth = (uint8_t)min_depth_raw;
    uint8_t max_depth = (uint8_t)max_depth_raw;

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphVarExpand", 0, 1);

    // Prevent GC of NativeRel during async execution (no retain/release for td_rel_t)
    auto rel_ref = std::make_shared<Napi::ObjectReference>(
        Napi::Persistent(info[2].As<Napi::Object>()));

    td_retain(tbl);
    thr->dispatch_async(
        [tbl, col_name, rel, direction, min_depth, max_depth, track_path]() -> void* {
            void* r = (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                td_op_t* src = td_scan(g, col_name.c_str());
                if (!src) return nullptr;
                return td_var_expand(g, src, rel, direction, min_depth, max_depth, track_path);
            });
            td_release(tbl);
            return r;
        },
        tsfn,
        [deferred, thr, rel_ref](Napi::Env env, void* data) {
            rel_ref->Reset();
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                std::string msg = "graphVarExpand failed";
                if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}

// ---- ShortestPath Sync ----
// Args: nativeTable, srcNodeId, dstNodeId, nativeRel, maxDepth
Napi::Value GraphShortestPathSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) {
        Napi::TypeError::New(env, "graphShortestPathSync requires 5 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    int64_t src_id = info[1].As<Napi::Number>().Int64Value();
    int64_t dst_id = info[2].As<Napi::Number>().Int64Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[3].As<Napi::Object>());
    uint32_t max_depth_raw = info[4].As<Napi::Number>().Uint32Value();

    if (table->thread() != rel_wrap->thread()) {
        Napi::Error::New(env, "Table and Rel must belong to the same Context").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (max_depth_raw > 255) {
        Napi::RangeError::New(env, "maxDepth must be 0-255").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t max_depth = (uint8_t)max_depth_raw;

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    void* result = thr->dispatch_sync([tbl, src_id, dst_id, rel, max_depth]() -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            td_op_t* src = td_const_i64(g, src_id);
            td_op_t* dst = td_const_i64(g, dst_id);
            if (!src || !dst) return nullptr;
            return td_shortest_path(g, src, dst, rel, max_depth);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphShortestPathSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- ShortestPath Async ----
Napi::Value GraphShortestPath(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) {
        Napi::TypeError::New(env, "graphShortestPath requires 5 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    int64_t src_id = info[1].As<Napi::Number>().Int64Value();
    int64_t dst_id = info[2].As<Napi::Number>().Int64Value();
    NativeRel* rel_wrap = Napi::ObjectWrap<NativeRel>::Unwrap(info[3].As<Napi::Object>());
    uint32_t max_depth_raw = info[4].As<Napi::Number>().Uint32Value();

    if (table->thread() != rel_wrap->thread()) {
        Napi::Error::New(env, "Table and Rel must belong to the same Context").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (max_depth_raw > 255) {
        Napi::RangeError::New(env, "maxDepth must be 0-255").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t max_depth = (uint8_t)max_depth_raw;

    td_t* tbl = table->ptr();
    td_rel_t* rel = rel_wrap->ptr();
    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphShortestPath", 0, 1);

    // Prevent GC of NativeRel during async execution (no retain/release for td_rel_t)
    auto rel_ref = std::make_shared<Napi::ObjectReference>(
        Napi::Persistent(info[3].As<Napi::Object>()));

    td_retain(tbl);
    thr->dispatch_async(
        [tbl, src_id, dst_id, rel, max_depth]() -> void* {
            void* r = (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                td_op_t* src = td_const_i64(g, src_id);
                td_op_t* dst = td_const_i64(g, dst_id);
                if (!src || !dst) return nullptr;
                return td_shortest_path(g, src, dst, rel, max_depth);
            });
            td_release(tbl);
            return r;
        },
        tsfn,
        [deferred, thr, rel_ref](Napi::Env env, void* data) {
            rel_ref->Reset();
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                std::string msg = "graphShortestPath failed";
                if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}

// ---- WcoJoin Sync ----
// Args: nativeTable, nativeRelArray, nVars
Napi::Value GraphWcoJoinSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "graphWcoJoinSync requires 3 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    Napi::Array rel_arr = info[1].As<Napi::Array>();
    uint32_t n_vars_raw = info[2].As<Napi::Number>().Uint32Value();
    uint32_t n_rels_raw = rel_arr.Length();

    if (n_vars_raw == 0 || n_rels_raw == 0) {
        Napi::RangeError::New(env, "nVars and nRels must be >= 1").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (n_vars_raw > 255 || n_rels_raw > 255) {
        Napi::RangeError::New(env, "nVars and nRels must be 1-255").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t n_vars = (uint8_t)n_vars_raw;
    uint8_t n_rels = (uint8_t)n_rels_raw;

    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        Napi::Error::New(env, "Context has been shut down").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::vector<td_rel_t*> rels(n_rels);
    for (uint32_t i = 0; i < n_rels; i++) {
        NativeRel* rw = Napi::ObjectWrap<NativeRel>::Unwrap(rel_arr.Get(i).As<Napi::Object>());
        if (rw->thread() != thr) {
            Napi::Error::New(env, "All Rels must belong to the same Context as the Table").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        rels[i] = rw->ptr();
    }

    td_t* tbl = table->ptr();

    void* result = thr->dispatch_sync([tbl, rels, n_rels, n_vars]() mutable -> void* {
        return (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
            return td_wco_join(g, rels.data(), n_rels, n_vars);
        });
    });

    td_t* res = (td_t*)result;
    if (!res || TD_IS_ERR(res)) {
        std::string msg = "graphWcoJoinSync failed";
        if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return NativeTable::Create(env, res, thr);
}

// ---- WcoJoin Async ----
Napi::Value GraphWcoJoin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "graphWcoJoin requires 3 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(info[0].As<Napi::Object>());
    Napi::Array rel_arr = info[1].As<Napi::Array>();
    uint32_t n_vars_raw = info[2].As<Napi::Number>().Uint32Value();
    uint32_t n_rels_raw = rel_arr.Length();

    if (n_vars_raw == 0 || n_rels_raw == 0) {
        Napi::RangeError::New(env, "nVars and nRels must be >= 1").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (n_vars_raw > 255 || n_rels_raw > 255) {
        Napi::RangeError::New(env, "nVars and nRels must be 1-255").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint8_t n_vars = (uint8_t)n_vars_raw;
    uint8_t n_rels = (uint8_t)n_rels_raw;

    TeideThread* thr = table->thread();
    if (!thr->is_running()) {
        auto d = Napi::Promise::Deferred::New(env);
        d.Reject(Napi::Error::New(env, "Context has been shut down").Value());
        return d.Promise();
    }
    std::vector<td_rel_t*> rels(n_rels);
    for (uint32_t i = 0; i < n_rels; i++) {
        NativeRel* rw = Napi::ObjectWrap<NativeRel>::Unwrap(rel_arr.Get(i).As<Napi::Object>());
        if (rw->thread() != thr) {
            Napi::Error::New(env, "All Rels must belong to the same Context as the Table").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        rels[i] = rw->ptr();
    }

    td_t* tbl = table->ptr();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(), "graphWcoJoin", 0, 1);

    // Prevent GC of NativeRel objects during async execution
    auto rels_ref = std::make_shared<std::vector<Napi::ObjectReference>>();
    rels_ref->reserve(n_rels);
    for (uint32_t i = 0; i < n_rels; i++) {
        rels_ref->push_back(Napi::Persistent(rel_arr.Get(i).As<Napi::Object>()));
    }

    td_retain(tbl);
    thr->dispatch_async(
        [tbl, rels, n_rels, n_vars]() mutable -> void* {
            void* r = (void*)ExecuteGraphOp(tbl, [&](td_graph_t* g) -> td_op_t* {
                return td_wco_join(g, rels.data(), n_rels, n_vars);
            });
            td_release(tbl);
            return r;
        },
        tsfn,
        [deferred, thr, rels_ref](Napi::Env env, void* data) {
            for (auto& ref : *rels_ref) ref.Reset();
            td_t* res = (td_t*)data;
            if (!res || TD_IS_ERR(res)) {
                std::string msg = "graphWcoJoin failed";
                if (res && TD_IS_ERR(res)) msg += std::string(": ") + td_err_str(TD_ERR_CODE(res));
                deferred.Reject(Napi::Error::New(env, msg).Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thr));
            }
        }
    );
    return deferred.Promise();
}
