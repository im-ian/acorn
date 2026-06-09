use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreventSleepStatus {
    pub supported: bool,
    pub enabled: bool,
}

#[derive(Default)]
pub struct PowerAssertionState {
    assertion: Option<platform::PowerAssertion>,
}

impl PowerAssertionState {
    pub fn new() -> Self {
        Self { assertion: None }
    }

    pub fn status(&self) -> PreventSleepStatus {
        PreventSleepStatus {
            supported: platform::SUPPORTED,
            enabled: self.assertion.is_some(),
        }
    }

    pub fn set_prevent_sleep(&mut self, enabled: bool) -> AppResult<PreventSleepStatus> {
        if !enabled {
            self.assertion.take();
            return Ok(self.status());
        }

        if !platform::SUPPORTED {
            return Ok(self.status());
        }

        if self.assertion.is_none() {
            self.assertion = Some(platform::PowerAssertion::new().map_err(AppError::Other)?);
        }
        Ok(self.status())
    }
}

#[tauri::command]
pub fn prevent_sleep_status(state: State<'_, AppState>) -> PreventSleepStatus {
    state.power_assertion.lock().status()
}

#[tauri::command]
pub fn set_prevent_sleep(
    enabled: bool,
    state: State<'_, AppState>,
) -> AppResult<PreventSleepStatus> {
    state.power_assertion.lock().set_prevent_sleep(enabled)
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    pub const SUPPORTED: bool = true;

    type IOPMAssertionID = u32;
    type IOReturn = i32;
    type CFTimeInterval = f64;

    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    const ASSERTION_TYPE_PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
    const ASSERTION_NAME: &str = "Acorn keep awake";
    const ASSERTION_DETAILS: &str =
        "Acorn is preventing idle system sleep while the keep-awake setting is enabled.";

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithDescription(
            assertion_type: CFStringRef,
            name: CFStringRef,
            details: CFStringRef,
            human_readable_reason: CFStringRef,
            localization_bundle_path: CFStringRef,
            timeout: CFTimeInterval,
            timeout_action: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;

        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    pub struct PowerAssertion {
        id: IOPMAssertionID,
    }

    impl PowerAssertion {
        pub fn new() -> Result<Self, String> {
            let assertion_type = CFString::new(ASSERTION_TYPE_PREVENT_USER_IDLE_SYSTEM_SLEEP);
            let name = CFString::new(ASSERTION_NAME);
            let details = CFString::new(ASSERTION_DETAILS);
            let mut id = 0;

            let result = unsafe {
                IOPMAssertionCreateWithDescription(
                    assertion_type.as_concrete_TypeRef(),
                    name.as_concrete_TypeRef(),
                    details.as_concrete_TypeRef(),
                    std::ptr::null(),
                    std::ptr::null(),
                    0.0,
                    std::ptr::null(),
                    &mut id,
                )
            };

            if result == K_IO_RETURN_SUCCESS {
                Ok(Self { id })
            } else {
                Err(format!(
                    "IOPMAssertionCreateWithDescription failed with IOReturn {result}"
                ))
            }
        }
    }

    impl Drop for PowerAssertion {
        fn drop(&mut self) {
            let result = unsafe { IOPMAssertionRelease(self.id) };
            if result != K_IO_RETURN_SUCCESS {
                tracing::warn!(
                    assertion_id = self.id,
                    ioreturn = result,
                    "failed to release prevent-sleep assertion",
                );
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub const SUPPORTED: bool = false;

    pub struct PowerAssertion;

    impl PowerAssertion {
        pub fn new() -> Result<Self, String> {
            Err("prevent sleep is only supported on macOS".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PowerAssertionState;

    #[test]
    fn defaults_to_supported_platform_status_and_disabled() {
        let state = PowerAssertionState::new();

        assert!(!state.status().enabled);
    }

    #[test]
    fn disabling_without_assertion_is_idempotent() {
        let mut state = PowerAssertionState::new();

        let status = state.set_prevent_sleep(false).unwrap();

        assert!(!status.enabled);
    }
}
