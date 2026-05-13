# Theme & Appearance — Design Spec

Date: 2026-05-13
Branch: `theme`
Status: Draft (awaiting user review)

## Goal

Acorn 사용자가 앱의 외형을 의미 있게 커스터마이즈할 수 있게 한다. 세 가지 축:

1. **Theme** — 색상 팔레트 교체 (CSS 변수 기반, 빌트인 + 사용자 .css 파일)
2. **Background image** — 한 장의 이미지를 App / Terminal 영역에 깔기 (fit·opacity·blur 제어)
3. **Terminal font family** — 큐레이션된 모노스페이스 폰트에서 3슬롯 폴백 선택

빌트인 폼은 명확하고, 고급 사용자는 .css 파일이나 이미지 파일을 직접 갈아 끼울 수 있다.

## Non-Goals

- 인라인 색 picker로 팔레트 한 슬롯씩 GUI 편집 — `.css` 파일을 외부 에디터에서 편집하는 방식으로 일원화
- UI 폰트(`--font-sans`) 변경 — 이번 범위는 터미널 폰트만
- xterm ANSI 16색 (red/green/yellow/blue/…) 커스터마이즈 — bg/fg만. ANSI 팔레트는 미래 작업
- 영역별 다른 배경 이미지 — 한 장 이미지를 토글로 어느 영역에 적용할지만 결정

## Architecture Overview

```
┌─ src/lib ────────────────────────────────────────────────┐
│  themes.ts        ── 빌트인 CSS 텍스트 + load/apply       │
│  background.ts    ── 이미지 import / CSS 변수 주입         │
│  fonts.ts         ── 큐레이션 목록 + 3슬롯 직렬화          │
│  settings.ts      ── appearance 블록 추가 + migration     │
└──────────────────────────────────────────────────────────┘
            │ load on boot                  │ persist
            ▼                                ▼
┌─ src/App.tsx ──────────────────────────┐  localStorage
│  useEffect: applyTheme, applyBackground │  "acorn:settings:v1"
└─────────────────────────────────────────┘
            │
            ▼
┌─ DOM ─────────────────────────────────────────────────────┐
│  <style id="acorn-theme">…</style>     <-- theme CSS       │
│  <html data-acorn-theme="<id>">                            │
│  <div class="acorn-bg-app">            <-- bg overlay      │
│  <div class="acorn-bg-terminal">       <-- bg overlay      │
│  CSS vars: --color-*, --bg-image-url, --bg-fit, …          │
└────────────────────────────────────────────────────────────┘
```

## 1. Theme

### Storage

- 사용자 .css 파일은 `$APPLOCALDATA/themes/<id>.css`
- 빌트인 7개는 앱 번들 안의 `src/assets/themes/*.css`를 Vite `?raw` import로 string 상수화 (Vite 소스 트리 컨벤션)
- 부팅 시 `$APPLOCALDATA/themes` 디렉토리 스캔 → 빌트인과 합쳐서 dropdown 목록 구성. 빌트인과 id 충돌 시 사용자 파일 우선
- 선택된 themeId는 `settings.appearance.themeId`

### CSS 규약

각 테마 파일은 **하나의 selector**:

```css
:root[data-acorn-theme="acorn-dark"] {
  --color-bg: #1f2326;
  --color-bg-elevated: #272b2f;
  --color-bg-sidebar: #1a1d20;
  --color-fg: #ededed;
  --color-fg-muted: oklch(64% 0.01 250);
  --color-border: #2f3338;
  --color-accent: oklch(72% 0.16 145);
  --color-accent-hover: oklch(78% 0.16 145);
  --color-danger: oklch(62% 0.22 25);
  --color-warning: oklch(78% 0.16 75);
  --color-terminal-bg: #1f2326;
  --color-terminal-fg: #ededed;
}
```

12개 변수 모두 정의되어야 dropdown에 등재됨. 검증은 정규식으로 12개 키 존재 + 각 값이 빈 문자열 아닌지만 확인 (CSS 색 문법 자체는 브라우저에 위임). 검증 실패한 사용자 .css는 dropdown에서 제외 + console.warn으로 reason 출력. 빌트인은 컴파일 타임에 보장.

### 빌트인 7개

| ID | Label | Mode |
|---|---|---|
| `acorn-dark` | Acorn Dark | dark |
| `one-dark-pro` | One Dark Pro | dark |
| `tokyo-night` | Tokyo Night | dark |
| `acorn-light` | Acorn Light | light |
| `github-light` | GitHub Light | light |
| `solarized-light` | Solarized Light | light |
| `catppuccin-latte` | Catppuccin Latte | light |

기본값: `acorn-dark` (현재 색상 그대로 보존).

### Apply

`applyTheme(id, cssText)`:
1. 기존 `<style id="acorn-theme">` 제거
2. 새 `<style id="acorn-theme">{cssText}</style>`을 `<head>` 끝에 추가
3. `document.documentElement.setAttribute("data-acorn-theme", id)`

theme switch는 즉시 반영, 페이지 reload 없음.

### Settings UI

- Settings → **Appearance** 탭 (신규)
- "Theme" Select dropdown (빌트인 + 사용자 .css 합쳐서)
- "Reveal themes folder" 버튼 → `tauri-plugin-opener`로 디렉토리 열기
- "Refresh" 버튼 → 디렉토리 다시 스캔 (외부에서 .css 추가/수정 후 재로드)

## 2. Background Image

### Storage

- 사용자가 import한 단일 이미지를 `$APPLOCALDATA/backgrounds/<hash>.<ext>`로 복사
  - `<hash>`는 파일 SHA-256 first 8 chars로 충돌 회피
  - 새 이미지 import 시 이전 파일 정리 (단일 이미지 정책)
- 메타데이터(`fileName`, `relativePath`, `fit`, `opacity`, `blur`, `applyToApp`, `applyToTerminal`)는 `settings.appearance.background`

### Tauri 권한

`src-tauri/capabilities/default.json`에 추가:

```json
"permissions": [
  …,
  "fs:default",
  "fs:read-files",
  "fs:write-files",
  { "identifier": "fs:scope", "allow": ["$APPLOCALDATA/backgrounds/**/*"] }
]
```

### Settings UI

```
Background image
[Pick image…]  filename.png  [Remove]

Apply to:  [✓] App background   [ ] Terminal background

Fit:      ( ) Cover  (•) Contain  ( ) Tile
Opacity:  [——●——————]  60%
Blur:     [●———————]   0 px
```

- "Pick image…" → Tauri `plugin-dialog` `open()` → 이미지 파일 선택 → `plugin-fs`로 `$APPLOCALDATA/backgrounds/<hash>.<ext>`에 복사
- "Remove" → 파일 삭제 + settings clear

### Rendering

저장은 portable한 **상대 경로** (`backgrounds/abc123.png`), 런타임에 절대 경로로 resolve 후 Tauri `convertFileSrc()`로 webview에서 로드 가능한 `asset://` URL로 변환. 결과 URL을 CSS 변수에 주입:

- `--bg-image-url: url("asset://localhost/…")`
- `--bg-fit: cover | contain | tile` → CSS에서 fit 값에 따라 `background-size`/`background-repeat` 조합 결정
- `--bg-opacity: 0–1`
- `--bg-blur: 0–24px`

DOM:

```html
<body>
  <div class="acorn-bg-app" data-active={applyToApp} />
  ...
  <div class="acorn-bg-terminal" data-active={applyToTerminal} />
</body>
```

CSS:

```css
.acorn-bg-app,
.acorn-bg-terminal {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  background-image: var(--bg-image-url);
  background-size: var(--bg-fit); /* tile은 size:auto + repeat */
  background-repeat: no-repeat;
  background-position: center;
  opacity: var(--bg-opacity);
  filter: blur(var(--bg-blur));
}
.acorn-bg-app[data-active="false"],
.acorn-bg-terminal[data-active="false"] {
  display: none;
}
```

`acorn-bg-app`은 body 직속, `acorn-bg-terminal`은 각 Pane 내부 (Terminal 컴포넌트의 wrapper). xterm viewport는 이미 transparent이므로 비침.

## 3. Terminal Font

### Curated List

10개 모노스페이스 폰트:

1. JetBrains Mono
2. Fira Code
3. Cascadia Code
4. SF Mono
5. Menlo
6. Monaco
7. Consolas
8. IBM Plex Mono
9. Source Code Pro
10. Hack

### 3-slot Dropdown

- Settings의 기존 "Font family" 텍스트 입력을 3개 Select dropdown으로 교체
  - Primary (선택 필수)
  - Secondary (옵션, "—" = 비움)
  - Tertiary (옵션)
- 각 dropdown 옵션: 큐레이션 10개 + "—" (clear)

### 직렬화 (`fonts.ts`)

```ts
fontStackFromSlots(["JetBrains Mono", "SF Mono", "Menlo"], "monospace")
// → '"JetBrains Mono", "SF Mono", Menlo, monospace'
```

- 공백 포함된 이름은 `"…"` 로 wrap
- 단어 하나짜리(Menlo, Monaco)는 unquoted
- generic fallback("monospace")은 항상 마지막
- 빈 슬롯은 skip

`fontSlotsFromStack(stack)`은 round-trip 가능: quote 떼고, generic fallback 제거하고, 앞에서 3개까지 반환.

### Migration

기존 `settings.terminal.fontFamily` 문자열 → `fontSlotsFromStack()`로 슬롯 추출. 큐레이션 목록에 없는 폰트면 default 슬롯(JetBrains Mono / Fira Code / Menlo)으로 reset + 한 번 toast로 안내.

## Data Model — settings 변경

`AcornSettings`에 추가:

```ts
appearance: {
  themeId: string;              // 기본 "acorn-dark"
  background: {
    relativePath: string | null;  // $APPLOCALDATA 기준 상대 (예: "backgrounds/abc123.png")
    fileName: string | null;       // 사용자 표시용
    fit: "cover" | "contain" | "tile";
    opacity: number;               // 0–1
    blur: number;                  // 0–24
    applyToApp: boolean;
    applyToTerminal: boolean;
  };
  fontSlots: [string, string | null, string | null]; // Primary 필수, 나머지 null 가능
}
```

`loadSettings()`에 normalizer 추가:
- 미지의 themeId → "acorn-dark"
- fit 검증 / opacity·blur clamp
- fontSlots 검증 + curated list 매칭, 실패 시 default

`terminal.fontFamily`는 **derived** 필드가 된다 — slot이 truth, fontFamily는 `fontStackFromSlots()` 결과로 항상 동기화. settings load 시 한 번, patchAppearance에서 slot 변경 시마다. 직접 fontFamily만 patch하는 경로는 막거나 deprecate. Terminal.tsx는 기존대로 `terminal.fontFamily`만 읽으면 됨.

## Files

### 신규

- `src/lib/themes.ts` — 빌트인 7개 CSS 텍스트, `loadCustomThemes`, `applyTheme`, `revealThemesFolder`
- `src/lib/themes.test.ts`
- `src/lib/fonts.ts` — `CURATED_MONOSPACE_FONTS`, `fontStackFromSlots`, `fontSlotsFromStack`
- `src/lib/fonts.test.ts`
- `src/lib/background.ts` — `importBackgroundImage`, `removeBackground`, `applyBackgroundVars`
- `src/lib/background.test.ts`
- `src/components/AppearanceTab.tsx` — Settings 새 탭 (theme / background / font)
- `src/assets/themes/acorn-dark.css`
- `src/assets/themes/acorn-light.css`
- `src/assets/themes/one-dark-pro.css`
- `src/assets/themes/tokyo-night.css`
- `src/assets/themes/github-light.css`
- `src/assets/themes/solarized-light.css`
- `src/assets/themes/catppuccin-latte.css`

### 수정

- `src/lib/settings.ts` — `appearance` 블록 + normalizer
- `src/components/SettingsModal.tsx` — Appearance 탭 마운트
- `src/components/Terminal.tsx` — xterm `theme.background/foreground`를 CSS var에서 읽기 + bg overlay div 마운트
- `src/App.tsx` — boot 시 theme/background 적용
- `src/App.css` — `@theme` 블록 정리 (CSS var는 theme 파일로 이전), `.acorn-bg-*` 클래스
- `src-tauri/capabilities/default.json` — backgrounds scope

### 삭제

- `src/lib/appearance-themes.test.ts` (untracked, main에만 존재 — 무시)
- `src/lib/capabilities.test.ts` (untracked, main에만 존재 — 무시)
- `src/lib/fonts.test.ts` (untracked, main에만 존재 — 신규로 다시 작성)

## Testing

- **`themes.test.ts`**: 7개 빌트인 등록, .css 파싱이 12개 변수 enforce, `applyTheme` 후 `<style id="acorn-theme">`와 `data-acorn-theme` 속성 확인 (jsdom)
- **`fonts.test.ts`**: `fontStackFromSlots` ↔ `fontSlotsFromStack` round-trip, quoting 규칙, generic fallback, 빈 슬롯 skip
- **`background.test.ts`**: import 시 hash 기반 경로 생성 (Tauri FS는 모킹), CSS var 4개가 documentElement에 set되는지
- **`settings.test.ts`**: `appearance` migration — 이전 settings에 없을 때 기본값 채워지는지, 손상된 값(잘못된 fit, 큐레이션 외 폰트) → fallback
- 수동 검증: `bun run tauri dev`로 theme 전환·이미지 import·폰트 변경 골든 패스

## Risks / Trade-offs

- **CSS-only theme 편집**: 인라인 picker 포기 → 비개발자에게는 .css 파일을 열어야 한다는 마찰. 완화책: 빌트인 7개로 대부분 커버, "Reveal folder" 버튼으로 진입 장벽 낮춤
- **단일 배경 이미지**: 영역별 다른 이미지 못 깔지만 UI 복잡도 ↓. 추후 분리 필요하면 metadata에 image-per-area 추가
- **단일 SHA-256 hash 충돌**: 8자 prefix는 ~2^32 공간이라 한 사용자가 4억 이미지 import 전까지는 실용상 무충돌
- **xterm bg 색**: CSS var를 xterm에 매번 다시 적용해야 함 (theme switch 후 xterm 재초기화 없이 색 갱신은 xterm API의 `terminal.options.theme = {...}` 재할당으로 처리)
- **Tauri capability 변경**: `fs:scope`를 좁히는 방향이라 보안 손실 없음. 빌드 후 macOS DMG 재공증 불필요 (capability 파일은 빌드 시 임베드)

## Open Questions

없음. 빌트인 7개 이름·폰트 10개·UI 컨트롤·저장 경로 모두 사용자 승인 완료.

## Next

이 spec이 승인되면 `writing-plans` 스킬로 implementation plan을 작성한다. Plan에서는 파일 단위 작업 순서, 의존성, 검증 단계를 다룬다.
