#pragma once

// C++ standard headers and NAPI must be included BEFORE compat.h,
// because the C-atomic shim macros conflict with C++ <atomic>.
#include <napi.h>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <functional>
#include <atomic>
#include <memory>

struct WorkItem {
    std::function<void*()> work;
    std::function<void(void*)> on_done;
    void* result = nullptr;
    std::mutex mtx;
    std::condition_variable cv;
    bool done = false;
};

class TeideThread {
public:
    TeideThread();
    ~TeideThread();
    void* dispatch_sync(std::function<void*()> work);
    void dispatch_async(std::function<void*()> work,
                        Napi::ThreadSafeFunction tsfn,
                        std::function<void(Napi::Env, void*)> js_callback);
    void shutdown();
    bool is_running() const { return running_.load(); }

    // Shared flag: true while the Teide heap is alive.
    // Handed to NativeTable/NativeSeries so they can skip td_release
    // during GC if the heap was already torn down.
    std::shared_ptr<std::atomic<bool>> heap_alive() const { return heap_alive_; }

private:
    void thread_main();
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> shutdown_{false};
    std::mutex queue_mtx_;
    std::condition_variable queue_cv_;
    std::queue<std::shared_ptr<WorkItem>> queue_;
    std::shared_ptr<std::atomic<bool>> heap_alive_ = std::make_shared<std::atomic<bool>>(true);
};
