mod commands;
mod error;
mod git_ops;
mod persistence;
mod pty;
mod pull_requests;
mod scrollback;
mod session;
mod session_status;
mod state;
mod todos;
mod unified_diff;
mod worktree;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let app_state = AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            // Build the macOS app menu with a Settings... item that fires the
            // `acorn:open-settings` event the frontend listens for. The
            // accelerator (Cmd+,) is registered on the OS menu, so it works
            // even if the webview doesn't see the keystroke.
            let settings_item = MenuItemBuilder::new("Settings...")
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let app_submenu = SubmenuBuilder::new(app, "Acorn")
                .about(None)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_submenu = SubmenuBuilder::new(app, "View")
                .fullscreen()
                .build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;
            let menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&window_submenu)
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(move |handle, event| {
                if event.id() == "settings" {
                    if let Err(err) = handle.emit("acorn:open-settings", ()) {
                        tracing::warn!("failed to emit open-settings: {err}");
                    }
                }
            });

            let state = app.state::<AppState>();
            for session in persistence::load_sessions().unwrap_or_default() {
                state.sessions.insert(session);
            }
            for project in persistence::load_projects().unwrap_or_default() {
                state.projects.insert(project);
            }
            // Backfill projects from sessions if any sessions reference a path
            // that has no project entry (e.g. older versions that did not
            // persist projects).
            for session in state.sessions.list() {
                let name = session
                    .repo_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("project")
                    .to_string();
                state.projects.ensure(session.repo_path.clone(), name);
            }
            // Drop scrollback files for sessions that no longer exist (e.g.
            // removed while the app was offline, or pre-feature debris).
            let live_ids: Vec<String> = state
                .sessions
                .list()
                .iter()
                .map(|s| s.id.to_string())
                .collect();
            if let Err(err) = scrollback::prune_orphans(&live_ids) {
                tracing::warn!("scrollback prune at boot failed: {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sessions,
            commands::create_session,
            commands::remove_session,
            commands::set_session_status,
            commands::rename_session,
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::reorder_projects,
            commands::list_commits,
            commands::list_staged,
            commands::commit_diff,
            commands::commit_web_url,
            commands::claude_session_exists,
            commands::open_in_editor,
            commands::staged_diff,
            commands::list_pull_requests,
            commands::get_pull_request_detail,
            commands::merge_pull_request,
            commands::close_pull_request,
            commands::generate_pr_commit_message,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::scrollback_save,
            commands::scrollback_load,
            commands::scrollback_delete,
            commands::read_session_todos,
            commands::detect_session_statuses,
            commands::get_memory_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
