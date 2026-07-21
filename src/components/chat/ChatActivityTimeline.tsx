import {
  Brain,
  Check,
  ChevronDown,
  CircleX,
  FilePenLine,
  ListChecks,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ChatActivity,
  ChatActivityKind,
  ChatActivityStatus,
} from "../../lib/types";

interface ChatActivityTimelineProps {
  activities: ChatActivity[];
  isRunning: boolean;
}

const ACTIVITY_ICONS: Record<ChatActivityKind, LucideIcon> = {
  reasoning: Brain,
  tool: Wrench,
  command: Terminal,
  file_change: FilePenLine,
  web_search: Search,
  plan: ListChecks,
};

function ActivityStatusIcon({ status }: { status: ChatActivityStatus }) {
  if (status === "running") {
    return (
      <LoaderCircle
        aria-label="Running"
        className="animate-spin text-accent"
        size={12}
      />
    );
  }
  if (status === "error") {
    return <CircleX aria-label="Failed" className="text-danger" size={12} />;
  }
  if (status === "cancelled") {
    return <X aria-label="Cancelled" className="text-fg-muted" size={12} />;
  }
  return <Check aria-label="Complete" className="text-success" size={12} />;
}

function activitySummary(activities: ChatActivity[], isRunning: boolean) {
  const active = [...activities]
    .reverse()
    .find((activity) => activity.status === "running");
  if (isRunning && active) return active.title;
  const failed = activities.filter(
    (activity) => activity.status === "error",
  ).length;
  const count = `${activities.length} ${
    activities.length === 1 ? "activity" : "activities"
  }`;
  if (failed > 0) return `${count} · ${failed} failed`;
  return count;
}

export function ChatActivityTimeline({
  activities,
  isRunning,
}: ChatActivityTimelineProps) {
  const [expanded, setExpanded] = useState(isRunning);
  const wasRunning = useRef(isRunning);

  useEffect(() => {
    if (isRunning) {
      setExpanded(true);
    } else if (wasRunning.current) {
      setExpanded(false);
    }
    wasRunning.current = isRunning;
  }, [isRunning]);

  if (activities.length === 0) return null;

  const hasError = activities.some((activity) => activity.status === "error");
  const hasCancelled = activities.some(
    (activity) => activity.status === "cancelled",
  );

  return (
    <section
      className="min-w-[16rem] overflow-hidden rounded-md border border-border/80 bg-bg-sidebar/45"
      data-chat-activity-timeline
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} agent activity`}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs text-fg-muted transition hover:bg-bg-sidebar/70 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
        data-chat-activity-toggle
        onClick={() => setExpanded((value) => !value)}
      >
        {isRunning ? (
          <LoaderCircle
            aria-hidden="true"
            className="shrink-0 animate-spin text-accent"
            size={13}
          />
        ) : hasError ? (
          <CircleX
            aria-hidden="true"
            className="shrink-0 text-danger"
            size={13}
          />
        ) : hasCancelled ? (
          <X
            aria-hidden="true"
            className="shrink-0 text-fg-muted/75"
            size={13}
          />
        ) : (
          <Check
            aria-hidden="true"
            className="shrink-0 text-fg-muted/75"
            size={13}
          />
        )}
        <span className="min-w-0 flex-1 truncate">
          {activitySummary(activities, isRunning)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          size={13}
        />
      </button>
      {expanded ? (
        <ol
          className="border-t border-border/70 px-2.5 py-1.5"
          data-chat-activity-list
        >
          {activities.map((activity) => {
            const Icon = ACTIVITY_ICONS[activity.kind];
            const detailIsCode =
              activity.kind === "command" || activity.kind === "file_change";
            return (
              <li
                key={activity.id}
                className="grid grid-cols-[14px_minmax(0,1fr)_14px] gap-x-2 border-b border-border/45 py-2 last:border-b-0"
                data-chat-activity-item
                data-chat-activity-kind={activity.kind}
                data-chat-activity-status={activity.status}
              >
                <Icon
                  aria-hidden="true"
                  className="mt-0.5 text-fg-muted"
                  size={13}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium leading-4 text-fg/90">
                    {activity.title}
                  </div>
                  {activity.detail ? (
                    <div
                      className={`acorn-selectable mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-4 text-fg-muted ${
                        detailIsCode ? "font-mono" : ""
                      }`}
                      data-chat-activity-detail
                    >
                      {activity.detail}
                    </div>
                  ) : null}
                </div>
                <span className="mt-0.5 flex justify-end">
                  <ActivityStatusIcon status={activity.status} />
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
