// query.h MUST come first -- it pulls in teide_thread.h which brings
// <napi.h>, <atomic>, and other C++ headers before the C-atomic shim.
#include "query.h"
#include "table.h"
#include "compat.h"

#include <stdexcept>

// ---------------------------------------------------------------------------
// Serialization: JS Expr objects -> C++ ExprNode trees (runs on V8 thread)
// ---------------------------------------------------------------------------

std::shared_ptr<ExprNode> SerializeExpr(Napi::Object expr) {
    auto node = std::make_shared<ExprNode>();

    // Read the kind field
    node->kind = expr.Get("kind").As<Napi::String>().Utf8Value();

    // Read the params object
    Napi::Object params = expr.Get("params").As<Napi::Object>();

    if (node->kind == "col") {
        node->str_val = params.Get("name").As<Napi::String>().Utf8Value();
    }
    else if (node->kind == "lit") {
        Napi::Value val = params.Get("value");
        if (val.IsNumber()) {
            node->lit_type = LIT_NUM;
            node->num_val = val.As<Napi::Number>().DoubleValue();
        } else if (val.IsBoolean()) {
            node->lit_type = LIT_BOOL;
            node->bool_val = val.As<Napi::Boolean>().Value();
        } else if (val.IsString()) {
            node->lit_type = LIT_STR;
            node->str_val = val.As<Napi::String>().Utf8Value();
        }
    }
    else if (node->kind == "binop") {
        node->str_val = params.Get("op").As<Napi::String>().Utf8Value();
        node->left = SerializeExpr(params.Get("left").As<Napi::Object>());
        node->right = SerializeExpr(params.Get("right").As<Napi::Object>());
    }
    else if (node->kind == "unop") {
        node->str_val = params.Get("op").As<Napi::String>().Utf8Value();
        node->left = SerializeExpr(params.Get("arg").As<Napi::Object>());
    }
    else if (node->kind == "agg") {
        node->agg_opcode = params.Get("op").As<Napi::Number>().Int32Value();
        node->left = SerializeExpr(params.Get("arg").As<Napi::Object>());
    }
    else if (node->kind == "alias") {
        node->str_val = params.Get("name").As<Napi::String>().Utf8Value();
        node->left = SerializeExpr(params.Get("arg").As<Napi::Object>());
    }
    else if (node->kind == "naryop") {
        node->str_val = params.Get("op").As<Napi::String>().Utf8Value();
        Napi::Array args_arr = params.Get("args").As<Napi::Array>();
        uint32_t n = args_arr.Length();
        node->args.reserve(n);
        for (uint32_t i = 0; i < n; i++) {
            node->args.push_back(SerializeExpr(args_arr.Get(i).As<Napi::Object>()));
        }
    }
    else if (node->kind == "cast") {
        node->left = SerializeExpr(params.Get("arg").As<Napi::Object>());
        std::string type_str = params.Get("targetType").As<Napi::String>().Utf8Value();
        if (type_str == "bool")           node->target_type = TD_BOOL;
        else if (type_str == "u8")        node->target_type = TD_U8;
        else if (type_str == "i16")       node->target_type = TD_I16;
        else if (type_str == "i32")       node->target_type = TD_I32;
        else if (type_str == "i64")       node->target_type = TD_I64;
        else if (type_str == "f64")       node->target_type = TD_F64;
        else if (type_str == "sym")       node->target_type = TD_SYM;
        else if (type_str == "date")      node->target_type = TD_DATE;
        else if (type_str == "time")      node->target_type = TD_TIME;
        else if (type_str == "timestamp") node->target_type = TD_TIMESTAMP;
    }
    else if (node->kind == "dateop") {
        node->str_val = params.Get("op").As<Napi::String>().Utf8Value();
        node->left = SerializeExpr(params.Get("arg").As<Napi::Object>());
        std::string field = params.Get("field").As<Napi::String>().Utf8Value();
        if (field == "year")        node->date_field = TD_EXTRACT_YEAR;
        else if (field == "month")  node->date_field = TD_EXTRACT_MONTH;
        else if (field == "day")    node->date_field = TD_EXTRACT_DAY;
        else if (field == "hour")   node->date_field = TD_EXTRACT_HOUR;
        else if (field == "minute") node->date_field = TD_EXTRACT_MINUTE;
        else if (field == "second") node->date_field = TD_EXTRACT_SECOND;
        else if (field == "dow")    node->date_field = TD_EXTRACT_DOW;
        else if (field == "doy")    node->date_field = TD_EXTRACT_DOY;
        else if (field == "epoch")  node->date_field = TD_EXTRACT_EPOCH;
    }

    return node;
}

std::vector<PlanStep> SerializePlan(Napi::Array ops) {
    std::vector<PlanStep> plan;
    uint32_t len = ops.Length();
    plan.reserve(len);

    for (uint32_t i = 0; i < len; i++) {
        Napi::Object op = ops.Get(i).As<Napi::Object>();
        PlanStep step;
        step.type = op.Get("type").As<Napi::String>().Utf8Value();

        if (step.type == "filter") {
            step.filter_expr = SerializeExpr(op.Get("expr").As<Napi::Object>());
        }
        else if (step.type == "group") {
            // keys: string[]
            Napi::Array keys = op.Get("keys").As<Napi::Array>();
            for (uint32_t k = 0; k < keys.Length(); k++) {
                step.group_keys.push_back(
                    keys.Get(k).As<Napi::String>().Utf8Value());
            }
            // aggs: Expr[]
            Napi::Array aggs = op.Get("aggs").As<Napi::Array>();
            for (uint32_t a = 0; a < aggs.Length(); a++) {
                step.agg_exprs.push_back(
                    SerializeExpr(aggs.Get(a).As<Napi::Object>()));
            }
        }
        else if (step.type == "sort") {
            // cols: string[]
            Napi::Array cols = op.Get("cols").As<Napi::Array>();
            for (uint32_t c = 0; c < cols.Length(); c++) {
                step.sort_cols.push_back(
                    cols.Get(c).As<Napi::String>().Utf8Value());
            }
            // descs: boolean[]
            Napi::Array descs = op.Get("descs").As<Napi::Array>();
            for (uint32_t d = 0; d < descs.Length(); d++) {
                step.sort_descs.push_back(
                    descs.Get(d).As<Napi::Boolean>().Value());
            }
        }
        else if (step.type == "head") {
            step.head_n = (int64_t)op.Get("n").As<Napi::Number>().Int64Value();
        }
        else if (step.type == "tail") {
            step.tail_n = (int64_t)op.Get("n").As<Napi::Number>().Int64Value();
        }
        else if (step.type == "distinct") {
            Napi::Array cols = op.Get("cols").As<Napi::Array>();
            for (uint32_t c = 0; c < cols.Length(); c++) {
                step.distinct_cols.push_back(
                    cols.Get(c).As<Napi::String>().Utf8Value());
            }
        }
        else if (step.type == "select") {
            Napi::Array cols = op.Get("cols").As<Napi::Array>();
            for (uint32_t c = 0; c < cols.Length(); c++) {
                step.select_cols.push_back(
                    cols.Get(c).As<Napi::String>().Utf8Value());
            }
        }
        else if (step.type == "project") {
            Napi::Array exprs = op.Get("exprs").As<Napi::Array>();
            for (uint32_t e = 0; e < exprs.Length(); e++) {
                step.project_exprs.push_back(
                    SerializeExpr(exprs.Get(e).As<Napi::Object>()));
            }
        }
        else if (step.type == "join") {
            NativeTable* right = Napi::ObjectWrap<NativeTable>::Unwrap(
                op.Get("rightTable").As<Napi::Object>());
            step.join_right_table = right->ptr();
            td_retain(step.join_right_table);

            Napi::Array lkeys = op.Get("leftKeys").As<Napi::Array>();
            for (uint32_t k = 0; k < lkeys.Length(); k++) {
                step.join_left_keys.push_back(
                    lkeys.Get(k).As<Napi::String>().Utf8Value());
            }
            Napi::Array rkeys = op.Get("rightKeys").As<Napi::Array>();
            for (uint32_t k = 0; k < rkeys.Length(); k++) {
                step.join_right_keys.push_back(
                    rkeys.Get(k).As<Napi::String>().Utf8Value());
            }
            step.join_type = (uint8_t)op.Get("joinType").As<Napi::Number>().Uint32Value();
        }

        plan.push_back(std::move(step));
    }

    return plan;
}

// ---------------------------------------------------------------------------
// Graph emission: C++ ExprNode trees -> td_op_t* graph nodes (Teide thread)
// ---------------------------------------------------------------------------

td_op_t* EmitExpr(td_graph_t* g, const std::shared_ptr<ExprNode>& node) {
    if (!node) return nullptr;

    if (node->kind == "col") {
        return td_scan(g, node->str_val.c_str());
    }
    else if (node->kind == "lit") {
        switch (node->lit_type) {
            case LIT_BOOL:
                return td_const_bool(g, node->bool_val);
            case LIT_STR:
                return td_const_str(g, node->str_val.c_str());
            case LIT_NUM:
            default: {
                // Check if the number is an integer (no fractional part)
                double v = node->num_val;
                if (v == (double)(int64_t)v && v >= -9.22e18 && v <= 9.22e18) {
                    return td_const_i64(g, (int64_t)v);
                }
                return td_const_f64(g, v);
            }
        }
    }
    else if (node->kind == "binop") {
        td_op_t* left = EmitExpr(g, node->left);
        td_op_t* right = EmitExpr(g, node->right);

        const std::string& op = node->str_val;
        if (op == "add") return td_add(g, left, right);
        if (op == "sub") return td_sub(g, left, right);
        if (op == "mul") return td_mul(g, left, right);
        if (op == "div") return td_div(g, left, right);
        if (op == "mod") return td_mod(g, left, right);
        if (op == "eq")  return td_eq(g, left, right);
        if (op == "ne")  return td_ne(g, left, right);
        if (op == "lt")  return td_lt(g, left, right);
        if (op == "le")  return td_le(g, left, right);
        if (op == "gt")  return td_gt(g, left, right);
        if (op == "ge")  return td_ge(g, left, right);
        if (op == "and") return td_and(g, left, right);
        if (op == "or")  return td_or(g, left, right);
        if (op == "like")  return td_like(g, left, right);
        if (op == "ilike") return td_ilike(g, left, right);
        if (op == "min2")  return td_min2(g, left, right);
        if (op == "max2")  return td_max2(g, left, right);
        return nullptr;
    }
    else if (node->kind == "unop") {
        td_op_t* arg = EmitExpr(g, node->left);

        const std::string& op = node->str_val;
        if (op == "neg")    return td_neg(g, arg);
        if (op == "abs")    return td_abs(g, arg);
        if (op == "not")    return td_not(g, arg);
        if (op == "sqrt")   return td_sqrt_op(g, arg);
        if (op == "log")    return td_log_op(g, arg);
        if (op == "exp")    return td_exp_op(g, arg);
        if (op == "ceil")   return td_ceil_op(g, arg);
        if (op == "floor")  return td_floor_op(g, arg);
        if (op == "isnull") return td_isnull(g, arg);
        if (op == "upper")  return td_upper(g, arg);
        if (op == "lower")  return td_lower(g, arg);
        if (op == "strlen") return td_strlen(g, arg);
        if (op == "trim")   return td_trim_op(g, arg);
        return nullptr;
    }
    else if (node->kind == "agg") {
        td_op_t* arg = EmitExpr(g, node->left);

        switch (node->agg_opcode) {
            case OP_SUM:   return td_sum(g, arg);
            case OP_PROD:  return td_prod(g, arg);
            case OP_MIN:   return td_min_op(g, arg);
            case OP_MAX:   return td_max_op(g, arg);
            case OP_COUNT: return td_count(g, arg);
            case OP_AVG:   return td_avg(g, arg);
            case OP_FIRST: return td_first(g, arg);
            case OP_LAST:  return td_last(g, arg);
            case OP_COUNT_DISTINCT: return td_count_distinct(g, arg);
            // OP_STDDEV (59), OP_STDDEV_POP (73), OP_VAR (74), OP_VAR_POP (75)
            // Opcodes defined in td.h but no dedicated builder functions yet.
            default:       return nullptr;
        }
    }
    else if (node->kind == "alias") {
        td_op_t* arg = EmitExpr(g, node->left);
        return td_alias(g, arg, node->str_val.c_str());
    }
    else if (node->kind == "naryop") {
        const std::string& op = node->str_val;
        if (op == "substr") {
            td_op_t* str = EmitExpr(g, node->args[0]);
            td_op_t* start = EmitExpr(g, node->args[1]);
            td_op_t* len = EmitExpr(g, node->args[2]);
            return td_substr(g, str, start, len);
        }
        if (op == "replace") {
            td_op_t* str = EmitExpr(g, node->args[0]);
            td_op_t* from = EmitExpr(g, node->args[1]);
            td_op_t* to = EmitExpr(g, node->args[2]);
            return td_replace(g, str, from, to);
        }
        if (op == "concat") {
            int n = (int)node->args.size();
            std::vector<td_op_t*> ops(n);
            for (int i = 0; i < n; i++) ops[i] = EmitExpr(g, node->args[i]);
            return td_concat(g, ops.data(), n);
        }
        if (op == "if") {
            td_op_t* cond = EmitExpr(g, node->args[0]);
            td_op_t* then_val = EmitExpr(g, node->args[1]);
            td_op_t* else_val = EmitExpr(g, node->args[2]);
            return td_if(g, cond, then_val, else_val);
        }
        return nullptr;
    }
    else if (node->kind == "cast") {
        td_op_t* arg = EmitExpr(g, node->left);
        return td_cast(g, arg, node->target_type);
    }
    else if (node->kind == "dateop") {
        td_op_t* arg = EmitExpr(g, node->left);
        if (node->str_val == "extract")    return td_extract(g, arg, node->date_field);
        if (node->str_val == "date_trunc") return td_date_trunc(g, arg, node->date_field);
        return nullptr;
    }

    return nullptr;
}

// ---------------------------------------------------------------------------
// Decompose an agg Expr into (opcode, input_node) for td_group
// ---------------------------------------------------------------------------

static void DecomposeAgg(td_graph_t* g,
                         const std::shared_ptr<ExprNode>& expr,
                         uint16_t& out_opcode,
                         td_op_t*& out_input,
                         td_op_t*& out_alias_node) {
    out_alias_node = nullptr;

    // Handle alias wrapping: alias(agg(...))
    const ExprNode* inner = expr.get();
    std::string alias_name;
    if (inner->kind == "alias") {
        alias_name = inner->str_val;
        inner = inner->left.get();
    }

    if (inner->kind == "agg") {
        out_opcode = (uint16_t)inner->agg_opcode;
        out_input = EmitExpr(g, inner->left);
    } else {
        // Non-agg expression in agg list — treat as OP_FIRST
        out_opcode = OP_FIRST;
        out_input = EmitExpr(g, expr->left ? expr->left : expr);
    }

    if (!alias_name.empty()) {
        // We cannot alias inside td_group directly.
        // The alias will be handled at a higher level if needed.
    }
}

// ---------------------------------------------------------------------------
// ExecutePlan: walk serialized plan steps and emit graph nodes (Teide thread)
// ---------------------------------------------------------------------------

td_t* ExecutePlan(td_t* tbl, const std::vector<PlanStep>& plan) {
    td_graph_t* g = td_graph_new(tbl);
    if (!g) return TD_ERR_PTR(TD_ERR_OOM);

    td_op_t* current = nullptr;
    td_op_t* filter_pred = nullptr;

    for (const auto& step : plan) {
        if (step.type == "filter") {
            td_op_t* pred = EmitExpr(g, step.filter_expr);
            if (!current) {
                // Accumulate predicates with AND
                if (filter_pred) {
                    filter_pred = td_and(g, filter_pred, pred);
                } else {
                    filter_pred = pred;
                }
            } else {
                current = td_filter(g, current, pred);
            }
        }
        else if (step.type == "group") {
            // If there's a pending filter predicate, execute it and set selection
            if (filter_pred) {
                td_t* mask = td_execute(g, filter_pred);
                if (TD_IS_ERR(mask)) {
                    td_graph_free(g);
                    return mask;
                }
                td_retain(mask);
                g->selection = mask;
                filter_pred = nullptr;
            }

            // Emit key scan nodes
            uint8_t n_keys = (uint8_t)step.group_keys.size();
            std::vector<td_op_t*> key_nodes(n_keys);
            for (uint8_t k = 0; k < n_keys; k++) {
                key_nodes[k] = td_scan(g, step.group_keys[k].c_str());
            }

            // Decompose agg_exprs into (opcode, input) pairs
            uint8_t n_aggs = (uint8_t)step.agg_exprs.size();
            std::vector<uint16_t> agg_ops(n_aggs);
            std::vector<td_op_t*> agg_ins(n_aggs);
            for (uint8_t a = 0; a < n_aggs; a++) {
                td_op_t* alias_node = nullptr;
                DecomposeAgg(g, step.agg_exprs[a],
                           agg_ops[a], agg_ins[a], alias_node);
            }

            current = td_group(g,
                             key_nodes.data(), n_keys,
                             agg_ops.data(), agg_ins.data(), n_aggs);
        }
        else if (step.type == "sort") {
            td_op_t* table_node = current ? current : td_const_table(g, tbl);

            // Apply pending filter
            if (filter_pred) {
                table_node = td_filter(g, table_node, filter_pred);
                filter_pred = nullptr;
            }

            // Emit sort key scan nodes
            uint8_t n_cols = (uint8_t)step.sort_cols.size();
            std::vector<td_op_t*> key_nodes(n_cols);
            std::vector<uint8_t> descs(n_cols);
            for (uint8_t c = 0; c < n_cols; c++) {
                key_nodes[c] = td_scan(g, step.sort_cols[c].c_str());
                descs[c] = step.sort_descs[c] ? 1 : 0;
            }

            current = td_sort_op(g, table_node,
                               key_nodes.data(), descs.data(),
                               nullptr, n_cols);
        }
        else if (step.type == "head") {
            if (!current) {
                current = td_const_table(g, tbl);
            }
            if (filter_pred) {
                current = td_filter(g, current, filter_pred);
                filter_pred = nullptr;
            }
            current = td_head(g, current, step.head_n);
        }
        else if (step.type == "tail") {
            if (!current) {
                current = td_const_table(g, tbl);
            }
            if (filter_pred) {
                current = td_filter(g, current, filter_pred);
                filter_pred = nullptr;
            }
            current = td_tail(g, current, step.tail_n);
        }
        else if (step.type == "distinct") {
            if (filter_pred) {
                td_t* mask = td_execute(g, filter_pred);
                if (TD_IS_ERR(mask)) { td_graph_free(g); return mask; }
                td_retain(mask);
                g->selection = mask;
                filter_pred = nullptr;
            }
            uint8_t n_keys = (uint8_t)step.distinct_cols.size();
            std::vector<td_op_t*> key_nodes(n_keys);
            for (uint8_t k = 0; k < n_keys; k++) {
                key_nodes[k] = td_scan(g, step.distinct_cols[k].c_str());
            }
            current = td_distinct(g, key_nodes.data(), n_keys);
        }
        else if (step.type == "select") {
            td_op_t* table_node = current ? current : td_const_table(g, tbl);
            if (filter_pred) {
                table_node = td_filter(g, table_node, filter_pred);
                filter_pred = nullptr;
            }
            uint8_t n = (uint8_t)step.select_cols.size();
            std::vector<td_op_t*> col_nodes(n);
            for (uint8_t c = 0; c < n; c++) {
                col_nodes[c] = td_scan(g, step.select_cols[c].c_str());
            }
            current = td_select(g, table_node, col_nodes.data(), n);
        }
        else if (step.type == "project") {
            td_op_t* table_node = current ? current : td_const_table(g, tbl);
            if (filter_pred) {
                table_node = td_filter(g, table_node, filter_pred);
                filter_pred = nullptr;
            }

            // The C core's OP_SELECT executor uses synthetic names (_e0)
            // for computed expression columns. To preserve alias names,
            // we execute the input, evaluate each expression in a fresh
            // graph, and build the result table with correct column names.

            td_t* input_result = td_execute(g, table_node);
            if (!input_result || TD_IS_ERR(input_result)) {
                td_graph_free(g);
                return input_result ? input_result : TD_ERR_PTR(TD_ERR_OOM);
            }

            td_graph_t* g2 = td_graph_new(input_result);
            if (!g2) {
                td_release(input_result);
                td_graph_free(g);
                return TD_ERR_PTR(TD_ERR_OOM);
            }

            uint8_t n = (uint8_t)step.project_exprs.size();
            td_t* result = td_table_new(n);

            for (uint8_t e = 0; e < n; e++) {
                const auto& proj_expr = step.project_exprs[e];

                // Extract alias name if present, emit inner expression
                std::string alias_name;
                std::shared_ptr<ExprNode> emit_expr = proj_expr;
                if (proj_expr->kind == "alias") {
                    alias_name = proj_expr->str_val;
                    emit_expr = proj_expr->left;
                }

                td_op_t* expr_node = EmitExpr(g2, emit_expr);
                td_t* col_result = td_execute(g2, expr_node);

                if (col_result && !TD_IS_ERR(col_result)) {
                    int64_t name_id;
                    if (!alias_name.empty()) {
                        name_id = td_sym_intern(alias_name.c_str(), alias_name.size());
                    } else {
                        char buf[16];
                        int len = snprintf(buf, sizeof(buf), "_e%u", (unsigned)e);
                        name_id = td_sym_intern(buf, (size_t)len);
                    }
                    result = td_table_add_col(result, name_id, col_result);
                    td_release(col_result);
                }
            }

            td_graph_free(g2);
            td_release(input_result);
            td_graph_free(g);
            return result;
        }
        else if (step.type == "join") {
            td_op_t* left_table_node = current ? current : td_const_table(g, tbl);
            if (filter_pred) {
                left_table_node = td_filter(g, left_table_node, filter_pred);
                filter_pred = nullptr;
            }

            uint16_t right_id = td_graph_add_table(g, step.join_right_table);
            td_op_t* right_table_node = td_const_table(g, step.join_right_table);

            uint8_t n_keys = (uint8_t)step.join_left_keys.size();
            std::vector<td_op_t*> left_keys(n_keys);
            std::vector<td_op_t*> right_keys(n_keys);
            for (uint8_t k = 0; k < n_keys; k++) {
                left_keys[k] = td_scan(g, step.join_left_keys[k].c_str());
                right_keys[k] = td_scan_table(g, right_id, step.join_right_keys[k].c_str());
            }

            current = td_join(g, left_table_node, left_keys.data(),
                              right_table_node, right_keys.data(),
                              n_keys, step.join_type);

            td_release(step.join_right_table);
        }
    }

    // If nothing produced current, use const_table
    if (!current) {
        current = td_const_table(g, tbl);
    }

    // Apply any remaining pending filter
    if (filter_pred) {
        current = td_filter(g, current, filter_pred);
    }

    // Optimize and execute
    td_op_t* root = td_optimize(g, current);
    td_t* result = td_execute(g, root);
    td_graph_free(g);
    return result;
}

// ---------------------------------------------------------------------------
// QueryCollectSync: synchronous query execution exposed to JS
// ---------------------------------------------------------------------------

Napi::Value QueryCollectSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "collectSync requires (NativeTable, ops[])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Unwrap NativeTable
    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(
        info[0].As<Napi::Object>());
    td_t* tbl_ptr = table->ptr();
    TeideThread* thread = table->thread();

    // Serialize the plan on the main (V8) thread
    Napi::Array ops = info[1].As<Napi::Array>();
    std::vector<PlanStep> plan = SerializePlan(ops);

    // Dispatch to Teide thread
    void* result = thread->dispatch_sync(
        [tbl_ptr, plan]() -> void* {
            return (void*)ExecutePlan(tbl_ptr, plan);
        });

    td_t* res = (td_t*)result;
    if (TD_IS_ERR(res)) {
        std::string msg = "Query execution failed: ";
        msg += td_err_str(TD_ERR_CODE(res));
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return NativeTable::Create(env, res, thread);
}

// ---------------------------------------------------------------------------
// QueryCollect: async query execution exposed to JS (returns Promise)
// ---------------------------------------------------------------------------

Napi::Value QueryCollect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "collect requires (NativeTable, ops[])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Unwrap NativeTable
    NativeTable* table = Napi::ObjectWrap<NativeTable>::Unwrap(
        info[0].As<Napi::Object>());
    td_t* tbl_ptr = table->ptr();
    TeideThread* thread = table->thread();

    // Retain the source table so it stays alive during async execution
    td_retain(tbl_ptr);

    // Serialize the plan on the main (V8) thread
    Napi::Array ops = info[1].As<Napi::Array>();
    std::vector<PlanStep> plan = SerializePlan(ops);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function(),
                                               "collect", 0, 1);

    thread->dispatch_async(
        [tbl_ptr, plan]() -> void* {
            void* result = (void*)ExecutePlan(tbl_ptr, plan);
            td_release(tbl_ptr);
            return result;
        },
        tsfn,
        [deferred, thread](Napi::Env env, void* data) {
            td_t* res = (td_t*)data;
            if (TD_IS_ERR(res)) {
                deferred.Reject(Napi::Error::New(env,
                    std::string("Query execution failed: ") +
                    td_err_str(TD_ERR_CODE(res))).Value());
            } else {
                deferred.Resolve(NativeTable::Create(env, res, thread));
            }
        }
    );

    return deferred.Promise();
}
