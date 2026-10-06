import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../lib/cn";

const SettingHighlightContext = createContext<string | null>(null);

const HIGHLIGHT_CLASS =
  "rounded-md bg-accent/10 ring-1 ring-inset ring-accent/50";

export function SettingHighlightProvider({
  settingId,
  children,
}: {
  settingId: string | null;
  children: ReactNode;
}) {
  return (
    <SettingHighlightContext.Provider value={settingId}>
      {children}
    </SettingHighlightContext.Provider>
  );
}

export function SettingAnchor({
  id,
  className,
  children,
  as = "div",
}: {
  id: string;
  className?: string;
  children: ReactNode;
  as?: "div" | "li";
}) {
  const highlighted = useContext(SettingHighlightContext) === id;
  const Tag = as;
  return (
    <Tag
      id={id}
      data-setting-id={id}
      className={cn("scroll-mt-3", className, highlighted && HIGHLIGHT_CLASS)}
    >
      {children}
    </Tag>
  );
}
