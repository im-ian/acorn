import type {
  CodeWorkspaceTabTarget,
  CodeWorkspaceTabViewState,
} from "../lib/workspaceTabs";
import { mediaKindFromPath } from "../lib/mediaFiles";
import { CodeViewer } from "./CodeViewer";
import { MediaViewer } from "./MediaViewer";

interface FileViewerProps {
  path: string;
  isActive: boolean;
  target?: CodeWorkspaceTabTarget;
  viewState?: CodeWorkspaceTabViewState;
  onViewStateChange?: (patch: CodeWorkspaceTabViewState) => void;
}

export function FileViewer({
  path,
  isActive,
  target,
  viewState,
  onViewStateChange,
}: FileViewerProps) {
  const mediaKind = mediaKindFromPath(path);
  if (mediaKind) {
    return (
      <MediaViewer
        path={path}
        kind={mediaKind}
        isActive={isActive}
        viewState={viewState}
        onViewStateChange={onViewStateChange}
      />
    );
  }
  return (
    <CodeViewer
      path={path}
      target={target}
      isActive={isActive}
      viewState={viewState}
      onViewStateChange={onViewStateChange}
    />
  );
}
