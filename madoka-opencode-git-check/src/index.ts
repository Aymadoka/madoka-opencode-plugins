import { Plugin } from "@opencode/plugin";
import { exec } from "node:child_process";
import { runPreCommitChecks } from "./lib/checks.js";
import { executeCommit } from "./lib/commit.js";
import { scanWorkingTree, formatScanReport } from "./lib/scanner.js";
import { stageFiles, stageAll } from "./lib/stage.js";
import { scanForIgnore, formatIgnoreScanReport, writeGitignore } from "./lib/ignore.js";

interface ShellResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  text(encoding?: BufferEncoding): string;
}

interface ShellOptions {
  cwd?: string;
  signal?: AbortSignal;
}

function createShell(defaults: ShellOptions = {}): any {
  const quote = (value: unknown) => {
    const s = String(value ?? "");
    if (/[\s"']/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
    return s;
  };
  const buildCmd = (strings: TemplateStringsArray, values: unknown[]) => {
    let cmd = "";
    for (let i = 0; i < strings.length; i++) {
      cmd += strings[i];
      if (i < values.length) cmd += quote(values[i]);
    }
    return cmd;
  };
  const run = (cmd: string, options: ShellOptions = {}, throwOnError = true) =>
    new Promise<ShellResult>((resolve, reject) => {
      exec(
        cmd,
        {
          encoding: "buffer",
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          ...defaults,
          ...options,
          signal: options.signal ?? defaults.signal,
        } as any,
        (error: any, stdout: any, stderr: any) => {
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""));
          const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ""));
          const result: ShellResult = {
            stdout: out,
            stderr: err,
            exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            text: (encoding?: BufferEncoding) => out.toString(encoding),
          };
          if (!error) return resolve(result);
          if (!throwOnError) return resolve(result);
          const failure: any = new Error(error.message);
          failure.stdout = out;
          failure.stderr = err.length > 0 ? err : Buffer.from(error.message);
          failure.exitCode = result.exitCode;
          failure.text = result.text;
          reject(failure);
        },
      );
    });

  const make = (options: ShellOptions) => {
    const shell: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
      run(buildCmd(strings, values), options);
    shell.cwd = (dir: string) => make({ ...options, cwd: dir });
    shell.escape = quote;
    shell.nothrow = (strings: TemplateStringsArray, ...values: unknown[]) =>
      run(buildCmd(strings, values), options, false);
    return shell;
  };

  return make(defaults);
}

/** 优先使用会话所属目录（worktree 会话），回退到插件加载位置。 */
async function resolveWorktree(ctx: Plugin.Context, sessionID?: string): Promise<string> {
  if (sessionID) {
    try {
      const session = await ctx.session.get({ sessionID: sessionID as any });
      const directory = session?.location?.directory;
      if (directory) return directory;
    } catch {
      /* 回退到插件目录 */
    }
  }
  return ctx.location.directory;
}

function formatCheckReport(report: Awaited<ReturnType<typeof runPreCommitChecks>>): string {
  const lines: string[] = [];
  lines.push(`## 预提交检查报告\n`);
  lines.push(`**暂存文件** (${report.stagedFiles.length} 个):`);
  for (const f of report.stagedFiles) lines.push(`- ${f}`);
  lines.push(`\n**变更统计:**\n\`\`\`\n${report.diffStat}\n\`\`\``);
  if (report.issues.length === 0) {
    lines.push(`\n✅ **所有检查通过，未发现问题。**`);
  } else {
    const errors = report.issues.filter((i) => i.severity === "error");
    const warnings = report.issues.filter((i) => i.severity === "warning");
    const infos = report.issues.filter((i) => i.severity === "info");
    lines.push(`\n### 问题清单\n`);
    if (errors.length > 0) {
      lines.push(`**错误 (${errors.length})**:`);
      for (const issue of errors) {
        const loc = issue.file ? ` \`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "";
        lines.push(`- [${issue.type}]${loc}: ${issue.message}`);
      }
      lines.push("");
    }
    if (warnings.length > 0) {
      lines.push(`**警告 (${warnings.length})**:`);
      for (const issue of warnings) {
        const loc = issue.file ? ` \`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "";
        lines.push(`- [${issue.type}]${loc}: ${issue.message}`);
      }
      lines.push("");
    }
    if (infos.length > 0) {
      lines.push(`**提示 (${infos.length})**:`);
      for (const issue of infos) {
        const loc = issue.file ? ` \`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "";
        lines.push(`- [${issue.type}]${loc}: ${issue.message}`);
      }
      lines.push("");
    }
  }
  if (report.passed) lines.push(`\n---\n**结果：检查通过**，可以继续提交。`);
  else lines.push(`\n---\n**结果：存在错误**，请修复后再提交。`);
  lines.push(`\n### Diff 摘要\n\`\`\`diff\n${report.diffSummary}\n\`\`\``);
  return lines.join("\n");
}

const COMMIT_TEMPLATE_ZH =
  "请按以下流程执行一键提交（注意：绝对不要推送到远程仓库）：\n\n" +
  "## 第一步：扫描工作目录\n" +
  "调用 git_scan 工具扫描当前工作目录的所有变更。\n\n" +
  "## 第二步：分析与分类\n" +
  "基于扫描结果，分析所有变更文件：\n" +
  "- 检查各分类文件的变更是否合理\n" +
  "- 识别是否包含不应提交的文件（如构建产物、临时文件等）\n" +
  "- 判断哪些变更应作为一个提交，哪些需要拆为多个提交\n" +
  "- 如发现可疑文件，向用户说明并建议排除\n\n" +
  "## 第三步：暂存文件\n" +
  "根据分析结果，调用 git_stage 工具暂存需要提交的文件。\n" +
  "- 如果所有文件都应提交，使用 mode='all'\n" +
  "- 如果部分文件需要排除，使用 mode='files' 并指定具体文件列表\n\n" +
  "## 第四步：预提交检查\n" +
  "调用 pre_commit_check 工具检查暂存区的代码质量。\n" +
  "- 如检查未通过（存在 error 级别问题），向用户报告问题及修复建议，不要提交\n" +
  "- 如只有 warning/info，可以继续提交，但在提交信息中注明\n\n" +
  "## 第五步：代码审查\n" +
  "基于预提交检查返回的 diff 内容，对本次改动逐文件进行代码审查。从以下方面分析：\n" +
  "- **逻辑正确性**：是否存在逻辑错误、边界条件遗漏、空指针/未定义引用\n" +
  "- **潜在 Bug**：竞态条件、资源泄漏、异常处理缺失、类型不匹配\n" +
  "- **代码质量**：重复代码、过长函数、命名不清晰、魔法数字\n" +
  "- **性能隐患**：不必要的循环、N+1 查询、内存分配过大\n" +
  "- **兼容性**：是否存在破坏性变更未注明、API 接口变动\n\n" +
  "以结构化方式呈现：\n" +
  "- 如发现严重问题（可能导致 Bug 或崩溃），列出问题并给出修复建议，**不要提交**\n" +
  "- 如发现改进建议（非阻塞），列出建议但继续提交流程\n" +
  "- 如代码质量良好，简要说明审查通过\n\n" +
  "## 第六步：生成提交信息并提交\n" +
  "如果所有检查和审查通过：\n" +
  "1. 基于 diff 数据分析本次改动的目的和范围\n" +
  "2. 生成一条符合 Conventional Commits 规范的**中文**提交信息\n" +
  "3. 格式: <type>(<scope>): <简要描述>，type 为 feat/fix/refactor/docs/chore/test/style/perf/ci/build\n" +
  "4. 如果改动涉及多个方面，可在 body 中补充说明\n" +
  "5. 调用 git_commit 工具执行提交\n\n" +
  " 重要：不要执行 git push，仅本地提交。";

const COMMIT_TEMPLATE_EN =
  "Follow this workflow to perform a one-click commit (IMPORTANT: Do NOT push to remote):\n\n" +
  "## Step 1: Scan Working Directory\n" +
  "Call git_scan tool to scan all changes in the working directory.\n\n" +
  "## Step 2: Analyze & Classify\n" +
  "Based on scan results, analyze all changed files:\n" +
  "- Check if changes in each category are reasonable\n" +
  "- Identify files that should NOT be committed (build artifacts, temp files, etc.)\n" +
  "- Determine if changes should be one commit or split into multiple\n" +
  "- If suspicious files found, explain to user and suggest exclusion\n\n" +
  "## Step 3: Stage Files\n" +
  "Based on analysis, call git_stage tool to stage files for commit.\n" +
  "- If all files should be committed, use mode='all'\n" +
  "- If some files should be excluded, use mode='files' with specific file list\n\n" +
  "## Step 4: Pre-commit Check\n" +
  "Call pre_commit_check tool to check code quality of staged files.\n" +
  "- If checks fail (error-level issues), report issues with fix suggestions, do NOT commit\n" +
  "- If only warnings/info, proceed but note them in commit message\n\n" +
  "## Step 5: Code Review\n" +
  "Based on the diff content returned by pre-commit check, perform a code review on all changes. Analyze each file for:\n" +
  "- **Correctness**: Logic errors, missing edge cases, null/undefined references\n" +
  "- **Potential Bugs**: Race conditions, resource leaks, missing error handling, type mismatches\n" +
  "- **Code Quality**: Code duplication, overly long functions, unclear naming, magic numbers\n" +
  "- **Performance**: Unnecessary loops, N+1 queries, excessive memory allocation\n" +
  "- **Compatibility**: Breaking changes not documented, API contract changes\n\n" +
  "Present review results in a structured format:\n" +
  "- If critical issues found (likely to cause bugs or failures), list them with fix suggestions and do NOT commit\n" +
  "- If improvement suggestions found (non-blocking), list them but continue the commit flow\n" +
  "- If code quality is good, briefly confirm the review passed\n\n" +
  "## Step 6: Generate Commit Message & Commit\n" +
  "If all checks and review pass:\n" +
  "1. Analyze the diff to understand the purpose and scope of changes\n" +
  "2. Generate a commit message following Conventional Commits in English\n" +
  "3. Format: <type>(<scope>): <short description>\n" +
  "4. If changes span multiple areas, add details in the body\n" +
  "5. Call git_commit tool to execute the commit\n\n" +
  "IMPORTANT: Do NOT git push. Local commit only.";

const GITIGNORE_TEMPLATE =
  "请按以下流程为项目生成 .gitignore：\n\n" +
  "## 第一步：扫描项目\n" +
  "调用 gitignore_scan 工具扫描项目结构，获取检测报告。\n\n" +
  "## 第二步：分析与建议\n" +
  "基于扫描报告中的建议，分析项目的特殊性：\n" +
  "- 检查每个建议是否合理\n" +
  "- 判断是否存在遗漏的忽略规则（比如项目中的临时文件、缓存目录等）\n" +
  "- 对比项目的 .gitignore，哪些规则需要新增，哪些已经存在\n" +
  "- 向用户展示最终的分析结果和建议的 .gitignore 内容\n\n" +
  "## 第三步：确认并写入\n" +
  "向用户展示最终的 .gitignore 内容，经确认后\n" +
  "- 调用 gitignore_write 工具写入 .gitignore 文件\n" +
  "- 如用户希望调整，根据反馈修改后再写入\n\n" +
  "注意事项：\n" +
  "- 生成的 .gitignore 应包含注释，每类规则注明说明\n" +
  "- 如已存在 .gitignore，新增内容会与原有合并，不要删除用户已有的规则\n" +
  "- 宁可保守策略，宁可多忽略也不要遗漏应忽略的文件";

function commandText(template: string, userText: string, label: string): string {
  const extra = (userText ?? "").trim();
  return extra ? `${template}\n\n## ${label}\n${extra}` : template;
}

/** 改写 prompt.text 后原 @mention 偏移失效，需剥离 mention 字段。 */
function stripMentions<T>(items: readonly T[] | undefined): T[] | undefined {
  if (!items || items.length === 0) return undefined;
  return items.map((item) => {
    const { mention: _mention, ...rest } = item as T & { mention?: unknown };
    return rest as unknown as T;
  });
}

const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;

const plugin = Plugin.define({
  id: "madoka.git-check",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "git_scan",
        description:
          "扫描 git 工作目录的所有变更（已暂存、未暂存、未追踪），按文件类型自动分类（源码、配置、文档、测试、样式、资源、构建产物等），返回结构化报告供 AI 分析决策。",
        input: { ...EMPTY_INPUT },
        async execute(_input, toolContext) {
          const worktree = await resolveWorktree(ctx, toolContext.sessionID);
          const report = await scanWorkingTree(createShell({ signal: toolContext.signal }), worktree);
          return { content: formatScanReport(report) };
        },
      });

      editor.add({
        name: "git_stage",
        description:
          "暂存指定文件到 git 暂存区（git add）。mode='all' 暂存所有变更，mode='files' 暂存指定文件列表。",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["all", "files"],
              description: "暂存模式: 'all' 暂存所有变更, 'files' 暂存指定文件",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "mode='files' 时必填，要暂存的文件路径列表",
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        async execute(input, toolContext) {
          const args = input as { mode?: "all" | "files"; files?: string[] };
          const worktree = await resolveWorktree(ctx, toolContext.sessionID);
          const $ = createShell({ signal: toolContext.signal });
          if (args.mode === "all") {
            const result = await stageAll($, worktree);
            return { content: result.message };
          }
          if (!args.files || args.files.length === 0) {
            return { content: "mode='files' 时必须提供 files 参数。" };
          }
          const result = await stageFiles($, worktree, args.files);
          return { content: result.message };
        },
      });

      editor.add({
        name: "pre_commit_check",
        description:
          "检查 git 暂存区的代码质量。检测冲突标记、调试语句、敏感信息、大文件、TODO 标记等问题，并返回 diff 内容供 AI 代码审查。",
        input: { ...EMPTY_INPUT },
        async execute(_input, toolContext) {
          const worktree = await resolveWorktree(ctx, toolContext.sessionID);
          const report = await runPreCommitChecks(createShell({ signal: toolContext.signal }), worktree);
          return { content: formatCheckReport(report) };
        },
      });

      editor.add({
        name: "git_commit",
        description:
          "使用指定的提交信息执行 git commit（仅本地提交，不推送）。应在 pre_commit_check 通过后调用。",
        input: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Conventional Commits 格式的提交信息",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
        async execute(input, toolContext) {
          const args = input as { message?: string };
          const message = (args.message ?? "").trim();
          const worktree = await resolveWorktree(ctx, toolContext.sessionID);
          const result = await executeCommit(createShell({ signal: toolContext.signal }), worktree, message);
          if (result.success) {
            return {
              content: `提交成功！\n\n提交信息: ${message}\n提交哈希: ${result.commitHash || "N/A"}\n\n${result.message}\n\n💡 提示：提交仅在本地，未推送到远程仓库。`,
            };
          }
          return { content: `提交失败:\n\n${result.message}` };
        },
      });

      editor.add({
        name: "gitignore_scan",
        description:
          "扫描项目结构，分析应添加到 .gitignore 的文件和目录。自动检测语言/框架（Node.js、Python、Rust、Go、Java 等）、编辑器配置、AI 工具产物、构建输出、系统文件等，返回当前 .gitignore 状态和建议新增的忽略规则。",
        input: { ...EMPTY_INPUT },
        async execute(_input, toolContext) {
          const worktree = await resolveWorktree(ctx, toolContext.sessionID);
          const report = await scanForIgnore(createShell({ signal: toolContext.signal }), worktree);
          return { content: formatIgnoreScanReport(report) };
        },
      });

      editor.add({
        name: "gitignore_write",
        description:
          "将指定内容写入项目的 .gitignore 文件。应在 gitignore_scan 分析并经用户确认后调用。",
        input: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "完整的 .gitignore 文件内容",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
        async execute(input, toolContext) {
          const args = input as { content?: string };
          const worktree = await resolveWorktree(ctx, toolContext.sessionID);
          const result = await writeGitignore(undefined, worktree, args.content ?? "");
          return { content: result.message };
        },
      });
    });

    await ctx.command.transform((editor) => {
      const register = (name: string, description: string, template: string, extraLabel: string) => {
        editor.add({
          name,
          description,
          async execute({ sessionID, prompt, delivery }) {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text: commandText(template, prompt.text, extraLabel),
              files: stripMentions(prompt.files),
              agents: stripMentions(prompt.agents),
              skills: stripMentions(prompt.skills),
              delivery,
            });
          },
        });
      };

      register("commit", "一键扫描、分类、检查并提交（中文提交信息，不推送）", COMMIT_TEMPLATE_ZH, "用户补充说明");
      register(
        "commit:en",
        "One-click scan, classify, check and commit (English, no push)",
        COMMIT_TEMPLATE_EN,
        "Additional instructions",
      );
      register("gitignore", "分析项目结构，智能生成/更新 .gitignore", GITIGNORE_TEMPLATE, "用户补充说明");
    });
  },
});

export default plugin;
