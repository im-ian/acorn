import { ChevronDown, MessageSquare } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

interface StickyUserPromptProps {
  sessionId: string;
}

// Custom event the Terminal dispatches whenever its buffer changes shape
// in a way the banner cares about (new PTY output, scroll, clear). The
// banner is a pure consumer here — no polling, no backend round-trip.
// Detection happens against xterm's rendered buffer so a Cmd+K clear
// implicitly empties the banner (the buffer has no prompt rows to find).
const CONTEXT_PROMPT_EVENT = "acorn:context-prompt";

interface ContextPromptDetail {
  sessionId: string;
  /** Most recent prompt-marker line at-or-above the topmost-visible row. */
  prompt: string | null;
}

const EXPANDED_MAX_HEIGHT_PX = 160;

export function StickyUserPrompt({
  sessionId,
}: StickyUserPromptProps): ReactElement | null {
  const [prompt, setPrompt] = useState<string | null>(null);
  // Compact by default so a freshly-arrived prompt never pushes an
  // outsized panel over the terminal. Clicking the row (or the chevron)
  // toggles expanded; a new prompt resets the toggle.
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    setPrompt(null);
    setCollapsed(true);
    const onContext = (event: Event) => {
      const detail = (event as CustomEvent<ContextPromptDetail>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      setPrompt((prev) => {
        // Only reset the collapsed state when the prompt's first line
        // changes — claude's TUI repaints the prompt area on every
        // assistant chunk, which produced micro-diffs that kept
        // flipping `collapsed` back to true the instant the user
        // expanded. The first line is stable across those redraws
        // because it carries the marker + user-typed head.
        const prevHead = (prev ?? "").split("\n", 1)[0];
        const nextHead = (detail.prompt ?? "").split("\n", 1)[0];
        if (prev !== null && prevHead !== nextHead) {
          setCollapsed(true);
        }
        return detail.prompt;
      });
    };
    window.addEventListener(CONTEXT_PROMPT_EVENT, onContext);
    return () => {
      window.removeEventListener(CONTEXT_PROMPT_EVENT, onContext);
    };
  }, [sessionId]);

  if (!prompt) return null;
  // Heuristic for "is there anything to expand?" — we collect
  // continuation rows in the scanner and join them with `\n`, so any
  // newline means hidden content under the 1-line clamp. Length-based
  // checks are unreliable across font widths / CJK, so we keep this to
  // the unambiguous signal.
  const expandable = prompt.includes("\n");

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10"
      data-acorn-sticky-prompt
    >
      <div
        // The whole row toggles collapsed/expanded ONLY when there's
        // actually a second line to reveal. For single-line prompts the
        // row stays passive — no cursor change, no click handler, no
        // chevron — so the affordance reflects the real state.
        className={`pointer-events-auto border-b border-border bg-bg-elevated/95 px-3 py-2 text-xs leading-snug text-fg shadow-[0_2px_8px_rgba(0,0,0,0.35)] backdrop-blur-sm transition-colors ${
          expandable ? "cursor-pointer hover:bg-bg-elevated" : ""
        }`}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? !collapsed : undefined}
        aria-label={
          expandable
            ? collapsed
              ? "Expand pinned prompt"
              : "Collapse pinned prompt"
            : undefined
        }
        onClick={expandable ? () => setCollapsed((c) => !c) : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setCollapsed((c) => !c);
                }
              }
            : undefined
        }
      >
        <div className="flex items-start gap-2">
          <span
            className="flex h-[16.5px] shrink-0 items-center text-fg-muted"
            aria-hidden
          >
            <MessageSquare size={12} />
          </span>
          <div
            className="min-w-0 flex-1 whitespace-pre-wrap break-words"
            style={
              collapsed
                ? {
                    display: "-webkit-box",
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }
                : {
                    // Explicit `display: block` overrides the lingering
                    // `-webkit-box` that the collapsed style set last
                    // render — WebKit otherwise sometimes retains the
                    // single-line layout on toggle until reflow.
                    display: "block",
                    WebkitLineClamp: "unset",
                    WebkitBoxOrient: "horizontal",
                    maxHeight: EXPANDED_MAX_HEIGHT_PX,
                    overflowY: "auto",
                    paddingRight: 4,
                  }
            }
          >
            {prompt}
          </div>
          {expandable ? (
            <span
              className="flex h-[16.5px] shrink-0 items-center text-fg-muted"
              aria-hidden
            >
              <ChevronDown
                size={12}
                className={`transition-transform ${
                  collapsed ? "" : "rotate-180"
                }`}
              />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
