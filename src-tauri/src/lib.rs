mod agent_history;
mod agent_hooks;
mod agent_resume;
mod agent_resume_persister;
mod agent_wrappers;
mod ai;
mod cli_resolver;
mod commands;
mod daemon_bridge;
mod daemon_commands;
mod daemon_stream;
mod error;
mod fs_explorer;
mod git_ops;
mod ipc;
mod persistence;
mod project_settings;
pub mod pty_env;
mod pty_output;
mod pull_requests;
mod session_titles;
mod shell_args;
mod shell_env;
mod shell_init;
mod shell_util;
mod staged_rev_reconcile;
mod state;
mod todos;
mod token_usage;
mod unified_diff;
mod worktree;

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[derive(Clone, Copy)]
struct NonPanickingStderr;

impl Write for NonPanickingStderr {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut stderr = std::io::stderr();
        match stderr.write(buf) {
            Ok(written) => Ok(written),
            Err(_) => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut stderr = std::io::stderr();
        let _ = stderr.flush();
        Ok(())
    }
}

fn remove_empty_home_project_mirror(state: &AppState) -> bool {
    let Some(home) = directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf()) else {
        return false;
    };
    if state
        .sessions
        .list()
        .iter()
        .any(|session| session.project_scoped && session.repo_path == home)
    {
        return false;
    }
    let removed = state.projects.remove(&home).is_some();
    if removed {
        tracing::info!(
            path = %home.display(),
            "removed stale local home project mirror"
        );
    }
    removed
}

fn path_basename(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_else(|| path.to_str().unwrap_or("project"))
        .to_string()
}

fn normalize_loaded_project_path(path: &Path) -> PathBuf {
    worktree::project_root_for_path(path).unwrap_or_else(|_| path.to_path_buf())
}

fn normalize_loaded_project(mut project: acorn_session::Project) -> (acorn_session::Project, bool) {
    let repo_path = normalize_loaded_project_path(&project.repo_path);
    let changed = repo_path != project.repo_path;
    if changed {
        project.name = path_basename(&repo_path);
        project.repo_path = repo_path;
    }
    (project, changed)
}

fn normalize_loaded_session(mut session: acorn_session::Session) -> (acorn_session::Session, bool) {
    if !session.project_scoped {
        return (session, false);
    }
    let repo_path = normalize_loaded_project_path(&session.repo_path);
    let changed = repo_path != session.repo_path;
    if changed {
        session.repo_path = repo_path;
    }
    (session, changed)
}

#[cfg(test)]
mod project_path_tests {
    use super::*;
    use acorn_session::{Project, Session, SessionKind};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "acorn-project-path-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn loaded_project_uses_git_root_for_subdirectory_path() {
        let root = unique_temp_dir("project");
        git2::Repository::init(&root).expect("init repo");
        let subdir = root.join("packages").join("web");
        std::fs::create_dir_all(&subdir).expect("create subdir");
        let project = Project::new(subdir, "web".to_string(), 0);

        let (normalized, changed) = normalize_loaded_project(project);

        assert!(changed);
        assert_eq!(normalized.repo_path, root.canonicalize().unwrap());
        assert_eq!(normalized.name, path_basename(&root));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn loaded_project_session_keeps_cwd_but_groups_by_git_root() {
        let root = unique_temp_dir("session");
        git2::Repository::init(&root).expect("init repo");
        let subdir = root.join("packages").join("web");
        std::fs::create_dir_all(&subdir).expect("create subdir");
        let session = Session::new(
            "web".to_string(),
            subdir.clone(),
            subdir.clone(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );

        let (normalized, changed) = normalize_loaded_session(session);

        assert!(changed);
        assert_eq!(normalized.repo_path, root.canonicalize().unwrap());
        assert_eq!(normalized.worktree_path, subdir);
        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(|| NonPanickingStderr)
        .init();

    let app_state = AppState::new();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // Release-only: lets `pnpm run tauri dev` run alongside an installed Acorn.
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
            let hook_app = app.handle().clone();
            let hook_sessions = state.sessions.clone();
            match agent_hooks::AgentHookServer::start_with_handler(move |event| {
                let session_id = event.session_id;
                match agent_hooks::apply_agent_hook_event(&hook_sessions, event) {
                    Ok(status) => {
                        if let Err(err) = persistence::save_sessions(&hook_sessions.list()) {
                            tracing::warn!(error = %err, "agent hook persist status failed");
                        }
                        if let Err(err) = hook_app
                            .emit(agent_hooks::AGENT_HOOK_STATUS_EVENT, session_id.to_string())
                        {
                            tracing::warn!(
                                error = %err,
                                event = agent_hooks::AGENT_HOOK_STATUS_EVENT,
                                "agent hook status emit failed",
                            );
                        }
                        tracing::debug!(%session_id, ?status, "agent hook status applied");
                    }
                    Err(err) => {
                        tracing::warn!(%session_id, error = %err, "agent hook event rejected");
                    }
                }
            }) {
                Ok(server) => {
                    *state.agent_hooks.lock() = Some(std::sync::Arc::new(server));
                }
                Err(err) => {
                    tracing::warn!(error = %err, "agent hook server disabled");
                }
            }
            let (sessions_loaded, sessions_clean) = persistence::load_sessions_with_status()
                .unwrap_or_else(|err| {
                    tracing::warn!("session path resolution failed at boot: {err}");
                    (Vec::new(), false)
                });
            let mut sessions_dirty = false;
            for session in sessions_loaded {
                let (session, changed) = normalize_loaded_session(session);
                sessions_dirty |= changed;
                state.sessions.insert(session);
            }
            let (projects_loaded, projects_clean) = persistence::load_projects_with_status()
                .unwrap_or_else(|err| {
                    tracing::warn!("project path resolution failed at boot: {err}");
                    (Vec::new(), false)
                });
            let mut projects_dirty = false;
            let mut projects_loaded = projects_loaded
                .into_iter()
                .map(|project| {
                    let (project, changed) = normalize_loaded_project(project);
                    projects_dirty |= changed;
                    project
                })
                .collect::<Vec<_>>();
            projects_loaded.sort_by_key(|project| project.position);
            let mut seen_projects = std::collections::HashSet::new();
            for project in projects_loaded {
                if !seen_projects.insert(project.repo_path.clone()) {
                    projects_dirty = true;
                    continue;
                }
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
                if !session.project_scoped {
                    continue;
                }
                let name = session
                    .repo_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("project")
                    .to_string();
                state.projects.ensure(session.repo_path.clone(), name);
            }
            if remove_empty_home_project_mirror(&state) {
                projects_dirty = true;
            }
            if sessions_dirty {
                if let Err(err) = persistence::save_sessions(&state.sessions.list()) {
                    tracing::warn!("failed to persist sessions after project path cleanup: {err}");
                }
            }
            if projects_dirty {
                if let Err(err) = persistence::save_projects(&state.projects.list()) {
                    tracing::warn!("failed to persist projects after project path cleanup: {err}");
                }
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
            } else {
                match persistence::data_dir() {
                    Ok(dir) => {
                        if let Err(err) = acorn_session::scrollback::prune_orphans(&dir, &live_ids)
                        {
                            tracing::warn!("scrollback prune at boot failed: {err}");
                        }
                    }
                    Err(err) => {
                        tracing::warn!("scrollback prune at boot: data_dir failed: {err}");
                    }
                }
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
            // `Contents/MacOS/acornd`; in `pnpm run tauri dev` it sits
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
            let state_for_boot = state.inner().clone();
            let app_for_boot = app.handle().clone();
            std::thread::Builder::new()
                .name("acorn-daemon-boot".into())
                .spawn(move || {
                    if !bridge_for_boot.is_enabled() {
                        return;
                    }
                    if let Err(err) = bridge_for_boot.ensure_connection() {
                        tracing::warn!(error = %err, "daemon boot spawn failed");
                        return;
                    }
                    // Detect stale daemon sessions (older `shell-init/`
                    // bodies); the reconcile caches its verdict on
                    // AppState so the frontend prompt survives a
                    // listener-mount-after-emit race.
                    staged_rev_reconcile::reconcile(
                        &app_for_boot,
                        &state_for_boot,
                        &bridge_for_boot,
                    );
                })
                .ok();

            // Watcher that mirrors live agent transcripts into per-session
            // `claude.id` / `codex.id` / `antigravity.id` files. The focus-time resume modal
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
            commands::session_title_readiness,
            commands::generate_session_title,
            commands::preview_session_title,
            commands::list_projects,
            commands::add_project,
            commands::create_new_project,
            commands::remove_project,
            commands::get_project_settings,
            commands::update_project_settings,
            commands::reorder_projects,
            commands::reorder_sessions,
            commands::list_commits,
            commands::list_staged,
            commands::commit_diff,
            commands::commit_web_url,
            commands::github_origin_slug,
            commands::is_git_repository,
            commands::open_in_editor,
            commands::staged_diff,
            commands::staged_file_diff,
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
            commands::pty_subscribe_output,
            commands::pty_unsubscribe_output,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_reload_shell_env,
            commands::pty_cwd,
            commands::pty_repo_root,
            commands::pty_in_worktree_all,
            commands::is_path_linked_worktree,
            commands::linked_worktree_root,
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
            token_usage::get_agent_token_usage,
            commands::get_memory_usage,
            commands::get_acorn_ipc_status,
            commands::warm_macos_folder_permissions,
            commands::reset_macos_folder_permissions,
            commands::ipc_restart,
            commands::list_system_fonts,
            commands::list_agent_history,
            commands::list_unscoped_agent_history,
            commands::trash_agent_history_transcript,
            commands::get_claude_resume_candidate,
            commands::acknowledge_claude_resume,
            commands::get_codex_resume_candidate,
            commands::acknowledge_codex_resume,
            commands::get_antigravity_resume_candidate,
            commands::acknowledge_antigravity_resume,
            commands::staged_rev_mismatch_status,
            commands::acknowledge_staged_rev_mismatch,
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
            fs_explorer::fs_list_dir,
            fs_explorer::fs_rename,
            fs_explorer::fs_trash,
            fs_explorer::fs_reveal,
            fs_explorer::fs_open_default,
            fs_explorer::fs_shell_editor,
            fs_explorer::fs_git_status,
            fs_explorer::fs_git_branch,
            fs_explorer::fs_file_exists,
            fs_explorer::fs_read_file,
            fs_explorer::fs_git_diff_stats,
            fs_explorer::fs_git_diff_lines,
            fs_explorer::fs_watch_set_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
