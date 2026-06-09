// Runs in the page context via Playwright's addInitScript.
// Stands up a fake `window.__TAURI_INTERNALS__` so the React app boots in a
// regular Chromium tab without a Tauri runtime. Tests register per-command
// handlers on `window.__ACORN_MOCK_HANDLERS__`; anything unhandled falls
// back to a safe default chosen to keep the UI from crashing.

export const tauriMockSource = `
(() => {
  if (window.__ACORN_MOCK_INSTALLED__) return;
  window.__ACORN_MOCK_INSTALLED__ = true;

  const handlers = window.__ACORN_MOCK_HANDLERS__ || {};
  let nextCallbackId = 0;
  const standardPrGenerationPrompt = 'Use a standard GitHub-style pull request merge message.\\n- First line: Conventional Commit subject when the type is clear, e.g. feat(scope): concise summary. Keep it imperative/present tense and <=72 chars.\\n- Body: 1-2 concise paragraphs explaining why the change matters, user-visible impact, and key implementation notes when useful.\\n- Keep the wording specific to the PR. Avoid boilerplate, markdown headings, labels, and prompt explanations.';

  function chatState(sessionId, provider, messages) {
    const now = '2026-01-01T00:00:00Z';
    return {
      schema_version: 1,
      session_id: sessionId || '',
      session: {
        id: sessionId || '',
        workspace_path: null,
        title: null,
        active_provider: provider || null,
        active_model: null,
        created_at: now,
        updated_at: now,
      },
      provider: provider || null,
      model: null,
      messages: messages || [],
      turns: [],
      provider_threads: [],
      context_snapshots: [],
      memory: {
        session_id: sessionId || '',
        summary: null,
        important_decisions: [],
        facts: [],
        through_message_id: null,
        updated_at: now,
      },
      created_at: now,
      updated_at: now,
    };
  }

  function pluginDefault(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(nextCallbackId++);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve(undefined);
    if (cmd === 'plugin:event|emit') return Promise.resolve(undefined);
    if (cmd === 'plugin:app|version') return Promise.resolve('0.0.0-test');
    if (cmd === 'plugin:app|name') return Promise.resolve('acorn');
    if (cmd === 'plugin:updater|check') return Promise.resolve(null);
    if (cmd === 'plugin:notification|is_permission_granted') return Promise.resolve(true);
    if (cmd === 'plugin:notification|request_permission') return Promise.resolve('granted');
    if (cmd === 'plugin:notification|notify') return Promise.resolve(undefined);
    if (cmd === 'plugin:window|destroy') return Promise.resolve(undefined);
    if (cmd === 'plugin:window|close') return Promise.resolve(undefined);
    if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
    if (cmd === 'plugin:path|resolve_directory') return Promise.resolve('/Users/tester');
    if (cmd === 'plugin:path|app_local_data_dir') return Promise.resolve('/tmp/acorn-e2e');
    if (cmd === 'plugin:path|join') {
      const paths = Array.isArray(args?.paths) ? args.paths : [];
      return Promise.resolve(paths.join('/').replace(/\\/+/g, '/'));
    }
    if (cmd === 'plugin:fs|exists') return Promise.resolve(false);
    if (cmd === 'plugin:fs|mkdir') return Promise.resolve(undefined);
    if (cmd === 'plugin:fs|read_dir') return Promise.resolve([]);
    if (cmd === 'plugin:fs|read_text_file') return Promise.resolve('');
    return undefined;
  }

  function appDefault(cmd, args) {
    if (cmd === 'load_status') {
      return Promise.resolve({ sessionsClean: true, projectsClean: true });
    }
    if (cmd === 'list_sessions') return Promise.resolve([]);
    if (cmd === 'list_projects') return Promise.resolve([]);
    if (cmd === 'add_project') {
      return Promise.resolve({
        repo_path: '/tmp/picked',
        name: 'picked',
        created_at: '2026-01-01T00:00:00Z',
        position: 0,
      });
    }
    if (cmd === 'select_project_parent_folder') {
      return Promise.resolve('/tmp');
    }
    if (cmd === 'create_session_from_dialog') {
      return Promise.resolve(null);
    }
    if (cmd === 'get_project_settings') {
      return Promise.resolve({
        key: 'path:' + (args?.repoPath || '/tmp/project'),
        settings: {
          remember_after_close: true,
          pull_requests: { generation_prompt: standardPrGenerationPrompt },
        },
      });
    }
    if (cmd === 'update_project_settings') {
      return Promise.resolve({
        key: 'path:' + (args?.repoPath || '/tmp/project'),
        settings: args?.settings || {
          remember_after_close: true,
          pull_requests: { generation_prompt: standardPrGenerationPrompt },
        },
      });
    }
    if (cmd === 'create_new_project') {
      const name = args && typeof args.name === 'string' ? args.name : 'new-project';
      const parentPath = args && typeof args.parentPath === 'string' ? args.parentPath : '/tmp';
      return Promise.resolve({
        repo_path: parentPath + '/' + name,
        name,
        created_at: '2026-01-01T00:00:00Z',
        position: 0,
      });
    }
    if (cmd === 'detect_session_statuses') return Promise.resolve([]);
    if (cmd === 'session_title_readiness') {
      return Promise.resolve({ status: 'skipped', session: {} });
    }
    if (cmd === 'generate_session_title') {
      return Promise.resolve({ status: 'skipped', session: {} });
    }
    if (cmd === 'load_chat_session_state') {
      return Promise.resolve(chatState(args?.sessionId, null, []));
    }
    if (cmd === 'save_chat_session_state') {
      return Promise.resolve(args?.chatState || null);
    }
    if (cmd === 'append_chat_message') {
      return Promise.resolve(chatState(args?.sessionId, null, args?.message ? [args.message] : []));
    }
    if (cmd === 'update_chat_message') {
      return Promise.resolve(chatState(args?.sessionId, null, []));
    }
    if (cmd === 'send_chat_message') {
      const now = '2026-01-01T00:00:00Z';
      const provider = args?.ai?.provider || 'claude';
      return Promise.resolve(chatState(args?.sessionId, provider, [
          {
            id: 'mock-user-message',
            session_id: args?.sessionId || '',
            turn_id: 'mock-turn',
            role: 'user',
            content: args?.content || '',
            created_at: now,
            status: 'complete',
            metadata: null,
          },
          {
            id: 'mock-assistant-message',
            session_id: args?.sessionId || '',
            turn_id: 'mock-turn',
            role: 'assistant',
            content: 'Mock ' + provider + ' response',
            created_at: now,
            status: 'complete',
            metadata: { provider, turn_id: 'mock-turn', context_mode: 'compiled_context' },
          },
        ]));
    }
    if (cmd === 'cancel_chat_message') {
      return Promise.resolve(chatState(args?.sessionId, null, []));
    }
    if (cmd === 'retry_chat_message') {
      return Promise.resolve(chatState(args?.sessionId, args?.ai?.provider || 'claude', []));
    }
    if (cmd === 'delete_chat_message') {
      return Promise.resolve(chatState(args?.sessionId, null, []));
    }
    if (cmd === 'detect_session_agent') {
      return Promise.resolve({ claude: null, codex: null, antigravity: null });
    }
    if (cmd === 'prepare_claude_fork') return Promise.resolve(undefined);
    if (cmd === 'read_session_todos') return Promise.resolve([]);
    if (cmd === 'list_commits') return Promise.resolve([]);
    if (cmd === 'resolve_commit_logins') return Promise.resolve({});
    if (cmd === 'list_staged') return Promise.resolve([]);
    if (cmd === 'list_unscoped_agent_history') return Promise.resolve([]);
    if (cmd === 'list_pull_requests') {
      return Promise.resolve({ items: [], account: null, error: null });
    }
    if (cmd === 'get_pull_request_diff') {
      return Promise.resolve({ kind: 'ok', account: 'test', diff: { files: [] } });
    }
    if (cmd === 'list_workflow_runs') {
      return Promise.resolve({ kind: 'not_github' });
    }
    if (cmd === 'get_workflow_run_detail') {
      return Promise.resolve({ kind: 'not_github' });
    }
    // Right panel uses this to decide whether to show the GitHub group.
    // Default to "GitHub repo" so the existing PRs/Actions tabs stay
    // visible across all E2Es; tests that need the not-github branch
    // override this via window.__ACORN_MOCK_HANDLERS__.
    if (cmd === 'github_origin_slug') {
      return Promise.resolve('acorn/test');
    }
    if (cmd === 'is_git_repository') {
      return Promise.resolve(true);
    }
    if (cmd === 'staged_diff') return Promise.resolve({ files: [] });
    if (cmd === 'staged_file_diff') return Promise.resolve({ files: [] });
    if (cmd === 'commit_diff') return Promise.resolve({ files: [] });
    if (cmd === 'scrollback_load') return Promise.resolve(null);
    if (cmd === 'get_memory_usage') {
      return Promise.resolve({
        rss_bytes: 0,
        sessions: [],
        scrollback_disk_bytes: 0,
      });
    }
    if (cmd === 'get_agent_token_usage') {
      return Promise.resolve({
        metrics: [],
        updated_at: 0,
      });
    }
    if (cmd === 'scrollback_orphan_size') return Promise.resolve(0);
    if (cmd === 'scrollback_orphan_clear') return Promise.resolve(0);
    if (cmd === 'get_acorn_ipc_status') {
      return Promise.resolve({
        bundled_path: '',
        bundled_exists: false,
        socket_path: '',
        server_running: false,
        shim_paths: [],
      });
    }
    if (cmd === 'warm_macos_folder_permissions') return Promise.resolve([]);
    if (cmd === 'reset_macos_folder_permissions') return Promise.resolve([]);
    if (cmd === 'ipc_restart') return Promise.resolve(undefined);
    if (cmd === 'reorder_projects') return Promise.resolve([]);
    if (cmd === 'reorder_sessions') return Promise.resolve([]);
    // No live PTYs in E2E so the live-cwd map is empty and the static
    // session flags (isolated, in_worktree) drive the worktree icon.
    if (cmd === 'pty_in_worktree_all') return Promise.resolve({});
    if (cmd === 'is_path_linked_worktree') return Promise.resolve(false);
    // Daemon-mode commands. E2E runs in-browser without a real acornd
    // bound to a socket, so every routed call short-circuits with a
    // realistic "disabled / not-running" response. Tests that need to
    // assert daemon-mode UI override these via window.__ACORN_MOCK_HANDLERS__.
    if (cmd === 'daemon_status') {
      return Promise.resolve({
        running: false,
        enabled: false,
        daemon_version: null,
        uptime_seconds: null,
        session_count_total: null,
        session_count_alive: null,
        log_path: null,
        last_error: null,
      });
    }
    if (cmd === 'daemon_set_enabled') return Promise.resolve(undefined);
    if (cmd === 'daemon_restart') return Promise.resolve(undefined);
    if (cmd === 'daemon_shutdown') return Promise.resolve(undefined);
    if (cmd === 'daemon_list_sessions') return Promise.resolve([]);
    if (cmd === 'daemon_spawn_session') {
      return Promise.reject(new Error('daemon disabled in E2E'));
    }
    if (cmd === 'daemon_send_input') return Promise.resolve(undefined);
    if (cmd === 'daemon_resize') return Promise.resolve(undefined);
    if (cmd === 'daemon_kill_session') return Promise.resolve(undefined);
    if (cmd === 'daemon_forget_session') return Promise.resolve(undefined);
    if (cmd === 'daemon_forget_inactive_sessions') return Promise.resolve(0);
    if (cmd === 'daemon_adopt_session') return Promise.resolve(undefined);
    // Resume modal probes every session focus for all session agents.
    // Default to "no candidate" so non-resume E2Es never see the modal;
    // tests that exercise the modal override this via __ACORN_MOCK_HANDLERS__.
    if (cmd === 'get_claude_resume_candidate') return Promise.resolve(null);
    if (cmd === 'get_codex_resume_candidate') return Promise.resolve(null);
    if (cmd === 'get_antigravity_resume_candidate') return Promise.resolve(null);
    if (cmd === 'acknowledge_claude_resume') return Promise.resolve(undefined);
    if (cmd === 'acknowledge_codex_resume') return Promise.resolve(undefined);
    if (cmd === 'acknowledge_antigravity_resume') return Promise.resolve(undefined);
    // Staged-rev mismatch is the daemon-stale prompt at boot. Default to
    // "no mismatch" so non-related E2Es never see the modal; tests that
    // exercise it override via __ACORN_MOCK_HANDLERS__.
    if (cmd === 'staged_rev_mismatch_status') return Promise.resolve(null);
    if (cmd === 'acknowledge_staged_rev_mismatch')
      return Promise.resolve(undefined);
    if (cmd === 'prevent_sleep_status') {
      return Promise.resolve({ supported: true, enabled: false });
    }
    if (cmd === 'set_prevent_sleep') {
      return Promise.resolve({ supported: true, enabled: !!args?.enabled });
    }
    if (cmd === 'pty_write') return Promise.resolve(undefined);
    // File explorer. No real fs in E2E — default to an empty listing so
    // the panel renders without errors. Tests that need real entries
    // override these via window.__ACORN_MOCK_HANDLERS__.
    if (cmd === 'fs_list_dir') {
      return Promise.resolve({ entries: [], repo_root: null });
    }
    if (cmd === 'fs_rename') return Promise.resolve(undefined);
    if (cmd === 'fs_trash') return Promise.resolve(undefined);
    if (cmd === 'fs_reveal') return Promise.resolve(undefined);
    if (cmd === 'fs_open_default') return Promise.resolve(undefined);
    if (cmd === 'fs_shell_editor') return Promise.resolve('');
    if (cmd === 'fs_git_status') return Promise.resolve({ statuses: {}, huge: false, limit: 10000 });
    if (cmd === 'fs_git_branch') return Promise.resolve('');
    if (cmd === 'fs_file_exists') return Promise.resolve(false);
    if (cmd === 'fs_grant_external_file') return Promise.resolve(undefined);
    if (cmd === 'fs_read_file') {
      return Promise.resolve({ content: '', size: 0, truncated: false, binary: false });
    }
    if (cmd === 'fs_prepare_asset') return Promise.resolve({ size: 0 });
    if (cmd === 'fs_git_diff_lines') return Promise.resolve([]);
    if (cmd === 'fs_watch_set_root') return Promise.resolve(undefined);
    if (cmd && cmd.startsWith('list_')) return Promise.resolve([]);
    return Promise.resolve(null);
  }

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    transformCallback: (callback, once) => {
      const id = nextCallbackId++;
      const key = '_' + id;
      window[key] = (...args) => {
        if (once) {
          try { delete window[key]; } catch (_) { window[key] = undefined; }
        }
        if (callback) callback(...args);
      };
      return id;
    },
    unregisterCallback: (id) => {
      try { delete window['_' + id]; } catch (_) { window['_' + id] = undefined; }
    },
    convertFileSrc: (filePath, protocol = 'asset') => {
      const path = encodeURIComponent(filePath);
      if (protocol === 'asset') {
        const lower = String(filePath).toLowerCase();
        if (/\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/.test(lower)) {
          return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==#' + path;
        }
        return 'about:blank#' + path;
      }
      return protocol + '://localhost/' + path;
    },
    invoke: async (cmd, args) => {
      const handler = handlers[cmd];
      if (handler) {
        try {
          return await handler(args);
        } catch (err) {
          return Promise.reject(err);
        }
      }
      const plugin = pluginDefault(cmd, args);
      if (plugin !== undefined) return plugin;
      return appDefault(cmd, args);
    },
  };

  // The event plugin in @tauri-apps/api 2.x calls into this global on unlisten.
  // Without it, every \`listen()\` cleanup throws and noisy errors bury real ones.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };

  window.__ACORN_MOCK_HANDLERS__ = handlers;
  window.__ACORN_TEST_MODE__ = true;
})();
`;
