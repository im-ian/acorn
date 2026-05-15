mod agent_resume;
mod agent_resume_persister;
mod claude_util;
mod cli_resolver;
mod commands;
pub mod daemon;
mod daemon_bridge;
mod daemon_commands;
mod daemon_stream;
mod error;
mod git_ops;
mod ipc;
mod persistence;
mod pty;
mod pty_env;
mod pull_requests;
mod scrollback;
mod session;
mod session_status;
mod shell_args;
mod shell_env;
mod shell_init;
mod shell_util;
mod state;
mod todos;
mod transcript_watcher;
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

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // Release-only: lets `bun run tauri dev` run alongside an installed Acorn.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            let multi_input_item = MenuItemBuilder::new("Toggle Multi Input")
                .id("toggle-multi-input")
                .accelerator("CmdOrCtrl+Alt+I")
                .build(app)?;
            // Dev-only Reload (Cmd+R) so frontend edits that don't HMR cleanly
            // can be re-bootstrapped without restarting the whole Tauri host.
            // The release menu omits it on purpose — Acorn ships as a single
            // long-lived app and an accidental Cmd+R would drop every PTY's
            // in-memory state.
            #[cfg(debug_assertions)]
            let reload_item = MenuItemBuilder::new("Reload")
                .id("reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            #[cfg(debug_assertions)]
            let view_submenu = SubmenuBuilder::new(app, "View")
                .item(&multi_input_item)
                .separator()
                .item(&reload_item)
                .separator()
                .fullscreen()
                .build()?;
            #[cfg(not(debug_assertions))]
            let view_submenu = SubmenuBuilder::new(app, "View")
                .item(&multi_input_item)
                .separator()
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
                if event.id() == "toggle-multi-input" {
                    if let Err(err) = handle.emit("acorn:toggle-multi-input", ()) {
                        tracing::warn!("failed to emit toggle-multi-input: {err}");
                    }
                }
                #[cfg(debug_assertions)]
                if event.id() == "reload" {
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(err) = window.eval("window.location.reload()") {
                            tracing::warn!("failed to reload webview: {err}");
                        }
                    }
                }
            });

            let state = app.state::<AppState>();
            let (sessions_loaded, sessions_clean) = persistence::load_sessions_with_status()
                .unwrap_or_else(|err| {
                    tracing::warn!("session path resolution failed at boot: {err}");
                    (Vec::new(), false)
                });
            for session in sessions_loaded {
                state.sessions.insert(session);
            }
            let (projects_loaded, projects_clean) = persistence::load_projects_with_status()
                .unwrap_or_else(|err| {
                    tracing::warn!("project path resolution failed at boot: {err}");
                    (Vec::new(), false)
                });
            for project in projects_loaded {
                state.projects.insert(project);
            }
            state
                .sessions_loaded_cleanly
                .store(sessions_clean, std::sync::atomic::Ordering::SeqCst);
            state
                .projects_loaded_cleanly
                .store(projects_clean, std::sync::atomic::Ordering::SeqCst);
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
            // Drop scrollback files that no longer have a matching session.
            // Skip when the session load was unclean — otherwise a transient
            // disk failure would silently delete every scrollback file on the
            // way to a fully empty session list.
            let live_ids: Vec<String> = state
                .sessions
                .list()
                .iter()
                .map(|s| s.id.to_string())
                .collect();
            if live_ids.is_empty() && !sessions_clean {
                tracing::warn!(
                    "skipping scrollback prune: session load was unclean and no live ids"
                );
            } else if let Err(err) = scrollback::prune_orphans(&live_ids) {
                tracing::warn!("scrollback prune at boot failed: {err}");
            }
            // Start the IPC server in the background. It owns its own
            // listener thread; if bind fails it logs and the app keeps
            // running with IPC disabled. The returned handle lets
            // `ipc_restart` cycle the listener without process restart.
            let handle = ipc::server::start(app.handle().clone(), state.inner().clone());
            *state.ipc_handle.lock() = handle;

            // Resolve and cache the `acornd` binary location now so the
            // bridge does not pay the lookup cost on every spawn. In
            // bundled mode the binary lives at
            // `Contents/MacOS/acornd`; in `bun run tauri dev` it sits
            // at `target/debug/acornd`. Cache failure (binary missing)
            // is non-fatal — the bridge will surface a `BinaryNotFound`
            // error on the first daemon-routed call so the user sees
            // exactly which path was searched.
            let acornd_hint = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("acornd")));
            state.daemon_bridge.cache_binary_path(acornd_hint);
            // Eagerly spawn the daemon on a background thread so the
            // StatusBar indicator goes green within the first poll
            // cycle. The status probe alone is passive (it never
            // spawns) and the rest of the lazy-spawn path lives behind
            // active calls like `list_sessions` / `spawn` — those
            // never fire from StatusBar polling, so without this the
            // daemon stays down for the entire app session until the
            // user manually clicks something that routes through it.
            //
            // Off the main thread because `ensure_connection` waits up
            // to ~5 s for the freshly-spawned daemon's socket to come
            // up; blocking the Tauri setup would visibly stall app
            // startup on cold machines. On daemon-binary-missing the
            // background thread logs a warning and exits — the
            // killswitch UI surfaces the same error if the user opens
            // the Background sessions tab.
            let bridge_for_boot = state.daemon_bridge.clone();
            std::thread::Builder::new()
                .name("acorn-daemon-boot".into())
                .spawn(move || {
                    if !bridge_for_boot.is_enabled() {
                        return;
                    }
                    if let Err(err) = bridge_for_boot.ensure_connection() {
                        tracing::warn!(error = %err, "daemon boot spawn failed");
                    }
                })
                .ok();

            // Watcher that mirrors live agent transcripts into per-session
            // `claude.id` / `codex.id` files. The focus-time resume modal
            // reads those files; no shim or PATH injection is required.
            agent_resume_persister::spawn(state.inner().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_status,
            commands::list_sessions,
            commands::create_session,
            commands::remove_session,
            commands::set_session_status,
            commands::rename_session,
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::reorder_projects,
            commands::reorder_sessions,
            commands::list_commits,
            commands::list_staged,
            commands::commit_diff,
            commands::commit_web_url,
            commands::open_in_editor,
            commands::staged_diff,
            commands::list_pull_requests,
            commands::get_pull_request_detail,
            commands::get_pull_request_commit_diff,
            commands::resolve_commit_logins,
            commands::merge_pull_request,
            commands::close_pull_request,
            commands::update_pull_request_body,
            commands::generate_pr_commit_message,
            commands::list_workflow_runs,
            commands::get_workflow_run_detail,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_reload_shell_env,
            commands::pty_cwd,
            commands::pty_repo_root,
            commands::pty_in_worktree_all,
            commands::is_path_linked_worktree,
            commands::update_session_worktree,
            commands::git_worktrees,
            commands::scrollback_save,
            commands::scrollback_load,
            commands::scrollback_delete,
            commands::scrollback_orphan_size,
            commands::scrollback_orphan_clear,
            commands::read_session_todos,
            commands::detect_session_statuses,
            commands::detect_session_agent,
            commands::prepare_claude_fork,
            commands::get_memory_usage,
            commands::get_acorn_ipc_status,
            commands::ipc_restart,
            commands::list_system_fonts,
            commands::get_claude_resume_candidate,
            commands::acknowledge_claude_resume,
            commands::get_codex_resume_candidate,
            commands::acknowledge_codex_resume,
            daemon_commands::daemon_status,
            daemon_commands::daemon_set_enabled,
            daemon_commands::daemon_restart,
            daemon_commands::daemon_shutdown,
            daemon_commands::daemon_list_sessions,
            daemon_commands::daemon_spawn_session,
            daemon_commands::daemon_send_input,
            daemon_commands::daemon_resize,
            daemon_commands::daemon_kill_session,
            daemon_commands::daemon_forget_session,
            daemon_commands::daemon_adopt_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
