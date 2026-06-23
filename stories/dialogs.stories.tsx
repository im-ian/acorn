import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClosePullRequestDialog } from "../src/components/ClosePullRequestDialog";
import { MemoryBreakdownModal } from "../src/components/MemoryBreakdownModal";
import { MergePullRequestDialog } from "../src/components/MergePullRequestDialog";
import { RemoveProjectDialog } from "../src/components/RemoveProjectDialog";
import { RemoveProjectFolderDialog } from "../src/components/RemoveProjectFolderDialog";
import { RemoveSessionDialog } from "../src/components/RemoveSessionDialog";
import { WhatsNewModal } from "../src/components/WhatsNewModal";
import type { ProjectFolder } from "../src/lib/projectFolders";
import type {
  MemoryProcess,
  Project,
  PullRequestDetail,
  Session,
} from "../src/lib/types";

const meta = {
  title: "Components/Dialogs",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="h-screen bg-bg p-8 text-fg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const project: Project = {
  repo_path: "/Users/acorn/workspace",
  name: "Acorn",
  created_at: "2026-06-11T00:00:00Z",
  position: 0,
};

const baseSession: Session = {
  id: "session-1",
  name: "storybook-setup",
  repo_path: project.repo_path,
  worktree_path: "/Users/acorn/workspace/.acorn/worktrees/storybook-setup",
  branch: "storybook/setup",
  isolated: true,
  project_scoped: true,
  status: "running",
  created_at: "2026-06-11T00:00:00Z",
  updated_at: "2026-06-11T00:00:00Z",
  last_message: "Adding component stories",
  title_source: "manual",
  kind: "regular",
  mode: "terminal",
  owner: { kind: "user" },
  position: 0,
  in_worktree: true,
  agent_provider: "codex",
  agent_transcript_id: null,
};

const folder: ProjectFolder = {
  id: "folder-1",
  repoPath: project.repo_path,
  name: "Storybook work",
  cwdPath: "/Users/acorn/workspace",
  position: 0,
};

const processes: MemoryProcess[] = [
  {
    pid: 1000,
    parent_pid: null,
    name: "Acorn",
    command_line: "/Applications/Acorn.app/Contents/MacOS/acorn",
    bytes: 180_000_000,
    depth: 0,
  },
  {
    pid: 1001,
    parent_pid: 1000,
    name: "node",
    command_line: "node ./node_modules/.bin/vite",
    bytes: 92_000_000,
    depth: 1,
  },
  {
    pid: 1002,
    parent_pid: 1000,
    name: "acornd",
    command_line: "acornd --profile dev",
    bytes: 48_000_000,
    depth: 1,
  },
];

const pullRequestDetail: PullRequestDetail = {
  number: 483,
  title: "feat(ui): floating card layout and control polish",
  body: "Refresh workspace chrome and shared UI primitives.",
  state: "OPEN",
  is_draft: false,
  author: "im-ian",
  head_branch: "feat/ui-floating-card-polish",
  base_branch: "main",
  url: "https://github.com/im-ian/acorn/pull/483",
  created_at: "2026-06-22T00:00:00Z",
  updated_at: "2026-06-23T00:00:00Z",
  merged_at: null,
  additions: 340,
  deletions: 210,
  changed_files: 18,
  mergeable: "MERGEABLE",
  labels: [{ name: "feat", color: "0E8A16" }],
  comments: [],
  reviews: [],
  checks: [
    {
      name: "Frontend",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      started_at: "2026-06-23T02:23:13Z",
      completed_at: "2026-06-23T02:24:44Z",
      url: null,
      workflow_name: "CI",
    },
    {
      name: "E2E",
      status: "IN_PROGRESS",
      conclusion: null,
      started_at: "2026-06-23T02:23:14Z",
      completed_at: null,
      url: null,
      workflow_name: "CI",
    },
  ],
  commits: [],
};

export const RemoveSession: Story = {
  render: () => (
    <RemoveSessionDialog
      session={baseSession}
      canDeleteWorktree
      onClose={() => undefined}
    />
  ),
};

export const RemoveProject: Story = {
  render: () => (
    <RemoveProjectDialog
      project={project}
      sessions={[baseSession, { ...baseSession, id: "session-2", isolated: false }]}
      onClose={() => undefined}
    />
  ),
};

export const RemoveProjectFolder: Story = {
  render: () => (
    <RemoveProjectFolderDialog
      folder={folder}
      sessions={[baseSession]}
      onClose={() => undefined}
    />
  ),
};

export const MemoryBreakdown: Story = {
  render: () => (
    <MemoryBreakdownModal
      open
      totalBytes={processes.reduce((sum, process) => sum + process.bytes, 0)}
      processes={processes}
      onClose={() => undefined}
    />
  ),
};

export const ClosePullRequestLoading: Story = {
  render: () => (
    <ClosePullRequestDialog
      open
      repoPath={project.repo_path}
      number={pullRequestDetail.number}
      detail={null}
      loading
      onClose={() => undefined}
      onClosed={() => undefined}
    />
  ),
};

export const ClosePullRequestError: Story = {
  render: () => (
    <ClosePullRequestDialog
      open
      repoPath={project.repo_path}
      number={pullRequestDetail.number}
      detail={null}
      loadError="GitHub releases request failed: 403"
      onClose={() => undefined}
      onClosed={() => undefined}
    />
  ),
};

export const ClosePullRequestConfirm: Story = {
  render: () => (
    <ClosePullRequestDialog
      open
      repoPath={project.repo_path}
      detail={pullRequestDetail}
      onClose={() => undefined}
      onClosed={() => undefined}
    />
  ),
};

export const MergePullRequestLoading: Story = {
  render: () => (
    <MergePullRequestDialog
      open
      repoPath={project.repo_path}
      number={pullRequestDetail.number}
      detail={null}
      loading
      onClose={() => undefined}
      onMerged={() => undefined}
    />
  ),
};

export const MergePullRequestError: Story = {
  render: () => (
    <MergePullRequestDialog
      open
      repoPath={project.repo_path}
      number={pullRequestDetail.number}
      detail={null}
      loadError="Unable to load pull request details."
      onClose={() => undefined}
      onMerged={() => undefined}
    />
  ),
};

export const WhatsNew: Story = {
  render: () => (
    <WhatsNewModal
      open
      version="1.15.0"
      currentVersion="1.14.0"
      body={[
        "## Summary",
        "",
        "- Added Storybook for component review.",
        "- Kept the production app build path unchanged.",
        "",
        "```sh",
        "pnpm run storybook",
        "```",
      ].join("\n")}
      showInstall
      onClose={() => undefined}
      onInstall={() => undefined}
    />
  ),
};

export const WhatsNewLoading: Story = {
  render: () => (
    <WhatsNewModal
      open
      version="1.18.1"
      currentVersion="1.18.0"
      body=""
      loading
      onClose={() => undefined}
    />
  ),
};

export const WhatsNewError: Story = {
  render: () => (
    <WhatsNewModal
      open
      version="1.18.1"
      currentVersion="1.18.0"
      body=""
      error="GitHub releases request failed: 403"
      onClose={() => undefined}
    />
  ),
};
