//! The services run on tokio; the window runs on GPUI's executor. A page starts service work with `spawn` and awaits
//! it from a GPUI task (`cx.spawn`), which then updates the page on the UI thread.

use std::future::Future;
use std::sync::LazyLock;

use futures::channel::mpsc;

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("deckino-tokio").build().expect("tokio")
});

pub fn runtime() -> &'static tokio::runtime::Runtime {
    &RUNTIME
}

/// Runs `work` on tokio. The returned future can be awaited on any executor; a panic becomes an error.
pub fn spawn<T: Send + 'static>(
    work: impl Future<Output = anyhow::Result<T>> + Send + 'static,
) -> impl Future<Output = anyhow::Result<T>> {
    let handle = RUNTIME.spawn(work);
    async move { handle.await.map_err(|error| anyhow::anyhow!("The background job stopped: {error}"))? }
}

/// Progress from tokio work to a GPUI task: the sender goes into the service callback
/// (`move |p| { let _ = tx.unbounded_send(p); }`), the page drains the receiver.
pub fn channel<T>() -> (mpsc::UnboundedSender<T>, mpsc::UnboundedReceiver<T>) {
    mpsc::unbounded()
}
