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
    assertions: Vec<platform::PowerAssertion>,
}

impl PowerAssertionState {
    pub fn new() -> Self {
        Self {
            assertions: Vec::new(),
        }
    }

    pub fn status(&self) -> PreventSleepStatus {
        PreventSleepStatus {
            supported: platform::SUPPORTED,
            enabled: !self.assertions.is_empty(),
        }
    }

    pub fn set_prevent_sleep(&mut self, enabled: bool) -> AppResult<PreventSleepStatus> {
        if !enabled {
            self.assertions.clear();
            return Ok(self.status());
        }

        if !platform::SUPPORTED {
            return Ok(self.status());
        }

        if self.assertions.is_empty() {
            self.assertions = platform::acquire_all().map_err(AppError::Other)?;
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
    // PreventUserIdleSystemSleep only blocks the idle timer while the
    // display is on. Once the display sleeps, powerd drops its own
    // "prevent sleep while display is on" hold and the machine can still
    // sleep. PreventSystemSleep is what keeps agent sessions running after
    // the screen turns off; macOS honors it on AC power.
    const ASSERTION_TYPES: &[&str] = &["PreventUserIdleSystemSleep", "PreventSystemSleep"];
    const ASSERTION_NAME: &str = "Acorn keep awake";
    const ASSERTION_DETAILS: &str =
        "Acorn is preventing system sleep while the keep-awake setting is enabled.";

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

    pub fn acquire_all() -> Result<Vec<PowerAssertion>, String> {
        let mut held = Vec::new();
        for assertion_type in ASSERTION_TYPES {
            match PowerAssertion::new(assertion_type) {
                Ok(assertion) => held.push(assertion),
                Err(error) => return Err(error),
            }
        }
        Ok(held)
    }

    impl PowerAssertion {
        fn new(assertion_type: &str) -> Result<Self, String> {
            let assertion_type_cf = CFString::new(assertion_type);
            let name = CFString::new(ASSERTION_NAME);
            let details = CFString::new(ASSERTION_DETAILS);
            let mut id = 0;

            let result = unsafe {
                IOPMAssertionCreateWithDescription(
                    assertion_type_cf.as_concrete_TypeRef(),
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
                    "{assertion_type}: IOPMAssertionCreateWithDescription failed with IOReturn {result}"
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

    pub fn acquire_all() -> Result<Vec<PowerAssertion>, String> {
        Err("prevent sleep is only supported on macOS".to_string())
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

    #[cfg(target_os = "macos")]
    #[test]
    fn enabling_holds_idle_and_system_sleep_assertions() {
        let mut state = PowerAssertionState::new();

        let status = state.set_prevent_sleep(true).unwrap();
        assert!(status.supported);
        assert!(status.enabled);

        let listed = pmset_assertions();
        let pid_prefix = format!("pid {}(", std::process::id());
        assert!(
            listed.lines().any(|line| {
                line.contains(&pid_prefix)
                    && line.contains("Acorn keep awake")
                    && line.contains("PreventUserIdleSystemSleep")
            }),
            "expected idle-sleep keep-awake assertion in pmset output:\n{listed}"
        );
        assert!(
            listed.lines().any(|line| {
                line.contains(&pid_prefix)
                    && line.contains("Acorn keep awake")
                    && line.contains("PreventSystemSleep")
            }),
            "expected system-sleep keep-awake assertion in pmset output:\n{listed}"
        );

        let status = state.set_prevent_sleep(false).unwrap();
        assert!(!status.enabled);
        let listed = pmset_assertions();
        assert!(
            !listed
                .lines()
                .any(|line| line.contains(&pid_prefix) && line.contains("Acorn keep awake")),
            "keep-awake assertions should be released:\n{listed}"
        );
    }

    #[cfg(target_os = "macos")]
    fn pmset_assertions() -> String {
        let output = std::process::Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .expect("pmset -g assertions");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
}
