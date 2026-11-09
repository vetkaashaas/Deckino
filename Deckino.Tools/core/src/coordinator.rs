use std::sync::Arc;

use anyhow::{Result, bail};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// One workspace operation at a time (a training run, an import, a pack): a second one fails at once.
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
}
