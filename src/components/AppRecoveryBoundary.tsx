import { Component, type ErrorInfo, type ReactNode } from "react";

const WORKSPACE_STORAGE_KEY = "acorn-workspaces";
const SETTINGS_STORAGE_KEY = "acorn:settings:v1";

const COPY = {
  en: {
    eyebrow: "Startup error",
    title: "Acorn couldn't open",
    description:
      "A saved workspace configuration may be incompatible with this version after the update.",
    resetHint:
      "Your terminal sessions and projects will remain. Only window layout and folder organization will be reset.",
    reload: "Try again",
    reset: "Reset workspace view and reopen",
    details: "Error details",
    resetFailed:
      "Acorn couldn't reset the workspace view. Quit the app and try again.",
  },
  ko: {
    eyebrow: "시작 오류",
    title: "Acorn을 열지 못했습니다",
    description:
      "업데이트 후 저장된 작업공간 구성이 현재 버전과 호환되지 않을 수 있습니다.",
    resetHint:
      "터미널 세션과 프로젝트 자체는 삭제되지 않고, 화면 배치와 폴더 구성만 초기화됩니다.",
    reload: "다시 열기",
    reset: "화면 설정 초기화 후 다시 열기",
    details: "오류 상세",
    resetFailed:
      "화면 설정을 초기화하지 못했습니다. 앱을 완전히 종료한 뒤 다시 시도해 주세요.",
  },
} as const;

type RecoveryLanguage = keyof typeof COPY;

function recoveryLanguage(): RecoveryLanguage {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { language?: unknown }) : null;
    return parsed?.language === "ko" ? "ko" : "en";
  } catch {
    return "en";
  }
}

interface AppRecoveryBoundaryProps {
  children: ReactNode;
}

interface AppRecoveryBoundaryState {
  error: Error | null;
  resetFailed: boolean;
}

export class AppRecoveryBoundary extends Component<
  AppRecoveryBoundaryProps,
  AppRecoveryBoundaryState
> {
  state: AppRecoveryBoundaryState = {
    error: null,
    resetFailed: false,
  };

  static getDerivedStateFromError(error: Error): AppRecoveryBoundaryState {
    return { error, resetFailed: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AppRecoveryBoundary] app render failed", error, info);
  }

  private resetWorkspaceView = (): void => {
    try {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      window.location.reload();
    } catch (error) {
      console.error("[AppRecoveryBoundary] workspace reset failed", error);
      this.setState({ resetFailed: true });
    }
  };

  render(): ReactNode {
    const { error, resetFailed } = this.state;
    if (!error) return this.props.children;

    const copy = COPY[recoveryLanguage()];
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-bg p-6 text-fg">
        <section
          role="alert"
          className="w-full max-w-lg rounded-xl border border-border bg-bg-elevated p-6 shadow-2xl"
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-danger">
            {copy.eyebrow}
          </p>
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="mt-3 text-sm leading-6 text-fg-muted">
            {copy.description}
          </p>
          <div className="mt-4 rounded-lg border border-border bg-bg p-3 text-sm leading-6 text-fg-muted">
            {copy.resetHint}
          </div>
          {resetFailed ? (
            <p className="mt-3 text-sm text-danger">{copy.resetFailed}</p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-border bg-bg px-3 py-2 text-sm font-medium hover:bg-fill-hover"
              onClick={() => window.location.reload()}
            >
              {copy.reload}
            </button>
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover"
              onClick={this.resetWorkspaceView}
            >
              {copy.reset}
            </button>
          </div>
          <details className="mt-5 text-xs text-fg-muted">
            <summary className="cursor-pointer select-none">{copy.details}</summary>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-bg p-3 font-mono">
              {error.message || error.name}
            </pre>
          </details>
        </section>
      </main>
    );
  }
}
