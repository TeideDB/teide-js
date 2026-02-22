#pragma once

// Include C++ standard headers FIRST before any shim.
// NAPI pulls in <atomic>, <memory>, etc. which must not be
// polluted by the C-atomic compatibility definitions below.
#include <napi.h>

// C++ compatibility shim for <stdatomic.h> used by td.h.
// GCC 11's C-mode <stdatomic.h> is not valid C++17. We block its
// inclusion and provide minimal _Atomic / memory-order definitions
// so the C header's struct layouts are ABI-compatible.
#ifdef __cplusplus
#  define _STDATOMIC_H          // prevent GCC's C <stdatomic.h>
#  define _Atomic(T) volatile T // same size/alignment as C _Atomic

// memory-order constants (used by td_atomic_* helper macros in td.h)
#  define memory_order_relaxed __ATOMIC_RELAXED
#  define memory_order_acquire __ATOMIC_ACQUIRE
#  define memory_order_release __ATOMIC_RELEASE
#  define memory_order_acq_rel __ATOMIC_ACQ_REL
#  define memory_order_seq_cst __ATOMIC_SEQ_CST

// atomic operations used through td_atomic_* macros in td.h
#  define atomic_fetch_add_explicit(p, v, mo) \
       __atomic_fetch_add(p, v, mo)
#  define atomic_fetch_sub_explicit(p, v, mo) \
       __atomic_fetch_sub(p, v, mo)
#  define atomic_load_explicit(p, mo) \
       __atomic_load_n(p, mo)
#  define atomic_store_explicit(p, v, mo) \
       __atomic_store_n(p, v, mo)
#  define atomic_store(p, v) \
       __atomic_store_n(p, v, __ATOMIC_SEQ_CST)
#  define atomic_thread_fence(mo) __atomic_thread_fence(mo)
#  define atomic_exchange_explicit(p, v, mo) \
       __atomic_exchange_n(p, v, mo)
#  define atomic_compare_exchange_weak_explicit(p, exp, des, s, f) \
       __atomic_compare_exchange_n(p, exp, des, 1, s, f)
#endif

extern "C" {
#include <teide/td.h>
}
