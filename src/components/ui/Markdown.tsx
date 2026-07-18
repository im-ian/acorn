import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "../../lib/cn";
import { ImageLightbox } from "../ImageLightbox";
import { Tooltip } from "../Tooltip";
import { markdownImageUrlTransform, RemoteImage } from "./RemoteImage";

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
    source: [],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      "href",
      "title",
      "target",
      "rel",
    ],
    input: [
      ...(defaultSchema.attributes?.input ?? []),
      // Stamped only on parser-generated GFM tasks by `rehypeTaskIndex` below,
      // so raw HTML checkboxes cannot impersonate an editable task.
      "acornTaskIndex",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [
      ...(defaultSchema.protocols?.src ?? []),
      "data",
      "blob",
      "asset",
    ],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []).filter(
      (tagName) => tagName !== "picture" && tagName !== "source",
    ),
    "details",
    "summary",
  ],
};

// Walks the HAST tree once (outside React's render cycle, so immune to
// StrictMode double-invocation) and stamps each task-list checkbox input
// with an internal task index reflecting its parsed source order.
// Runs before `rehypeRaw`: parser-generated GFM inputs already exist as HAST
// elements, while attacker-authored HTML is still an opaque `raw` node. The
// stamp survives raw-tree rebuilding and is allowlisted by `rehypeSanitize`.
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
        n.properties = { ...n.properties, acornTaskIndex: i++ };
      }
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

interface MarkdownProps {
  content: string;
  className?: string;
  softBreaks?: boolean;
  /**
   * Optional handler invoked when a GFM task-list checkbox is toggled.
   * The `index` is the zero-based position of the checkbox in source order
   * — so the caller can update the underlying body by toggling the Nth
   * `- [ ]` / `- [x]` marker. Providing this prop also enables the checkbox
   * (default rendering is read-only).
   */
  onTaskToggle?: (index: number, checked: boolean) => void;
}

// Markdown bodies come from untrusted sources (PR descriptions, comments).
// rehype-sanitize already strips most schemes from href, but it still admits
// xmpp/irc and the like — gate what we hand to the OS opener to web links
// and mailto so a crafted body can't launch arbitrary scheme handlers.
const SAFE_OPEN_URL_RE = /^(https?:|mailto:)/i;

type MarkdownAstNode = {
  type?: string;
  value?: unknown;
  children?: MarkdownAstNode[];
  [key: string]: unknown;
};

function remarkSoftBreaks() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.flatMap((child) => {
        visit(child);
        if (child.type !== "text" || typeof child.value !== "string") {
          return [child];
        }
        const parts = child.value.split("\n");
        if (parts.length === 1) return [child];
        return parts.flatMap<MarkdownAstNode>((part, index) => {
          const nodes: MarkdownAstNode[] = [];
          if (index > 0) nodes.push({ type: "break" });
          if (part.length > 0) nodes.push({ ...child, value: part });
          return nodes;
        });
      });
    };
    visit(tree);
  };
}

const baseComponents: Components = {
  a({ href, children, title, ...rest }) {
    const link = (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href && SAFE_OPEN_URL_RE.test(href)) void openUrl(href);
        }}
        className="text-accent underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
    return typeof title === "string" && title.length > 0 ? (
      <Tooltip label={title} side="top" multiline>
        {link}
      </Tooltip>
    ) : (
      link
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
          className="mr-1 align-middle acorn-check"
        />
      );
    }
    return null;
  },
};

function MarkdownImpl({
  content,
  className,
  softBreaks = false,
  onTaskToggle,
}: MarkdownProps) {
  const [lightbox, setLightbox] = useState<
    { src: string; alt?: string } | null
  >(null);

  const components = useMemo<Components>(
    () => ({
      ...baseComponents,
      img({ src, alt, title, width, height }) {
        const url = typeof src === "string" ? src : undefined;
        const image = (
          <RemoteImage
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
        return typeof title === "string" && title.length > 0 ? (
          <Tooltip label={title} side="top" multiline>
            {image}
          </Tooltip>
        ) : (
          image
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
              className="mr-1 align-middle acorn-check"
            />
          );
        }
        // `rehypeTaskIndex` stamps only parser-generated GFM checkboxes during
        // the pre-raw HAST walk. Raw HTML checkboxes have no valid index and
        // remain disabled.
        const indexRaw = (props as { acornTaskIndex?: unknown })
          .acornTaskIndex;
        // rehype-sanitize may stringify the generated number. The camelCase
        // HAST-only property is still trustworthy: HTML parsing lowercases an
        // attacker-authored attribute before the sanitizer allowlist runs.
        const index =
          typeof indexRaw === "number"
            ? indexRaw
            : typeof indexRaw === "string"
              ? Number(indexRaw)
              : -1;
        const isEditableTask = Number.isInteger(index) && index >= 0;
        return (
          <input
            type="checkbox"
            checked={!!checked}
            disabled={!isEditableTask}
            readOnly={!isEditableTask}
            onChange={(e) => {
              if (!isEditableTask) return;
              onTaskToggle(index, e.currentTarget.checked);
            }}
            className={cn(
              "mr-1 align-middle acorn-check",
              isEditableTask && "cursor-pointer",
            )}
          />
        );
      },
    }),
    [onTaskToggle],
  );

  const remarkPlugins = useMemo(
    () => (softBreaks ? [remarkGfm, remarkSoftBreaks] : [remarkGfm]),
    [softBreaks],
  );

  return (
    <>
      <div className={cn("text-[11.5px] leading-relaxed text-fg", className)}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={[
            rehypeTaskIndex,
            rehypeRaw,
            [rehypeSanitize, sanitizeSchema],
          ]}
          urlTransform={markdownImageUrlTransform}
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
