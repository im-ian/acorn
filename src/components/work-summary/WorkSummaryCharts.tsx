import { cn } from "../../lib/cn";
import type { TranslationKey, Translator } from "../../lib/i18n";
import {
  tokenUsageDelta,
  type WorkSummaryKindCounts,
  type WorkSummaryTokenUsage,
} from "../../lib/workSummary";

type WorkSummaryTranslationKey = Extract<
  TranslationKey,
  `workSummary.${string}`
>;

function wt(t: Translator, key: WorkSummaryTranslationKey): string {
  return t(key);
}

function wtf(
  t: Translator,
  key: WorkSummaryTranslationKey,
  values: Record<string, string | number>,
): string {
  return wt(t, key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

export function TokenUsageChart({
  tokens,
  baseline,
  t,
}: {
  tokens: WorkSummaryTokenUsage;
  baseline?: WorkSummaryTokenUsage & { capturedAt: string };
  t: Translator;
}) {
  const delta = tokenUsageDelta(tokens, baseline);
  const rows = [
    {
      label: wt(t, "workSummary.tokens.input"),
      value: tokens.inputTokens,
      className: "bg-sky-400",
    },
    {
      label: wt(t, "workSummary.tokens.output"),
      value: tokens.outputTokens,
      className: "bg-emerald-400",
    },
    {
      label: wt(t, "workSummary.tokens.cache"),
      value: tokens.cacheReadTokens + tokens.cacheCreationTokens,
      className: "bg-amber-400",
    },
    {
      label: wt(t, "workSummary.tokens.reasoning"),
      value: tokens.reasoningTokens,
      className: "bg-violet-400",
    },
  ].filter((row) => row.value > 0);
  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-lg tabular-nums">
            {formatNumber(tokens.totalTokens)}
          </div>
          <div className="text-[11px] text-fg-muted">
            {wtf(t, "workSummary.tokens.fromMessages", {
              count: tokens.messagesWithUsage,
            })}
          </div>
        </div>
      </div>
      {baseline ? (
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-border bg-border">
          <TokenBaselineCell
            label={wt(t, "workSummary.tokens.sessionUsed")}
            value={formatNumber(tokens.totalTokens)}
          />
          <TokenBaselineCell
            label={wt(t, "workSummary.tokens.summaryStart")}
            value={formatNumber(baseline.totalTokens)}
          />
          <TokenBaselineCell
            label={wt(t, "workSummary.tokens.sinceSummary")}
            value={`+${formatNumber(delta.totalTokens)}`}
          />
        </div>
      ) : null}
      <div className="space-y-2">
        {rows.map((row) => (
          <ChartRow
            key={row.label}
            label={row.label}
            value={formatNumber(row.value)}
            width={(row.value / max) * 100}
            className={row.className}
          />
        ))}
      </div>
    </div>
  );
}

function TokenBaselineCell({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 bg-bg px-2 py-2">
      <div className="truncate text-[10px] uppercase text-fg-muted">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-xs tabular-nums">
        {value}
      </div>
    </div>
  );
}

export function FileStatusChart({
  counts,
  total,
  t,
}: {
  counts: WorkSummaryKindCounts;
  total: number;
  t: Translator;
}) {
  const rows = (Object.keys(counts) as Array<keyof WorkSummaryKindCounts>)
    .filter((kind) => kind !== "clean" && counts[kind] > 0)
    .map((kind) => ({
      label: wt(t, `workSummary.status.${kind}`),
      value: counts[kind],
      className:
        kind === "added"
          ? "bg-emerald-400"
          : kind === "deleted"
            ? "bg-rose-400"
            : kind === "conflicted"
              ? "bg-danger"
              : kind === "renamed"
                ? "bg-sky-400"
                : "bg-amber-400",
    }));

  return (
    <div className="space-y-2 px-4 py-3">
      {rows.map((row) => (
        <ChartRow
          key={row.label}
          label={row.label}
          value={String(row.value)}
          width={(row.value / total) * 100}
          className={row.className}
        />
      ))}
    </div>
  );
}

function ChartRow({
  label,
  value,
  width,
  className,
}: {
  label: string;
  value: string;
  width: number;
  className: string;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-[11px]">
      <span className="truncate text-fg-muted">{label}</span>
      <div className="h-2 overflow-hidden rounded bg-bg-elevated">
        <div
          className={cn("h-full rounded", className)}
          style={{ width: `${Math.max(4, Math.min(100, width))}%` }}
        />
      </div>
      <span className="text-right font-mono tabular-nums">{value}</span>
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}
