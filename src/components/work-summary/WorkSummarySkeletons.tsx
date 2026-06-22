import { cn } from "../../lib/cn";

export function MetricValueSkeleton() {
  return <SkeletonBlock className="h-5 w-24 bg-fg-muted/15" />;
}

export function ChangedFilesSkeleton() {
  return (
    <div
      className="space-y-0.5 p-1"
      data-work-summary-section-skeleton="files"
    >
      {[0, 1, 2, 3, 4].map((idx) => (
        <div
          key={idx}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <SkeletonBlock className="h-5 w-10 bg-fg-muted/15" />
            <SkeletonBlock
              className={cn(
                "h-3 min-w-0 bg-fg-muted/10",
                idx % 3 === 0 ? "w-52" : idx % 3 === 1 ? "w-72" : "w-40",
              )}
            />
          </div>
          <SkeletonBlock className="h-3 w-16 bg-fg-muted/10" />
        </div>
      ))}
    </div>
  );
}

export function ConversationSkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-2 p-3"
      data-work-summary-section-skeleton="conversation"
    >
      {Array.from({ length: 4 }).map((_, idx) => (
        <div key={idx} className="rounded-md bg-bg-sidebar/40 px-3 py-2">
          <SkeletonBlock className="h-2.5 w-20 bg-fg-muted/10" />
          <SkeletonBlock className="mt-2 h-4 w-10 bg-fg-muted/15" />
        </div>
      ))}
    </div>
  );
}

export function TokenUsageSkeleton() {
  return (
    <div
      className="space-y-3 px-4 py-3"
      data-work-summary-section-skeleton="tokens"
    >
      <SkeletonBlock className="h-5 w-24 bg-fg-muted/15" />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((idx) => (
          <SkeletonChartRow key={idx} />
        ))}
      </div>
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div
      className="space-y-2 px-4 py-3"
      data-work-summary-section-skeleton="charts"
    >
      {[0, 1, 2].map((idx) => (
        <SkeletonChartRow key={idx} />
      ))}
    </div>
  );
}

function SkeletonChartRow() {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-2">
      <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/10" />
      <SkeletonBlock className="h-2 w-full bg-fg-muted/10" />
      <SkeletonBlock className="h-2.5 w-10 bg-fg-muted/10" />
    </div>
  );
}

function SkeletonBlock({ className }: { className: string }) {
  return (
    <span
      className={cn("block animate-pulse rounded bg-fg-muted/10", className)}
    />
  );
}
