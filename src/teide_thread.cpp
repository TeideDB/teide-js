// teide_thread.h MUST come first — it pulls in <napi.h>, <atomic>,
// and other C++ headers that would conflict with the C-atomic shim.
#include "teide_thread.h"
#include "compat.h"

TeideThread::TeideThread() {
    running_ = true;
    thread_ = std::thread(&TeideThread::thread_main, this);
}

TeideThread::~TeideThread() {
    shutdown();
}

void TeideThread::thread_main() {
    td_heap_init();
    td_sym_init();

    while (!shutdown_.load()) {
        std::shared_ptr<WorkItem> item;
        {
            std::unique_lock<std::mutex> lock(queue_mtx_);
            queue_cv_.wait(lock, [&] { return !queue_.empty() || shutdown_.load(); });
            if (shutdown_.load() && queue_.empty()) break;
            if (queue_.empty()) continue;
            item = queue_.front();
            queue_.pop();
        }

        item->result = item->work();

        if (item->on_done) {
            item->on_done(item->result);
        }

        {
            std::lock_guard<std::mutex> lock(item->mtx);
            item->done = true;
        }
        item->cv.notify_one();
    }

    td_pool_destroy();
    td_sym_destroy();
    heap_alive_->store(false);
    td_heap_destroy();
    running_ = false;
}

void* TeideThread::dispatch_sync(std::function<void*()> work) {
    auto item = std::make_shared<WorkItem>();
    item->work = std::move(work);

    {
        std::lock_guard<std::mutex> lock(queue_mtx_);
        queue_.push(item);
    }
    queue_cv_.notify_one();

    std::unique_lock<std::mutex> lock(item->mtx);
    item->cv.wait(lock, [&] { return item->done; });
    return item->result;
}

void TeideThread::dispatch_async(std::function<void*()> work,
                                  Napi::ThreadSafeFunction tsfn,
                                  std::function<void(Napi::Env, void*)> js_callback) {
    auto cb = std::make_shared<std::function<void(Napi::Env, void*)>>(std::move(js_callback));
    auto item = std::make_shared<WorkItem>();
    item->work = std::move(work);
    item->on_done = [tsfn, cb](void* result) mutable {
        tsfn.BlockingCall(result, [cb](Napi::Env env, Napi::Function, void* data) {
            (*cb)(env, data);
        });
        tsfn.Release();
    };

    {
        std::lock_guard<std::mutex> lock(queue_mtx_);
        queue_.push(item);
    }
    queue_cv_.notify_one();
}

void TeideThread::shutdown() {
    if (!running_.load()) return;
    shutdown_ = true;
    queue_cv_.notify_one();
    if (thread_.joinable()) thread_.join();
}
