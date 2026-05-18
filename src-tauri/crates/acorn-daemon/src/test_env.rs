//! Shared test-env mutex.
//!
//! Multiple test modules (`paths`, `lifecycle`) set + unset the same
//! process-global env var (`ACORN_DATA_DIR`) inside their tests. Per-module
//! locks let `paths::*` and `lifecycle::*` tests overlap and read each
//! other's mid-flight overrides — surfacing as flaky failures (e.g.
//! `paths::override_redirects_data_dir` reading `lifecycle`'s temp dir).
//!
//! One `ENV_LOCK` for the whole crate's tests serialises every env-mutating
//! test, eliminating the race. `parking_lot::Mutex` does not poison on
//! panic, so a panicking test does not cascade into the rest of the suite.

#![cfg(test)]

use parking_lot::Mutex;

pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());
