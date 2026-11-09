use tokio_util::sync::CancellationToken;

/// OperationCanceledException: a job stopped because it was cancelled. Callers tell it apart with `is_cancelled`.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The operation was cancelled.")
    }
}

impl std::error::Error for Cancelled {}

/// cancellationToken.ThrowIfCancellationRequested().
pub fn check(cancel: &CancellationToken) -> anyhow::Result<()> {
    if cancel.is_cancelled() { Err(Cancelled.into()) } else { Ok(()) }
}

pub fn is_cancelled(error: &anyhow::Error) -> bool {
    error.is::<Cancelled>()
}
