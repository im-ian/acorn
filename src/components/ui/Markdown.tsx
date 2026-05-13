import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "../../lib/cn";
import { ImageLightbox } from "../ImageLightbox";

// Sanitize schema for PR/comment markdown bodies — they routinely embed raw
// HTML (image uploads, GitHub's `<img width="…">` snippets, details/summary).
// Extend the rehype default with the attrs GitHub commonly uses.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "src",
      "alt",
      "title",
      "width",
      "height",
      "loading",
    ],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      "href",
      "title",
      "target",
      "rel",
    ],
    input: [
      ...(defaultSchema.attributes?.input ?? []),
      // Stamped by `rehypeTaskIndex` below so the React input component can
      // map a click back to its source-order checkbox.
      "dataTaskIndex",
    ],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details",
    "summary",
  ],
};

// Walks the HAST tree once (outside React's render cycle, so immune to
// StrictMode double-invocation) and stamps each task-list checkbox input
// with a `data-task-index` attribute reflecting its source-order position.
// Runs after `rehypeRaw` (whose tree-rebuild strips positions) and before
// `rehypeSanitize`, which is configured above to allow the data attr.
function rehypeTaskIndex() {
  return (tree: { children?: unknown[]; [k: string]: unknown }) => {
    let i = 0;
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as {
        type?: string;
        tagName?: string;
        properties?: Record<string, unknown>;
        children?: unknown[];
      };
      if (
        n.type === "element" &&
        n.tagName === "input" &&
        n.properties?.type === "checkbox"
      ) {
        n.properties = { ...n.properties, dataTaskIndex: i++ };
      }
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

interface MarkdownProps {
  content: string;
  className?: string;
  /**
   * Optional handler invoked when a GFM task-list checkbox is toggled.
   * The `index` is the zero-based position of the checkbox in source order
   * — so the caller can update the underlying body by toggling the Nth
   * `- [ ]` / `- [x]` marker. Providing this prop also enables the checkbox
   * (default rendering is read-only).
   */
  onTaskToggle?: (index: number, checked: boolean) => void;
}

const baseComponents: Components = {
  a({ href, children, ...rest }) {
    return (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href) void openUrl(href);
        }}
        className="text-accent underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  },
  p({ children }) {
    return <p className="my-2 first:mt-0 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return (
      <h1 className="mt-3 mb-2 text-sm font-semibold tracking-tight text-fg">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mt-3 mb-2 text-[13px] font-semibold tracking-tight text-fg">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mt-3 mb-1 text-xs font-semibold tracking-tight text-fg">
        {children}
      </h3>
    );
  },
  h4({ children }) {
    return (
      <h4 className="mt-2 mb-1 text-xs font-semibold tracking-tight text-fg">
        {children}
      </h4>
    );
  },
  ul({ children }) {
    return <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-fg-muted">
        {children}
      </blockquote>
    );
  },
  code({ className, children, ...rest }) {
    const inline = !className?.startsWith("language-");
    if (inline) {
      return (
        <code
          {...rest}
          className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[10.5px] text-fg"
        >
          {children}
        </code>
      );
    }
    return (
      <code {...rest} className={cn("font-mono text-[11px]", className)}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return (
      <pre className="my-2 overflow-x-auto rounded border border-border bg-bg-elevated p-2 font-mono text-[11px] leading-relaxed text-fg">
        {children}
      </pre>
    );
  },
  hr() {
    return <hr className="my-3 border-border" />;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-bg-elevated/60">{children}</thead>;
  },
  th({ children, style }) {
    return (
      <th
        style={style}
        className="border border-border px-2 py-1 text-left font-medium text-fg"
      >
        {children}
      </th>
    );
  },
  td({ children, style }) {
    return (
      <td
        style={style}
        className="border border-border px-2 py-1 align-top text-fg"
      >
        {children}
      </td>
    );
  },
  // img is overridden per-instance in MarkdownImpl so it can hook into the
  // lightbox state. The input renderer is overridden too when `onTaskToggle`
  // is supplied, so this is just the read-only fallback.
  input({ type, checked, disabled }) {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={!!checked}
          disabled={disabled ?? true}
          readOnly
          className="mr-1 align-middle accent-accent"
        />
      );
    }
    return null;
  },
};

function MarkdownImpl({ content, className, onTaskToggle }: MarkdownProps) {
  const [lightbox, setLightbox] = useState<
    { src: string; alt?: string } | null
  >(null);

  const components = useMemo<Components>(
    () => ({
      ...baseComponents,
      img({ src, alt, width, height }) {
        const url = typeof src === "string" ? src : undefined;
        return (
          <img
            src={url}
            alt={alt ?? ""}
            width={width}
            height={height}
            loading="lazy"
            onClick={() => {
              if (!url) return;
              setLightbox({ src: url, alt: alt ?? undefined });
            }}
            className="my-2 max-w-full cursor-zoom-in rounded border border-border transition hover:opacity-90"
          />
        );
      },
      input(props) {
        const { type, checked, disabled } = props;
        if (type !== "checkbox") return null;
        if (!onTaskToggle) {
          return (
            <input
              type="checkbox"
              checked={!!checked}
              disabled={disabled ?? true}
              readOnly
              className="mr-1 align-middle accent-accent"
            />
          );
        }
        // `rehypeTaskIndex` stamps this on each checkbox input during the
        // HAST tree walk — a single-pass numbering that survives StrictMode's
        // double-invocation of the React renderer.
        const indexRaw = (props as { "data-task-index"?: unknown })[
          "data-task-index"
        ];
        const index =
          typeof indexRaw === "number"
            ? indexRaw
            : typeof indexRaw === "string"
              ? Number(indexRaw)
              : -1;
        return (
          <input
            type="checkbox"
            checked={!!checked}
            onChange={(e) => {
              if (!Number.isFinite(index) || index < 0) return;
              onTaskToggle(index, e.currentTarget.checked);
            }}
            className="mr-1 cursor-pointer align-middle accent-accent"
          />
        );
      },
    }),
    [onTaskToggle],
  );

  return (
    <>
      <div className={cn("text-[11.5px] leading-relaxed text-fg", className)}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[
            rehypeRaw,
            rehypeTaskIndex,
            [rehypeSanitize, sanitizeSchema],
          ]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
      <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}

export const Markdown = memo(MarkdownImpl);
