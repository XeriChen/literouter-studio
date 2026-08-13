# Signal Editorial Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Literouter Studio 重构为强排版首页与登录页、密集克制业务控制台的现代前端体验，同时保留现有 API 契约与代理红线。

**Architecture:** 以现有 React 19、React Router、TanStack Query、Tailwind 和 Lucide 为基础，建立统一的 theme tokens、页面标题/工具栏/状态样式与响应式表格规则。首页、登录页、Playground 承担品牌表达；Providers、Models、Logs、Settings 复用相同的工作台壳层和紧凑控件，交互逻辑只做可见性、状态反馈、移动端布局和错误呈现的改良，不改变后端数据协议。

**Tech Stack:** React 19, TypeScript strict, Tailwind CSS 3, shadcn-style primitives, Lucide React, TanStack Query, Vite 6.

## Global Constraints

- 不做 OpenAI / Anthropic 协议转换；代理请求体只能在路由成功后替换 `model` 字段。
- 管理 API 模型相关参数继续使用 Request Body，不新增路径参数。
- 所有图标统一来自 `lucide-react`，界面可见区域禁止表情符号。
- 默认主题跟随系统并持久化；明暗主题均需可读，支持 `prefers-reduced-motion`。
- 中文为主；OpenAI、Anthropic、模型 ID、端点和品牌标识保留英文。
- 不新增图片依赖；登录视觉由排版、网格、状态线和代码化装饰实现。
- `.superpowers/` 为视觉讨论临时目录，加入 `.gitignore`，不提交预览文件。
- 完成定义：`corepack pnpm typecheck` 与 `corepack pnpm build:web` 通过。

---

### Task 1: Theme and UI primitives

**Files:**
- Modify: `web/src/index.css`
- Modify: `web/src/components/ui/button.tsx`
- Modify: `web/src/components/ui/card.tsx`
- Modify: `web/src/components/ui/input.tsx`
- Modify: `web/src/components/ui/textarea.tsx`
- Modify: `.gitignore`

**Interfaces:** Preserve existing exported component names and props. Add only CSS utility classes used by pages (`page-shell`, `page-heading`, `section-label`, `console-surface`, `data-table`, `signal-line`, `stagger-*`).

- [ ] Define warm paper / ink light tokens and charcoal / lime dark tokens, with semantic success, warning and destructive colors.
- [ ] Load the existing Manrope and DM Mono pairing without setting negative letter spacing outside deliberate display headings.
- [ ] Add reduced-motion overrides and stable focus/hover states; keep cards at a restrained radius and remove nested decorative surfaces.
- [ ] Tune Button, Card, Input and Textarea defaults for compact console density while preserving variant API.
- [ ] Ignore `.superpowers/` and verify `git diff --check`.

### Task 2: Shell, Login and Overview

**Files:**
- Modify: `web/src/components/Layout.tsx`
- Modify: `web/src/pages/Login.tsx`
- Modify: `web/src/pages/Home.tsx`

**Interfaces:** Keep all existing route paths and `Layout`/page default exports.

- [ ] Make route metadata type-safe and support nested route labels with a fallback title.
- [ ] Keep mobile drawer navigation, add compact topbar context, theme control and explicit gateway status without emoji.
- [ ] Build a high-impact but concise Login composition with brand lockup, local-network signal, token form, validation state and keyboard focus.
- [ ] Build Overview with a strong editorial headline, live provider/model counts, route/protocol callouts and three task links; render loading and zero-data states cleanly.
- [ ] Ensure dynamic Lucide component references are typed as `LucideIcon`.

### Task 3: Playground interaction surface

**Files:**
- Modify: `web/src/pages/Playground.tsx`
- Modify: `web/src/components/ChatUI.tsx`
- Modify: `web/src/components/MarkdownRenderer.tsx`

**Interfaces:** Preserve `ChatUI({ protocol, alias })` and SSE payload behavior.

- [ ] Replace the loose selector card with a compact protocol/model command bar and visible target metadata.
- [ ] Keep persisted conversations, abort behavior, SSE parsing and native model alias routing unchanged.
- [ ] Improve empty, streaming, error and assistant message states; use icon-only controls only with accessible labels/tooltips.
- [ ] Keep composer stable on narrow screens and prevent layout shifts during streaming.

### Task 4: Dense management consoles

**Files:**
- Modify: `web/src/pages/Providers.tsx`
- Modify: `web/src/pages/Models.tsx`
- Modify: `web/src/pages/ModelAliases.tsx`
- Modify: `web/src/pages/Logs.tsx`
- Modify: `web/src/pages/Settings.tsx`

**Interfaces:** Preserve all existing API calls, mutation payloads, query keys, dialog forms, model alias semantics and log pagination/filter behavior.

- [ ] Normalize page headings, action toolbars, notice banners and empty/loading states.
- [ ] Use compact unframed table surfaces with responsive overflow only where columns cannot fit; keep row actions icon-based with accessible labels.
- [ ] Preserve Provider CRUD, test, fetch/import flows and warnings; improve form grouping and mobile stacking.
- [ ] Preserve Models/aliases bulk actions, rename/retarget/test/copy flows; make protocol filtering and action feedback easier to scan.
- [ ] Preserve access/audit log tabs, filters, pagination and clear actions; improve status and timestamp legibility.
- [ ] Preserve settings save/token reset/backup warnings; make destructive operations visually explicit without changing semantics.

### Task 5: Verification and handoff

**Files:** No new production files.

- [ ] Run `corepack pnpm typecheck` and fix all errors.
- [ ] Run `corepack pnpm build:web` and inspect output for asset/reference failures.
- [ ] Start `corepack pnpm dev` (or separate server/web commands if needed), verify login redirect and authenticated shell.
- [ ] Inspect desktop and mobile layouts, both theme modes, reduced-motion behavior, table overflow, dialogs and Playground streaming states.
- [ ] Run `git diff --check` and report the dev URL plus any residual environment limitations.
