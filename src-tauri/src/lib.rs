mod agent_capabilities;
mod agent_history;
mod agent_hooks;
mod agent_resume;
mod agent_resume_persister;
mod agent_wrappers;
mod ai;
mod chat_runs;
mod cli_resolver;
mod clipboard;
mod commands;
mod daemon_bridge;
mod daemon_commands;
mod daemon_stream;
mod error;
mod fs_explorer;
mod git_ops;
mod ipc;
mod persistence;
mod power_assertion;
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

const MAIN_WINDOW_LABEL: &str = "main";

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

fn reveal_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = app.show() {
        tracing::warn!(error = %err, "failed to show application");
    }

    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == MAIN_WINDOW_LABEL)
                .or_else(|| app.config().app.windows.first())
            else {
                tracing::warn!("failed to recreate main window: no window config");
                return;
            };
            match tauri::WebviewWindowBuilder::from_config(app, config)
                .and_then(|builder| builder.build())
            {
                Ok(window) => window,
                Err(err) => {
                    tracing::warn!(error = %err, "failed to recreate main window");
                    return;
                }
            }
        }
    };

    if let Err(err) = window.unminimize() {
        tracing::warn!(error = %err, "failed to unminimize main window");
    }
    if let Err(err) = window.show() {
        tracing::warn!(error = %err, "failed to show main window");
    }
    if let Err(err) = window.set_focus() {
        tracing::warn!(error = %err, "failed to focus main window");
    }
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
            reveal_main_window(app);
        }));
    }
    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            #[cfg(target_os = "macos")]
            let paste_item = MenuItemBuilder::new("Paste")
                .id("paste")
                .accelerator("CmdOrCtrl+V")
                .build(app)?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy();
            #[cfg(target_os = "macos")]
            let edit_submenu = edit_submenu.item(&paste_item);
            #[cfg(not(target_os = "macos"))]
            let edit_submenu = edit_submenu.paste();
            let edit_submenu = edit_submenu.select_all().build()?;
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
                if event.id() == "paste" {
                    if let Err(err) = handle.emit("acorn:paste", ()) {
                        tracing::warn!("failed to emit paste: {err}");
                    }
                }
                #[cfg(debug_assertions)]
                if event.id() == "reload" {
                    if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                        if let Err(err) = window.eval("window.location.reload()") {
                            tracing::warn!("failed to reload webview: {err}");
                        }
                    }
                }
            });

            let state = app.state::<AppState>();
            // Do not expose the previous app instance's dead endpoint while
            // session ownership is being restored.
            agent_wrappers::remove_agent_hook_endpoint();
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
                if let Err(err) = persistence::save_sessions(&state.sessions) {
                    tracing::warn!("failed to persist sessions after project path cleanup: {err}");
                }
            }
            if projects_dirty {
                if let Err(err) = persistence::save_projects(&state.projects.list()) {
                    tracing::warn!("failed to persist projects after project path cleanup: {err}");
                }
            }
            let hook_app = app.handle().clone();
            let hook_sessions = state.sessions.clone();
            let hook_reducer = std::sync::Arc::new(agent_hooks::AgentHookReducer::new(
                hook_sessions.clone(),
            ));
            let hook_handler: std::sync::Arc<
                dyn Fn(agent_hooks::AgentHookEvent) -> agent_hooks::AgentHookHandlerOutcome
                    + Send
                    + Sync,
            > = std::sync::Arc::new(move |event: agent_hooks::AgentHookEvent| {
                let session_id = event.session_id;
                let provider = event.provider;
                let source = event.source.clone();
                let lifecycle_id = event.lifecycle_id.clone();
                let provider_session_id = event.provider_session_id.clone();
                let provider_turn_id = event.provider_turn_id.clone();
                let provider_tool_id = event.provider_tool_id.clone();
                let provider_version = event.provider_version.clone();
                let native_hooks_enabled = event.native_hooks_enabled;
                let ownership = event.ownership;
                let status = match hook_reducer.apply(event) {
                    Ok(agent_hooks::AgentHookApplyOutcome::Applied(status)) => status,
                    Ok(agent_hooks::AgentHookApplyOutcome::Ignored { status, reason }) => {
                        tracing::debug!(
                            %session_id,
                            ?provider,
                            ?source,
                            ?lifecycle_id,
                            ?provider_session_id,
                            ?provider_turn_id,
                            ?provider_tool_id,
                            ?provider_version,
                            ?native_hooks_enabled,
                            ?ownership,
                            ?status,
                            reason,
                            "agent hook observation ignored",
                        );
                        return agent_hooks::AgentHookHandlerOutcome::Ignored;
                    }
                    Err(agent_hooks::AgentHookApplyError::Unavailable(err)) => {
                        tracing::warn!(
                            %session_id,
                            ?provider,
                            ?source,
                            ?lifecycle_id,
                            ?provider_session_id,
                            ?provider_turn_id,
                            ?provider_tool_id,
                            ?provider_version,
                            ?native_hooks_enabled,
                            ?ownership,
                            error = %err,
                            "agent hook session unavailable",
                        );
                        return agent_hooks::AgentHookHandlerOutcome::Unavailable;
                    }
                    Err(agent_hooks::AgentHookApplyError::Conflict(err)) => {
                        tracing::warn!(
                            %session_id,
                            ?provider,
                            ?source,
                            ?lifecycle_id,
                            ?provider_session_id,
                            ?provider_turn_id,
                            ?provider_tool_id,
                            ?provider_version,
                            ?native_hooks_enabled,
                            ?ownership,
                            error = %err,
                            "agent hook event rejected",
                        );
                        return agent_hooks::AgentHookHandlerOutcome::Conflict;
                    }
                };
                // Claude names the active conversation directly. Bind that
                // provider-owned identifier without applying transcript mtime
                // heuristics; the PTY-tree scan remains the fallback and
                // multi-process arbiter when hooks are unavailable.
                if provider == acorn_session::SessionAgentProvider::Claude {
                    if let Some(claude_uuid) = provider_session_id
                        .as_deref()
                        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                    {
                        if let Err(err) = agent_resume_persister::bind_provider_session_marker(
                            session_id,
                            acorn_agent::AgentKind::Claude,
                            claude_uuid,
                        ) {
                            tracing::warn!(
                                %session_id,
                                claude_uuid,
                                error = %err,
                                "claude hook transcript bind failed",
                            );
                        }
                    }
                }
                if let Err(err) = persistence::save_sessions(&hook_sessions) {
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
                tracing::debug!(
                    %session_id,
                    ?provider,
                    ?source,
                    ?lifecycle_id,
                    ?provider_session_id,
                    ?provider_turn_id,
                    ?provider_tool_id,
                    ?provider_version,
                    ?native_hooks_enabled,
                    ?ownership,
                    ?status,
                    "agent hook status applied",
                );
                agent_hooks::AgentHookHandlerOutcome::Applied
            });
            // Drain events the notify scripts spooled while no app instance
            // was listening. Runs before the hook server starts, so no live
            // POST can interleave with the replay; anything spooled after
            // this scan is picked up on the next boot.
            match agent_wrappers::agent_hook_spool_dir() {
                Ok(spool_dir) => {
                    let replay_handler = hook_handler.clone();
                    let replayed = agent_hooks::replay_spooled_hook_events(
                        &spool_dir,
                        move |event| replay_handler(event),
                    );
                    if replayed > 0 {
                        tracing::info!(replayed, "replayed spooled agent hook events");
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, "agent hook spool dir unavailable");
                }
            }
            let server_handler = hook_handler.clone();
            match agent_hooks::AgentHookServer::start_with_outcome_handler(move |event| {
                server_handler(event)
            }) {
                Ok(server) => {
                    // Publish only after normalized sessions and backfilled
                    // projects are durable, so a surviving PTY cannot race a
                    // valid event against partially restored startup state.
                    if let Err(err) = agent_wrappers::write_agent_hook_endpoint(
                        server.hook_url(),
                        server.token(),
                    ) {
                        tracing::warn!(
                            error = %err,
                            "agent hook endpoint publish failed; sessions surviving a restart will lose hook status updates",
                        );
                    }
                    *state.agent_hooks.lock() = Some(std::sync::Arc::new(server));
                }
                Err(err) => {
                    agent_wrappers::remove_agent_hook_endpoint();
                    tracing::warn!(error = %err, "agent hook server disabled");
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
            commands::create_session_from_dialog,
            commands::remove_session,
            commands::set_session_status,
            commands::update_session_goal,
            commands::rename_session,
            commands::session_title_readiness,
            commands::generate_session_title,
            commands::preview_session_title,
            commands::load_chat_session_state,
            commands::save_chat_session_state,
            commands::append_chat_message,
            commands::update_chat_message,
            commands::get_goal_agent_capabilities,
            commands::run_goal_session,
            commands::send_chat_message,
            commands::retry_chat_message,
            commands::delete_chat_message,
            commands::cancel_chat_message,
            commands::list_projects,
            commands::add_project,
            commands::select_project_parent_folder,
            commands::get_last_project_parent_folder,
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
            commands::load_diff_images,
            commands::list_pull_requests,
            commands::list_issues,
            commands::get_issue_detail,
            commands::add_issue_comment,
            commands::update_github_comment,
            commands::delete_github_comment,
            commands::get_pull_request_detail,
            commands::get_pull_request_diff,
            commands::add_pull_request_comment,
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
            commands::pty_detach,
            commands::pty_reload_shell_env,
            commands::pty_cwd,
            commands::pty_repo_root,
            commands::pty_in_worktree_all,
            commands::is_path_linked_worktree,
            commands::linked_worktree_root,
            commands::update_session_worktree,
            commands::prepare_chat_session_worktree,
            commands::git_worktrees,
            commands::list_project_worktrees,
            commands::remove_worktree,
            commands::restore_removed_worktree,
            commands::discard_removed_worktree,
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
            clipboard::clipboard_snapshot,
            commands::warm_macos_folder_permissions,
            commands::reset_macos_folder_permissions,
            commands::reset_macos_developer_permissions,
            commands::ipc_restart,
            commands::ipc_list_workspaces_response,
            commands::list_system_fonts,
            commands::list_agent_history,
            commands::agent_transcript_summary,
            commands::agent_transcript_summary_at_path,
            commands::list_unscoped_agent_history,
            commands::trash_agent_history_transcript,
            commands::get_agent_resume_candidate,
            commands::acknowledge_agent_resume,
            commands::staged_rev_mismatch_status,
            commands::acknowledge_staged_rev_mismatch,
            power_assertion::prevent_sleep_status,
            power_assertion::set_prevent_sleep,
            daemon_commands::daemon_status,
            daemon_commands::daemon_set_enabled,
            daemon_commands::daemon_restart,
            daemon_commands::daemon_shutdown,
            daemon_commands::daemon_list_sessions,
            daemon_commands::daemon_kill_session,
            daemon_commands::daemon_forget_session,
            daemon_commands::daemon_forget_inactive_sessions,
            daemon_commands::daemon_adopt_session,
            fs_explorer::fs_list_dir,
            fs_explorer::fs_rename,
            fs_explorer::fs_trash,
            fs_explorer::fs_reveal,
            fs_explorer::fs_open_default,
            fs_explorer::fs_shell_editor,
            fs_explorer::fs_git_status,
            fs_explorer::fs_git_branch,
            fs_explorer::fs_grant_external_file,
            fs_explorer::fs_file_exists,
            fs_explorer::fs_read_file,
            fs_explorer::fs_prepare_asset,
            fs_explorer::fs_git_diff_stats,
            fs_explorer::fs_git_diff_lines,
            fs_explorer::fs_watch_set_root,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, _event| {
        #[cfg(target_os = "macos")]
        if matches!(_event, tauri::RunEvent::Reopen { .. }) {
            reveal_main_window(app);
        }
    });
}
