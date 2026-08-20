//! Desktop notifications that can route the user back to a session.
//!
//! `tauri-plugin-notification` delivers desktop notifications fire-and-forget:
//! its desktop implementation maps title, body, icon and sound onto
//! `notify-rust` and returns, never reading the `extra` payload and never
//! observing what the user does with the banner. Click routing there is a
//! mobile-only feature, gated behind a `register_listener` command the desktop
//! plugin does not register.
//!
//! `notify-rust` itself does expose the response on every desktop backend, so
//! this module posts the notification directly and waits for it. A click on the
//! body arrives as `NotificationResponse::Default` and is forwarded to the
//! frontend as [`NOTIFICATION_CLICKED_EVENT`] carrying the originating session
//! id, which the UI turns into "focus that session".

use notify_rust::NotificationResponse;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::error::AppError;

/// Event emitted when the user activates a session notification.
pub const NOTIFICATION_CLICKED_EVENT: &str = "notification://clicked";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClicked {
    pub session_id: String,
}

/// Bundle identity the OS should attribute the notification to.
///
/// macOS posts through `mac-notification-sys`, which needs a bundle id it can
/// resolve; an unbundled dev binary has none, so development builds borrow
/// Terminal's the same way the notification plugin does. Windows needs the
/// AppUserModelID to match the installed shortcut for activation callbacks to
/// come back to us at all.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn notification_identity(identifier: &str) -> String {
    if cfg!(target_os = "macos") && tauri::is_dev() {
        "com.apple.Terminal".to_string()
    } else {
        identifier.to_string()
    }
}

/// Posts a session notification and forwards a click back to the frontend.
///
/// The wait is blocking — every backend parks until the user acts or the banner
/// closes — so it runs on its own thread. On macOS the wait additionally relies
/// on the main run loop being pumped, which is true for as long as the app is
/// alive; if the app exits first the thread dies with it and the click is
/// simply never delivered.
#[tauri::command]
pub fn notify_session<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<(), AppError> {
    let identity = notification_identity(&app.config().identifier);

    std::thread::Builder::new()
        .name("acorn-notification".to_string())
        .spawn(move || {
            #[cfg(target_os = "macos")]
            {
                // Only the first call in a process takes effect; the plugin may
                // have claimed it already for a permission probe, and either
                // way the value is the same.
                let _ = notify_rust::set_application(&identity);
            }

            let mut notification = notify_rust::Notification::new();
            notification.summary(&title).body(&body);
            #[cfg(windows)]
            notification.app_id(&identity);

            let handle = match notification.show() {
                Ok(handle) => handle,
                Err(error) => {
                    tracing::warn!(%error, "failed to post session notification");
                    return;
                }
            };

            // Without a session to return to there is nothing to wait for, and
            // parking a thread on a banner nobody can act on would leak one
            // thread per notification.
            let Some(session_id) = session_id else {
                return;
            };

            if let Err(error) = handle.wait_for_response(move |response: &NotificationResponse| {
                if !response.is_default_action() {
                    return;
                }
                if let Err(error) = app.emit(
                    NOTIFICATION_CLICKED_EVENT,
                    NotificationClicked { session_id },
                ) {
                    tracing::warn!(%error, "failed to deliver notification click");
                }
            }) {
                tracing::debug!(%error, "notification closed without a response");
            }
        })
        .map_err(AppError::Io)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_post_as_the_app_itself() {
        // `tauri::is_dev()` is false under `cargo test` for a release-shaped
        // build, and every non-macOS target keeps the identifier regardless.
        if cfg!(target_os = "macos") && tauri::is_dev() {
            assert_eq!(
                notification_identity("io.im-ian.acorn"),
                "com.apple.Terminal"
            );
        } else {
            assert_eq!(notification_identity("io.im-ian.acorn"), "io.im-ian.acorn");
        }
    }

    #[test]
    fn click_payload_names_the_session_in_the_shape_the_frontend_reads() {
        let payload = NotificationClicked {
            session_id: "session-1".to_string(),
        };
        let json = serde_json::to_string(&payload).expect("serialize");
        assert_eq!(json, r#"{"sessionId":"session-1"}"#);
    }
}
