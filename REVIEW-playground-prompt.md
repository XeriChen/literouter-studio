# 静态审查报告：统一测活默认提示词与 Playground 一键问话

## 审查范围

**分支**: `dev`（领先 `origin/dev` 1 个提交，未推送）
**审查对象**: 初版 `940164f` feat(ui): 统一测活默认提示词，Playground 增加一键问话（应用本文优化后经 amend，最终 SHA 见 git log；原提交仍在 reflog 可回溯）
**变更规模**: 7 文件 +189/-11（含本次补充的测试与审查报告）

| 文件 | 变更 | 风险 |
|------|------|------|
| `web/src/lib/prompts.ts` | +8 新增 | 🟡中 前后端同源常量，存在漂移风险 |
| `web/src/components/ChatUI.tsx` | +24/-8 | 🟢低 空态 UI + send 签名扩展 |
| `web/src/pages/Models.tsx` | +2/-1 | 🟢低 行内快速测活改用共享常量 |
| `ARCHITECTURE.md` | +3/-1 | 🟢低 测活/前端章节同步 |
| `skills/literouter/references/api.md` | +1/-1 | 🟢低 API 参考同步 |

**审查方式**：diff 通读 + 全部调用方核查（`send` 的 4 处调用、3 处测活入口）+ 文档一致性核对 + 类型检查/lint/单测/生产构建 + 3001 开发实例真实浏览器验证（桌面 1440px / 移动 390px）。

---

## 1. 变更意图（作者目标）

1. 前端只有一处默认提示词字面量，与后端 `DEFAULT_TEST_PROMPT` 保持一致；
2. 真实模型行内「快速测试」不再硬编码「请用一句话介绍你自己」；
3. Playground 空对话且已选映射时，提供默认提示词的一键提问按钮；
4. `send` 支持显式传入文案；
5. 同步架构文档与 Skill 的 API 参考。

---

## 2. 逐项复核结论（对照首轮审查意见）

> 首轮审查意见经逐条复核后按下列结论执行；「不成立/不采纳」的均给出理由，不做无依据修改。

| # | 首轮审查意见 | 复核结论 | 处置 |
|---|---|---|---|
| 1 | 【中】前后端常量重复，无防漂移机制 | **成立**。`web/src/lib/prompts.ts:8` 与 `src/routes/api/models.ts:52` 确为两份独立字面量；web 侧只认 `@/` → `web/src` alias，无法直接 import 后端常量，"同源"只是人工约定 | ✅ 已加守卫测试 |
| 2 | 【低】`send(DEFAULT_PROMPT)` 会静默清空输入框草稿 | **成立**。空态按钮渲染条件是 `!hasMessages`，此时输入框有草稿完全可能；`send` 内无条件 `setInput('')` | ✅ 已修 |
| 3 | 【低】提交信息称 `onClick={send}` 是「事件被当作文案传入」的 bug | **不成立（描述失实）**。改动前 `send` 为无参箭头函数，传入的事件对象被直接忽略，并非 bug。但扩展出 `text?: string` 形参后，该写法才真正变成隐患，需要防御 | ✅ 已加 `typeof` 兜底并修正提交信息 |
| 4 | 【nit】新文件缺分号未过 prettier | **不采纳**。`web/src` 下 47 个文件全部不符合 prettier（含同目录 `sse.ts`/`utils.ts`），单独给新文件补分号反而破坏局部一致性 | ❌ 有意不改 |
| 5 | 【nit】Playground/ChatUI 无任何自动化覆盖 | **部分成立**。`test/e2e/app.spec.ts` 确无 Playground 用例；但该套件以 mock 上游为主，AGENTS.md §8 明确「模拟 API 的 UI 用例也不证明真实后端链路可用」 | ✅ 改用 3001 真实实例做人工浏览器验证（不点击发送，避免真实推理消耗）；不建议补 mock E2E |

---

## 3. 已实施的优化

### 3.1 新增防漂移守卫测试 `test/default-prompt.test.ts`

用源码字面量比对替代人工记忆，任一侧改动默认提示词都会在 `pnpm test` 直接失败；同时校验默认值不落入服务端提示词黑名单（hi/hello/你好/测试/test/1）且 trim 后 ≥4 字符。

- [test/default-prompt.test.ts:17](file:///home/xfz/literouter-dev/test/default-prompt.test.ts#L17) `literal()` 从两份源码抽取字面量
- [test/default-prompt.test.ts:27](file:///home/xfz/literouter-dev/test/default-prompt.test.ts#L27) 前后端一致性断言
- [test/default-prompt.test.ts:31](file:///home/xfz/literouter-dev/test/default-prompt.test.ts#L31) 黑名单/长度约束断言

反向验证：临时把前端常量改掉后该测试确实失败，确认不是空转断言。

### 3.2 `send` 入参兜底 + 草稿保留（ChatUI.tsx）

- [web/src/components/ChatUI.tsx:121](file:///home/xfz/literouter-dev/web/src/components/ChatUI.tsx#L121) `explicit = typeof text === 'string'`：事件对象、未来任何非字符串传参都会退化为「取输入框」，不再可能走错分支
- [web/src/components/ChatUI.tsx:131](file:///home/xfz/literouter-dev/web/src/components/ChatUI.tsx#L131) 仅输入框发送时才 `setInput('')`；一键问话不再吞掉用户已输入的草稿

Enter 发送、发送按钮两条既有路径行为不变（`explicit=false` → 取输入框并清空）。

### 3.3 提交信息修正（随 amend 生效）

原信息中「顺带修正发送按钮 onClick={send} 会把事件对象当作文案传入的问题」与实际不符，已改为描述本次真实的入参兜底与测试补充；原 SHA `940164f` 可在 reflog 找回。

---

## 4. 验证结果（全部实跑）

| 验证项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过（0 错误） |
| `eslint`（改动文件） | ✅ 0 error（1 条既有 `react-hooks/set-state-in-effect` warning，位于本次未改动的持久化 effect） |
| `pnpm test` | ✅ 191/191 通过（原 189 + 新增 2） |
| `pnpm build:web` | ✅ 构建通过 |
| 3001 真实后端 /playground（已选映射） | ✅ 一键提问按钮可见、文案恰为「现在的美国总统是谁」；桌面 1440px 与移动 390px 水平溢出均为 0px，控制台 0 错误 |
| 3001 真实后端 /playground（未选映射） | ✅ 兜底文案「选择模型映射后开始对话」可见，按钮按设计不渲染 |
| 3000 生产网关 | ✅ 全程未触碰，验证前后均正常返回 200 |

> 3001 开发实例为本次临时启动（`HOST`/`PORT` 由开发库 settings 决定，实际监听 0.0.0.0:3001），验证完成后已关闭，临时脚本与截图已清理。

---

## 5. 未验证项（如实说明）

- **草稿保留行为未在浏览器实测**：复现路径是「输入框有草稿 → 点击一键问话」，会触发一次真实上游流式请求（产生推理消耗），按沙箱授权边界未执行。该分支逻辑简单且被 typecheck 覆盖，判定为低风险。
- **异常链路**（流式中途失败、AbortError）为既有逻辑，本次未改动，未重新验证。

---

## 6. 结论

**质量**: ⭐⭐⭐⭐☆ (4/5)

- 变更小而聚焦，四处默认提示词入口行为确实统一，文档同步完整且与实际代码一致；
- 首轮审查的 2 个实质问题（漂移风险、草稿丢失）均已修复并有测试/代码兜底，1 条失实表述已纠正；
- 2 条 nit 中 1 条判定为误报（整仓 prettier 基线如此）、1 条改用更贴近真实链路的验证方式替代。

**建议**: `940164f` 经上述优化后可推送。推送后仍需按 AGENTS.md 双分支流程发布（dev → main 快进 → 生产 `scripts/deploy.sh`），推送 ≠ 部署。

---

**审查时间**: 2026-09-30
**审查者**: Claude (Opus 4.6)
**验证状态**: typecheck / lint / 191 单测 / build:web / 3001 浏览器空态均通过
