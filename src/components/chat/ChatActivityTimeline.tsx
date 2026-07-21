import {
  Brain,
  Check,
  ChevronDown,
  CircleX,
  FilePenLine,
  ListChecks,
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

function ActivityStatusMark({ status }: { status: ChatActivityStatus }) {
  if (status === "running") {
    return (
      <span
        aria-label="Running"
        className="relative flex size-4 items-center justify-center rounded-full bg-bg-elevated ring-1 ring-accent/30"
        role="img"
      >
        <span
          aria-hidden="true"
          className="absolute size-2 rounded-full bg-accent/25 motion-safe:animate-ping"
        />
        <span
          aria-hidden="true"
          className="relative size-1.5 rounded-full bg-accent"
        />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-bg-elevated ring-1 ring-danger/25">
        <CircleX aria-label="Failed" className="text-danger" size={10} />
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-bg-elevated ring-1 ring-border/75">
        <X aria-label="Cancelled" className="text-fg-muted" size={10} />
      </span>
    );
  }
  return (
    <span className="flex size-4 items-center justify-center rounded-full bg-bg-elevated ring-1 ring-border/75">
      <Check aria-label="Complete" className="text-success/85" size={10} />
    </span>
  );
}

function activitySummary(activities: ChatActivity[], isRunning: boolean) {
  const active = [...activities]
    .reverse()
    .find((activity) => activity.status === "running");
  if (isRunning && active) return `Working · ${active.title}`;
  const stepCount = `${activities.length} ${
    activities.length === 1 ? "step" : "steps"
  }`;
  if (isRunning) return `Working through ${stepCount}`;
  const failed = activities.filter(
    (activity) => activity.status === "error",
  ).length;
  if (failed > 0) {
    return `${stepCount} · ${failed} ${
      failed === 1 ? "needs" : "need"
    } attention`;
  }
  if (activities.some((activity) => activity.status === "cancelled")) {
    return `${stepCount} · paused`;
  }
  return `Worked through ${stepCount}`;
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
    <section className="min-w-0" data-chat-activity-timeline>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} agent activity`}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] leading-4 text-fg-muted transition-[background-color,color,transform] hover:bg-fill hover:text-fg active:translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/55"
        data-chat-activity-toggle
        onClick={() => setExpanded((value) => !value)}
      >
        {isRunning ? (
          <span
            aria-hidden="true"
            className="relative flex size-4 shrink-0 items-center justify-center"
          >
            <span className="absolute size-2.5 rounded-full bg-accent/20 motion-safe:animate-ping" />
            <span className="relative size-1.5 rounded-full bg-accent" />
          </span>
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
        <span
          aria-live="polite"
          className="min-w-0 flex-1 truncate"
          data-chat-activity-summary
        >
          {activitySummary(activities, isRunning)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`shrink-0 text-fg-muted/70 transition-transform duration-200 group-hover:text-fg ${expanded ? "rotate-180" : ""}`}
          size={12}
        />
      </button>
      {expanded ? (
        <ol
          className="relative ml-4 mt-1 space-y-0.5 border-l border-border/55 pb-1 pl-3"
          data-chat-activity-list
        >
          {activities.map((activity) => {
            const Icon = ACTIVITY_ICONS[activity.kind];
            const detailIsCode =
              activity.kind === "command" || activity.kind === "file_change";
            return (
              <li
                key={activity.id}
                className={`relative rounded-lg px-2 py-1.5 transition-colors ${
                  activity.status === "running"
                    ? "bg-accent/[0.06]"
                    : "hover:bg-fill/70"
                }`}
                data-chat-activity-item
                data-chat-activity-kind={activity.kind}
                data-chat-activity-status={activity.status}
              >
                <span className="absolute -left-[1.31rem] top-1.5">
                  <ActivityStatusMark status={activity.status} />
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Icon
                      aria-hidden="true"
                      className="shrink-0 text-fg-muted/70"
                      size={12}
                    />
                    <span className="truncate text-[11px] font-medium leading-4 text-fg/90">
                      {activity.title}
                    </span>
                  </div>
                  {activity.detail ? (
                    <div
                      className={`acorn-selectable max-h-36 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-4 text-fg-muted/90 ${
                        detailIsCode
                          ? "mt-1 rounded-md bg-fill px-2 py-1 font-mono"
                          : "mt-0.5 pl-[18px]"
                      }`}
                      data-chat-activity-detail
                    >
                      {activity.detail}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
