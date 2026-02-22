#pragma once

// teide_thread.h pulls in <napi.h> and C++ standard headers.
// These must come before compat.h's C-atomic shim.
#include "teide_thread.h"
#include <string>
#include <vector>
#include <memory>

// Forward-declare C types (defined in td.h, included via compat.h in .cpp files).
extern "C" {
    typedef union td_t td_t;
    typedef struct td_graph td_graph_t;
    typedef struct td_op td_op_t;
}

class TeideThread;

// Literal type discriminator for ExprNode
enum LitType { LIT_NUM = 0, LIT_BOOL = 1, LIT_STR = 2 };

// Serialized expression node (safe to pass across threads)
struct ExprNode {
    std::string kind;      // "col", "lit", "binop", "unop", "agg", "alias"
    std::string str_val;   // col name, op name, alias name, string literal
    double num_val = 0;
    bool bool_val = false;
    int agg_opcode = 0;
    LitType lit_type = LIT_NUM;
    std::shared_ptr<ExprNode> left;   // binop left, unop/agg/alias arg
    std::shared_ptr<ExprNode> right;  // binop right
};

// Serialized plan step (safe to pass across threads)
struct PlanStep {
    std::string type;
    std::shared_ptr<ExprNode> filter_expr;           // for 'filter'
    std::vector<std::string> group_keys;             // for 'group'
    std::vector<std::shared_ptr<ExprNode>> agg_exprs; // for 'group'
    std::vector<std::string> sort_cols;               // for 'sort'
    std::vector<bool> sort_descs;                     // for 'sort'
    int64_t head_n = 0;                               // for 'head'
};

// Static query execution functions exposed to JS
Napi::Value QueryCollectSync(const Napi::CallbackInfo& info);
Napi::Value QueryCollect(const Napi::CallbackInfo& info);

// Serialization (JS -> C++, runs on main/V8 thread)
std::shared_ptr<ExprNode> SerializeExpr(Napi::Object expr);
std::vector<PlanStep> SerializePlan(Napi::Array ops);

// Graph emission (C++, runs on Teide thread)
td_op_t* EmitExpr(td_graph_t* g, const std::shared_ptr<ExprNode>& node);
td_t* ExecutePlan(td_t* tbl, const std::vector<PlanStep>& plan);
