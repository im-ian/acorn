import type { CodeWorkspaceTabTarget } from "../lib/workspaceTabs";
import { mediaKindFromPath } from "../lib/mediaFiles";
import { CodeViewer } from "./CodeViewer";
import { MediaViewer } from "./MediaViewer";

interface FileViewerProps {
  path: string;
  isActive: boolean;
  target?: CodeWorkspaceTabTarget;
}

export function FileViewer({ path, isActive, target }: FileViewerProps) {
  const mediaKind = mediaKindFromPath(path);
  if (mediaKind) {
    return <MediaViewer path={path} kind={mediaKind} isActive={isActive} />;
  }
  return <CodeViewer path={path} target={target} isActive={isActive} />;
}
