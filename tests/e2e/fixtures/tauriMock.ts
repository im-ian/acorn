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

  function pluginDefault(cmd) {
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
    return undefined;
  }

  function appDefault(cmd) {
    if (cmd === 'list_sessions') return Promise.resolve([]);
    if (cmd === 'list_projects') return Promise.resolve([]);
    if (cmd === 'detect_session_statuses') return Promise.resolve([]);
    if (cmd === 'detect_session_agent') {
      return Promise.resolve({ claude: null, codex: null });
    }
    if (cmd === 'prepare_claude_fork') return Promise.resolve(undefined);
    if (cmd === 'read_session_todos') return Promise.resolve([]);
    if (cmd === 'list_commits') return Promise.resolve([]);
    if (cmd === 'resolve_commit_logins') return Promise.resolve({});
    if (cmd === 'list_staged') return Promise.resolve([]);
    if (cmd === 'list_pull_requests') {
      return Promise.resolve({ items: [], account: null, error: null });
    }
    if (cmd === 'staged_diff') return Promise.resolve({ files: [] });
    if (cmd === 'commit_diff') return Promise.resolve({ files: [] });
    if (cmd === 'scrollback_load') return Promise.resolve(null);
    if (cmd === 'get_memory_usage') {
      return Promise.resolve({
        rss_bytes: 0,
        sessions: [],
        scrollback_disk_bytes: 0,
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
    invoke: async (cmd, args) => {
      const handler = handlers[cmd];
      if (handler) {
        try {
          return await handler(args);
        } catch (err) {
          return Promise.reject(err);
        }
      }
      const plugin = pluginDefault(cmd);
      if (plugin !== undefined) return plugin;
      return appDefault(cmd);
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
