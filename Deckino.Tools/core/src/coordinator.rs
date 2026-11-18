use std::sync::Arc;

use anyhow::{Result, bail};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::Cancelled;

/// One workspace operation at a time (a training run, an import, a pack): a second one fails at once, unless it
/// waits its turn (`wait`), which is how training runs queue behind each other.
#[derive(Clone)]
pub struct WorkspaceOperationCoordinator {
    gate: Arc<Semaphore>,
}

impl Default for WorkspaceOperationCoordinator {
    fn default() -> Self {
        Self { gate: Arc::new(Semaphore::new(1)) }
    }
}

impl WorkspaceOperationCoordinator {
    pub fn is_busy(&self) -> bool {
        self.gate.available_permits() == 0
    }

    /// Held until dropped.
    pub fn acquire(&self, operation: &str) -> Result<OwnedSemaphorePermit> {
        match self.gate.clone().try_acquire_owned() {
            Ok(permit) => Ok(permit),
            Err(_) => bail!("Cannot start {operation} while another workspace operation is running."),
        }
    }

    /// Held until dropped, once the running operation and everything queued before this has finished: tokio's
    /// semaphore hands permits out first come, first served, and `acquire` cannot jump the queue. Cancelling leaves
    /// the queue. `on_queued` runs only when it has to wait.
    pub async fn wait(&self, cancel: &CancellationToken, on_queued: impl FnOnce()) -> Result<OwnedSemaphorePermit> {
        if let Ok(permit) = self.gate.clone().try_acquire_owned() {
            return Ok(permit);
        }
        on_queued();
        tokio::select! {
            permit = self.gate.clone().acquire_owned() => Ok(permit?),
            () = cancel.cancelled() => Err(Cancelled.into()),
        }
    }
}

/// Keeps Windows from sleeping while held, so a training run (or a queue of them) can go overnight on a laptop that
/// would otherwise sleep at its idle timeout. The screen stays on too: Windows locks when the screen turns off (or the
/// screen saver starts), and on Modern Standby laptops screen-off is the sleep itself, which ES_SYSTEM_REQUIRED alone
/// doesn't hold off. Closing the lid still follows the lid setting.
pub struct KeepAwake {
    _release: std::sync::mpsc::Sender<()>,
}

impl KeepAwake {
    pub fn new() -> Self {
        use windows::Win32::System::Power::{
            ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };
        let (release, released) = std::sync::mpsc::channel::<()>();
        // The request belongs to the thread that makes it, so one thread holds it until the guard drops.
        std::thread::spawn(move || {
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) };
            let _ = released.recv();
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
        Self { _release: release }
    }
}

impl Default for KeepAwake {
    fn default() -> Self {
        Self::new()
    }
}
