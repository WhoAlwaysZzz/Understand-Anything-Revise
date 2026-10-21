# Understand Anything

Git 提交遵循已加载的全局单一行为变更规则。

## Dashboard 约定

- 保留深黑与金色视觉主题；以图为主、右侧栏辅助导航，AI 对话按节点按需打开。
- AI 密钥保存在项目外的用户配置（可由 `UA_AI_CONFIG` 指定）；浏览器只见掩码提示。文件读取及搜索遵守令牌与图路径白名单。
- 用户批注存放在独立的 `annotations.json`，重新分析图时保留这些数据。
- 实现细节、快捷键、组件名和端点列表按 dashboard 源码核实。

## Agent Pipeline
- Agents write intermediate results to the data directory's `intermediate/` subdirectory on disk (not returned to context) — `.ua/intermediate/`, or `.understand-anything/intermediate/` when that legacy directory is present
- Agent model field is omitted from frontmatter so each platform falls back to its configured default — `inherit` was a Claude Code-only keyword that opencode (and similar tools) treated as a literal model id and rejected with `ProviderModelNotFoundError` (see #167)
- `/understand` auto-triggers `/understand-dashboard` after completion
- Intermediate files cleaned up after graph assembly

## 构建与验证

运行命令前读取根目录与目标包的 `package.json` scripts；skill 测试由根目录 `tests/skill/` 和 `vitest.config.ts` 承担。
- Knowledge graph JSON lives in the analyzed project's data directory: `.ua/` for new projects, or the legacy `.understand-anything/` directory when it already exists (if `.understand-anything/` is present it is used for both reads and writes; otherwise `.ua/`). All bundled scripts and core code self-resolve this rule.
- Core uses subpath exports (`./search`, `./types`, `./schema`) to avoid pulling Node.js modules into browser

## Gotchas
- **tree-sitter**: Uses `web-tree-sitter` (WASM) instead of native `tree-sitter` — native bindings fail on darwin/arm64 + Node 24
- **Dashboard imports**: Dashboard must only import from core's browser-safe subpath exports (`./search`, `./types`, `./schema`), never the main entry point which pulls in Node.js modules

## Viewer Package
`packages/viewer` serves a committed graph without Claude Code, via `npx <release-asset-url>`. Update it when (a) the dashboard UI changes — the tarball embeds the built `dist/` — or (b) the `vite.config.ts` dev-server middleware changes, which `bin/viewer.mjs` deliberately mirrors. Server logic shared between the two lives in self-contained core modules (`staleness.ts`, `content-search.ts`, `annotations.ts`, `git-hotspots.ts`, `arch-rules.ts`; the viewer serves `/annotations.json` and `/arch-rules.json` read-only) that `build.mjs` copies into `bin/dist/`. On every release, repack (`pack:release` script) and re-upload the tarball to the GitHub release as `understand-anything-viewer.tgz` — exactly that name, the READMEs' `releases/latest/download/` URL depends on it.

## Versioning
When pushing to remote, bump the version in **all six** of these files (keep them in sync):
- `understand-anything-plugin/package.json` → `"version"` field
- `understand-anything-plugin/.claude-plugin/plugin.json` → `"version"` field
- `understand-anything-plugin/packages/viewer/package.json` → `"version"` field
- `.claude-plugin/plugin.json` → `"version"` field
- `.cursor-plugin/plugin.json` → `"version"` field
- `.copilot-plugin/plugin.json` → `"version"` field

Note: `.claude-plugin/marketplace.json` does **not** carry a version — the `plugins[]` entry only supports `name` and `source`, and adding other fields causes marketplace schema validation failures.

## Testing Local Plugin Changes

本地插件验证时，先核实实际安装来源、版本和目录，再构建所需包。缓存更新涉及覆盖已有数据时先保留可恢复副本；执行删除前遵循全局明确授权要求。使用新的 Claude Code 会话验证提示词更新，最后在目标项目运行 `/understand --full`。
