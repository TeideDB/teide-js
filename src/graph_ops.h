#pragma once

#include "teide_thread.h"

// Graph operation functions exported to JS
Napi::Value GraphExpandSync(const Napi::CallbackInfo& info);
Napi::Value GraphExpand(const Napi::CallbackInfo& info);
Napi::Value GraphVarExpandSync(const Napi::CallbackInfo& info);
Napi::Value GraphVarExpand(const Napi::CallbackInfo& info);
Napi::Value GraphShortestPathSync(const Napi::CallbackInfo& info);
Napi::Value GraphShortestPath(const Napi::CallbackInfo& info);
Napi::Value GraphWcoJoinSync(const Napi::CallbackInfo& info);
Napi::Value GraphWcoJoin(const Napi::CallbackInfo& info);
