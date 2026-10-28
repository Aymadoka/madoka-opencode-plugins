# madoka-opencode-git-check

> OpenCode 插件 — 一键扫描、分类、审查并提交代码

为 OpenCode 提供完整的 Git 工作流能力：扫描工作目录、智能分类、预提交质量检查、暂存/提交、以及 `.gitignore` 智能生成。

## 功能

- **智能分类**：按 8 类自动归类变更文件（源码、配置、文档、测试、样式、资源、构建产物、其他），标注状态与增删行统计
- **预提交检查**：检测冲突标记、调试语句、敏感信息、大文件、TODO 标记，并自动运行项目 lint
- **安全落盘**：`gitignore_write` 使用 `fs.writeFile` 直接写入，避免 shell 转义问题
- **跨平台**：基于 `node:fs` 与 `git -C` 实现，不依赖 bash，Windows / macOS / Linux 通用
- **UTF-8**：全量 UTF-8 编码，中文提交信息无乱码
- **非阻塞可取消**：git 命令通过异步 `child_process.exec` 执行，并绑定工具调用的 `AbortSignal`，不阻塞 OpenCode 服务端，会话中止时子进程随之结束
- **会话目录感知**：优先在会话所属目录（含 worktree 会话）执行 git，取不到时回退到插件加载目录

## 工具

| 工具 | 说明 |
|------|------|
| `git_scan` | 扫描工作目录所有变更并按 8 类自动分类 |
| `git_stage` | `git add` 全部或指定文件 |
| `pre_commit_check` | 检查暂存区（冲突/调试/敏感信息/TODO/大文件/lint）+ 返回 diff |
| `git_commit` | `git commit -m` 仅本地提交，不推送 |
| `gitignore_scan` | 扫描项目结构，给出 `.gitignore` 建议 |
| `gitignore_write` | 写入 `.gitignore` |

## 命令

| 命令 | 说明 |
|------|------|
| `/commit` | 中文提交流程（扫描 → 分类 → 暂存 → 检查 → 审查 → 提交） |
| `/commit:en` | 英文提交流程 |
| `/gitignore` | 生成 `.gitignore` 流程 |

## 安装

要求 OpenCode 2.x（插件基于 `@opencode/plugin` API，OpenCode 1 的 `@opencode-ai/plugin` 实现无法在 2.x 运行）。

### 发布后

在你的 `opencode.json` 中添加：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["madoka-opencode-git-check"]
}
```

### 本地开发 / 调试

本地路径必须是**目录**（指向单个 `.js` 文件会被跳过并在日志中告警），OpenCode 通过 `package.json` 的 `exports` 加载插件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./"]
}
```

先执行一次 `npm run build` 生成 `dist/`。

## 本地开发

```bash
npm install
npm run build      # 输出 dist/
npm run dev        # watch
npm run typecheck  # 类型检查
```

## 项目结构

```
src/
  index.ts          # 插件入口：Plugin.define + setup(ctx)，注册 6 个工具与 3 个命令
  lib/
    scanner.ts      # git_scan 逻辑 + 分类/格式化
    checks.ts       # pre_commit_check 逻辑
    stage.ts        # git_stage
    commit.ts       # git_commit
    ignore.ts       # gitignore_scan/write
```

V2 里没有 `config` / `tool` hook，工具通过 `ctx.tool.transform(editor => editor.add(...))` 注册（入参用 JSON Schema 描述，结果为 `{ content }`），命令通过 `ctx.command.transform(...)` 注册并由 `ctx.session.prompt(...)` 提交模板，详见 [OpenCode 插件文档](https://opencode.ai/v2/docs/build/plugins)。

## 从 0.1.x 升级

0.2.0 是面向 OpenCode 2 的破坏性更新（插件 API 不兼容）：

- `opencode.json` 的 `plugin` 字段改为 `plugins`，本地条目改为目录路径（如 `"./"`）
- 依赖从 `@opencode-ai/plugin` 换成 `@opencode/plugin`，不再需要 `zod`
- 已加载的命令定义由插件注册，更新后在 OpenCode 中执行 `/reload` 重新加载插件即可生效

## 协议

MIT
