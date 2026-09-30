/**
 * 网关内置默认提示词，供测活与 Playground 一键问话共用。
 *
 * 必须与后端 `DEFAULT_TEST_PROMPT`（src/routes/api/models.ts）保持一致：
 * 测活弹窗留空、真实模型行内快速测活、映射快速测活与 Playground 都会落到同一句。
 * 修改时同步后端常量、ARCHITECTURE.md 的测活/前端章节与 skills/literouter/references/api.md。
 */
export const DEFAULT_PROMPT = '现在的美国总统是谁'
