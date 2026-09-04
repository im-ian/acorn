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
  let nextEventListenerId = 0;
  const eventListeners = new Map();
  const graphRuns = new Map();
  const standardPrGenerationPrompt = 'Use a standard GitHub-style pull request merge message.\\n- First line: Conventional Commit subject when the type is clear, e.g. feat(scope): concise summary. Keep it imperative/present tense and <=72 chars.\\n- Body: 1-2 concise paragraphs explaining why the change matters, user-visible impact, and key implementation notes when useful.\\n- Keep the wording specific to the PR. Avoid boilerplate, markdown headings, labels, and prompt explanations.';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function emitTauriEvent(event, payload) {
    const listeners = eventListeners.get(event);
    if (!listeners) return;
    for (const [id, handler] of listeners) {
      const callback = window['_' + handler];
      if (typeof callback === 'function') callback({ event, id, payload: clone(payload) });
    }
  }

  window.__ACORN_EMIT_TAURI_EVENT__ = emitTauriEvent;

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
    if (cmd === 'plugin:event|listen') {
      const id = nextEventListenerId++;
      const event = args?.event || '';
      const listeners = eventListeners.get(event) || new Map();
      listeners.set(id, args?.handler);
      eventListeners.set(event, listeners);
      return Promise.resolve(id);
    }
    if (cmd === 'plugin:event|unlisten') {
      const event = args?.event || '';
      const id = args?.eventId ?? args?.event_id ?? args?.id;
      eventListeners.get(event)?.delete(id);
      return Promise.resolve(undefined);
    }
    if (cmd === 'plugin:event|emit') return Promise.resolve(undefined);
    if (cmd === 'plugin:app|version') return Promise.resolve('0.0.0-test');
    if (cmd === 'plugin:app|name') return Promise.resolve('acorn');
    if (cmd === 'plugin:updater|check') return Promise.resolve(null);
    if (cmd === 'plugin:updater|download_and_install') return Promise.resolve(undefined);
    if (cmd === 'plugin:process|restart') return Promise.resolve(undefined);
    if (cmd === 'plugin:notification|is_permission_granted') return Promise.resolve(true);
    if (cmd === 'plugin:notification|request_permission') return Promise.resolve('granted');
    if (cmd === 'plugin:notification|notify') return Promise.resolve(undefined);
    if (cmd === 'plugin:clipboard-manager|write_text') return Promise.resolve(undefined);
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
    if (cmd === 'plugin:fs|lstat') {
      return Promise.resolve({
        isFile: false,
        isDirectory: true,
        isSymlink: false,
        size: 0,
        mtime: null,
        atime: null,
        birthtime: null,
        readonly: false,
        fileAttributes: null,
        dev: null,
        ino: null,
        mode: null,
        nlink: null,
        uid: null,
        gid: null,
        rdev: null,
        blksize: null,
        blocks: null,
      });
    }
    if (cmd === 'plugin:fs|stat') {
      return Promise.resolve({
        isFile: true,
        isDirectory: false,
        isSymlink: false,
        size: 0,
        mtime: null,
        atime: null,
        birthtime: null,
        readonly: false,
        fileAttributes: null,
        dev: null,
        ino: null,
        mode: null,
        nlink: null,
        uid: null,
        gid: null,
        rdev: null,
        blksize: null,
        blocks: null,
      });
    }
    return undefined;
  }

  function appDefault(cmd, args) {
    if (cmd === 'load_status') {
      return Promise.resolve({ sessionsClean: true, projectsClean: true });
    }
    if (cmd === 'list_sessions') return Promise.resolve([]);
    if (cmd === 'list_projects') return Promise.resolve([]);
    if (cmd === 'pick_project_folder') {
      return Promise.resolve({
        path: '/tmp/picked',
        name: 'picked',
        ownerName: null,
      });
    }
    if (cmd === 'add_project_at') {
      return Promise.resolve({
        repo_path: '/tmp/picked',
        name: args?.name ?? 'picked',
        created_at: '2026-01-01T00:00:00Z',
        position: 0,
        source_paths: (args?.roots ?? []).slice(1),
      });
    }
    if (cmd === 'add_project_source') return Promise.resolve(null);
    if (cmd === 'remove_project_source') {
      return Promise.resolve({
        repo_path: args?.repoPath ?? '/tmp/picked',
        name: 'picked',
        created_at: '2026-01-01T00:00:00Z',
        position: 0,
        source_paths: [],
      });
    }
    if (cmd === 'reorder_project_sources') {
      return Promise.resolve({
        repo_path: args?.repoPath ?? '/tmp/picked',
        name: 'picked',
        created_at: '2026-01-01T00:00:00Z',
        position: 0,
        source_paths: (args?.order ?? []).filter(
          (path) => path !== args?.repoPath,
        ),
      });
    }
    if (cmd === 'select_project_parent_folder') {
      return Promise.resolve('/tmp');
    }
    if (cmd === 'get_last_project_parent_folder') {
      return Promise.resolve(null);
    }
    if (cmd === 'has_git_identity') {
      return Promise.resolve(true);
    }
    if (cmd === 'create_session_from_dialog') {
      return Promise.resolve(null);
    }
    if (cmd === 'update_session_goal') {
      return Promise.resolve({
        id: args?.id || '',
        goal: {
          ...(args?.goal || {}),
          revision: Number(args?.expectedRevision || 0) + 1,
        },
      });
    }
    if (cmd === 'update_session_graph') {
      return Promise.resolve({
        id: args?.id || '',
        graph: {
          ...(args?.graph || {}),
          revision: Number(args?.expectedRevision || 0) + 1,
        },
      });
    }
    if (cmd === 'get_goal_agent_capabilities') {
      const provider = args?.provider === 'claude' ? 'claude' : 'codex';
      if (provider === 'claude') {
        return Promise.resolve({
          provider,
          installed: true,
          version: '2.0.0-test (Claude Code)',
          source: 'claude_cli_help',
          models: [
            {
              id: 'default',
              label: 'Default',
              description: 'Claude Code model alias',
              is_default: true,
              default_effort: null,
              supported_efforts: [{ id: 'low' }, { id: 'high' }],
            },
            {
              id: 'sonnet',
              label: 'Sonnet',
              description: 'Claude Code model alias',
              is_default: false,
              default_effort: null,
              supported_efforts: [{ id: 'low' }, { id: 'high' }],
            },
          ],
          effort_options: [{ id: 'low' }, { id: 'high' }],
          warning: null,
        });
      }
      return Promise.resolve({
        provider,
        installed: true,
        version: 'codex-cli 0.0.0-test',
        source: 'codex_app_server',
        models: [
          {
            id: 'gpt-test-default',
            label: 'GPT Test Default',
            description: 'Default test coding model',
            is_default: true,
            default_effort: 'low',
            supported_efforts: [
              { id: 'low', description: 'Fast' },
              { id: 'ultra', description: 'Delegates' },
            ],
          },
        ],
        effort_options: [{ id: 'low' }, { id: 'ultra' }],
        warning: null,
      });
    }
    if (cmd === 'get_project_settings') {
      return Promise.resolve({
        key: 'path:' + (args?.repoPath || '/tmp/project'),
        settings: {
          remember_after_close: true,
          pull_requests: { generation_prompt: standardPrGenerationPrompt },
          worktrees: { base_branch: null },
          start_work: { agent_prompt: null },
        },
      });
    }
    if (cmd === 'update_project_settings') {
      return Promise.resolve({
        key: 'path:' + (args?.repoPath || '/tmp/project'),
        settings: args?.settings || {
          remember_after_close: true,
          pull_requests: { generation_prompt: standardPrGenerationPrompt },
          worktrees: { base_branch: null },
          start_work: { agent_prompt: null },
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
    if (cmd === 'load_graph_run_state') {
      return Promise.resolve(clone(graphRuns.get(args?.sessionId) || null));
    }
    if (cmd === 'agent_transcript_summary') {
      return Promise.resolve(null);
    }
    if (cmd === 'agent_transcript_summary_at_path') {
      return Promise.resolve(null);
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
            graph_prompt_plan: args?.graphPromptPlan || null,
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
    if (cmd === 'run_graph_session') {
      const now = '2026-01-01T00:00:00Z';
      const state = {
        schema_version: 1,
        session_id: args?.sessionId || '',
        run_id: 'mock-graph-run',
        revision: 1,
        graph_revision: 1,
        objective: 'Graph objective',
        agent: { provider: 'claude' },
        status: 'completed',
        definition: {
          version: 2,
          execution_mode: 'sequential',
          nodes: [
            { id: 'agent-1', kind: 'agent', title: 'Agent', instruction: 'Complete the task.' },
            { id: 'goal', kind: 'goal_sink', title: 'GOAL', instruction: '' },
          ],
          edges: [{ id: 'agent-goal', from: 'agent-1', to: 'goal' }],
          groups: [],
        },
        nodes: {
          'agent-1': {
            node_id: 'agent-1',
            status: 'completed',
            attempt: 1,
            output: 'Mock graph result',
            started_at: now,
            completed_at: now,
          },
          goal: {
            node_id: 'goal',
            status: 'completed',
            attempt: 0,
            output: 'Mock graph result',
            started_at: now,
            completed_at: now,
          },
        },
        edges: {
          'agent-goal': {
            edge_id: 'agent-goal',
            active: false,
            traversed: true,
            retry_count: 0,
          },
        },
        started_at: now,
        updated_at: now,
        completed_at: now,
        final_output: 'Mock graph result',
      };
      graphRuns.set(state.session_id, state);
      emitTauriEvent('acorn:graph-run-state-changed', {
        session_id: state.session_id,
        state,
      });
      return Promise.resolve(clone(state));
    }
    if (cmd === 'submit_graph_node_input') {
      const current = graphRuns.get(args?.sessionId);
      if (!current || current.run_id !== args?.runId) {
        return Promise.reject('Graph run state not found');
      }
      if (current.revision !== args?.expectedRevision) {
        return Promise.reject('Graph run changed before Human input was submitted');
      }
      const now = '2026-01-01T00:00:10Z';
      const next = {
        ...current,
        revision: current.revision + 1,
        status: 'completed',
        updated_at: now,
        completed_at: now,
        final_output: args?.input || 'Mock Human input',
      };
      graphRuns.set(next.session_id, next);
      emitTauriEvent('acorn:graph-run-state-changed', {
        session_id: next.session_id,
        state: next,
      });
      return Promise.resolve(clone(next));
    }
    if (cmd === 'cancel_graph_run') {
      const current = graphRuns.get(args?.sessionId);
      if (!current || current.run_id !== args?.runId) {
        return Promise.reject('Graph run state not found');
      }
      if (['completed', 'failed', 'cancelled'].includes(current.status)) {
        return Promise.resolve(clone(current));
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        status: 'cancelled',
        updated_at: '2026-01-01T00:00:10Z',
        completed_at: '2026-01-01T00:00:10Z',
        error: 'Graph run cancelled',
      };
      graphRuns.set(next.session_id, next);
      emitTauriEvent('acorn:graph-run-state-changed', {
        session_id: next.session_id,
        state: next,
      });
      return Promise.resolve(clone(next));
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
      return Promise.resolve({
        claude: null,
        codex: null,
        antigravity: null,
        grok: null,
      });
    }
    if (cmd === 'prepare_claude_fork') return Promise.resolve(undefined);
    if (cmd === 'read_session_todos') return Promise.resolve([]);
    if (cmd === 'list_commits') return Promise.resolve([]);
    if (cmd === 'resolve_commit_logins') return Promise.resolve({});
    if (cmd === 'list_staged') return Promise.resolve([]);
    if (cmd === 'list_unscoped_agent_history') return Promise.resolve([]);
    if (cmd === 'list_pull_requests') {
      return Promise.resolve({ kind: 'ok', items: [], account: 'test' });
    }
    if (cmd === 'list_issues') {
      return Promise.resolve({ kind: 'ok', items: [], account: 'test' });
    }
    if (cmd === 'get_issue_detail') {
      return Promise.resolve({ kind: 'not_github' });
    }
    if (cmd === 'add_issue_comment') {
      return Promise.resolve(undefined);
    }
    if (cmd === 'update_github_comment') {
      return Promise.resolve(undefined);
    }
    if (cmd === 'delete_github_comment') {
      return Promise.resolve(undefined);
    }
    if (cmd === 'add_pull_request_comment') {
      return Promise.resolve(undefined);
    }
    if (cmd === 'change_pull_request_state') {
      return Promise.resolve(undefined);
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
    if (cmd === 'load_diff_images') return Promise.resolve({});
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
    if (cmd === 'reset_macos_developer_permissions') return Promise.resolve([]);
    if (cmd === 'ipc_restart') return Promise.resolve(undefined);
    if (cmd === 'reorder_projects') return Promise.resolve([]);
    if (cmd === 'reorder_sessions') return Promise.resolve([]);
    // No live PTYs in E2E so the live-cwd map is empty and the static
    // session flags (isolated, in_worktree) drive the worktree icon.
    if (cmd === 'pty_in_worktree_all') return Promise.resolve({});
    if (cmd === 'is_path_linked_worktree') return Promise.resolve(false);
    if (cmd === 'list_project_worktrees') return Promise.resolve([]);
    if (cmd === 'ensure_project_worktree_for_branch') {
      const repoPath = args?.repoPath || '/tmp/demo';
      const nameHint = args?.nameHint || 'worktree';
      return Promise.resolve({
        path: repoPath + '/.acorn/worktrees/' + nameHint,
        branch: args?.branch || 'main',
        created: true,
      });
    }
    if (cmd === 'list_project_branches') return Promise.resolve([]);
    if (cmd === 'remove_session' || cmd === 'remove_worktree') {
      return Promise.resolve({
        result: null,
        removedSessionIds: [],
        issues: [],
        retryToken: null,
      });
    }
    if (cmd === 'remove_project') {
      return Promise.resolve({
        result: [],
        removedSessionIds: [],
        issues: [],
        retryToken: null,
      });
    }
    if (cmd === 'retry_removal_cleanup') {
      return Promise.resolve({
        result: [],
        removedSessionIds: [],
        issues: [],
        retryToken: null,
      });
    }
    if (cmd === 'discard_removal_retry') return Promise.resolve(undefined);
    if (cmd === 'restore_removed_worktree') return Promise.resolve(undefined);
    if (cmd === 'discard_removed_worktree') return Promise.resolve(undefined);
    if (cmd === 'restore_removed_session') return Promise.resolve(undefined);
    if (cmd === 'discard_removed_session') return Promise.resolve(undefined);
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
    if (cmd === 'daemon_kill_session') return Promise.resolve(undefined);
    if (cmd === 'daemon_forget_session') return Promise.resolve(undefined);
    if (cmd === 'daemon_forget_inactive_sessions') return Promise.resolve(0);
    if (cmd === 'daemon_adopt_session') return Promise.resolve(undefined);
    // Resume modal probes every session focus for all session agents.
    // Default to "no candidate" so non-resume E2Es never see the modal;
    // tests that exercise the modal override this via __ACORN_MOCK_HANDLERS__.
    if (cmd === 'get_agent_resume_candidate') return Promise.resolve(null);
    if (cmd === 'acknowledge_agent_resume') return Promise.resolve(undefined);
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
    if (cmd === 'fs_git_diff_stats') return Promise.resolve({});
    if (cmd === 'fs_git_branch') return Promise.resolve('');
    if (cmd === 'fs_file_exists') return Promise.resolve(false);
    if (cmd === 'fs_grant_external_file') return Promise.resolve(undefined);
    if (cmd === 'fs_read_file') {
      return Promise.resolve({ content: '', size: 0, truncated: false, binary: false });
    }
    if (cmd === 'fs_prepare_asset') {
      const path = args?.path ?? '';
      return Promise.resolve({
        size: 0,
        asset_path: path,
        capability: 'e2e-asset-capability',
      });
    }
    if (cmd === 'fs_release_asset') return Promise.resolve(undefined);
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
