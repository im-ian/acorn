import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";
import {
  markdownImageUrlTransform,
  RemoteImage,
} from "../ui/RemoteImage";
import { ChatCodeBlock } from "./ChatCodeBlock";

interface ChatMessageBodyProps {
  content: string;
  repoPath?: string;
  className?: string;
  isStreaming?: boolean;
}

function textFromNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromNode(node.props.children);
  }
  return "";
}

function languageFromClassName(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([^\s]+)/.exec(className ?? "");
  return match?.[1] ?? null;
}

function renderableStreamingContent(content: string, isStreaming: boolean): string {
  if (!isStreaming) return content;
  const fenceMatches = content.match(/^```/gm);
  if (!fenceMatches || fenceMatches.length % 2 === 0) return content;
  return `${content}\n` + "```";
}

export function ChatMessageBody({
  content,
  repoPath,
  className,
  isStreaming = false,
}: ChatMessageBodyProps) {
  const components: Components = {
    a({ href, children, ...rest }) {
      return (
        <a
          {...rest}
          href={href}
          onClick={(event) => {
            event.preventDefault();
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
    ul({ children }) {
      return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>;
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
    img({ src, alt, title, width, height }) {
      return (
        <RemoteImage
          src={src}
          alt={alt ?? ""}
          title={title}
          width={width}
          height={height}
          loading="lazy"
          className="my-2 max-w-full rounded border border-border"
        />
      );
    },
    code({ className, children, ...rest }) {
      return (
        <code
          {...rest}
          className={cn(
            "rounded bg-bg-sidebar/80 px-1 py-0.5 font-mono text-[0.88em] text-fg ring-1 ring-inset ring-border/70",
            className,
          )}
          data-chat-inline-code
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      const child = Children.toArray(children).find(isValidElement);
      if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        return (
          <pre className="my-3 overflow-x-auto rounded-md border border-border bg-bg-sidebar/80 p-3 font-mono text-[11px] leading-5 text-fg">
            {children}
          </pre>
        );
      }
      const code = textFromNode(child.props.children);
      return (
        <ChatCodeBlock
          code={code}
          language={languageFromClassName(child.props.className)}
          repoPath={repoPath}
          isStreaming={isStreaming}
        />
      );
    },
    hr() {
      return <hr className="my-3 border-border" />;
    },
    table({ children }) {
      return (
        <div className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            {children}
          </table>
        </div>
      );
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
  };

  return (
    <div
      className={cn(
        "acorn-selectable select-text text-sm leading-6 text-fg",
        className,
      )}
      data-chat-message-body
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={markdownImageUrlTransform}
        components={components}
      >
        {renderableStreamingContent(content, isStreaming)}
      </ReactMarkdown>
    </div>
  );
}
