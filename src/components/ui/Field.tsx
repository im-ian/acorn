import { type ReactNode } from "react";
import { SettingAnchor } from "./settingHighlight";

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
  /** DOM id used by Settings search to scroll this control into view. */
  settingId?: string;
}

export function Field({ label, hint, children, settingId }: FieldProps) {
  const body = (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-fg-muted">{hint}</span> : null}
    </div>
  );
  if (!settingId) return body;
  return <SettingAnchor id={settingId}>{body}</SettingAnchor>;
}
