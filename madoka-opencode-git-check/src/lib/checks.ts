export interface CheckIssue {
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
}

export interface CheckReport {
  passed: boolean;
  issues: CheckIssue[];
  stagedFiles: string[];
  diffSummary: string;
  diffStat: string;
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})\s/;

const DEBUG_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bconsole\.(log|debug|info)\s*\(/, label: "console.log/debug/info" },
  { pattern: /\bdebugger\b/, label: "debugger" },
  { pattern: /\bprint\s*\((?!.*file=)/, label: "print()" },
  { pattern: /\bfmt\.Print(ln|f)?\s*\(/, label: "fmt.Print" },
  { pattern: /\bSystem\.out\.print/, label: "System.out.print" },
  { pattern: /\bvar_dump\s*\(/, label: "var_dump()" },
  { pattern: /\bdd\s*\(/, label: "dd()" },
  { pattern: /\bNSLog\s*\(/, label: "NSLog()" },
  { pattern: /\blog\.(debug|info|trace)\s*\(/, label: "log.debug/info/trace" },
];

const SENSITIVE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']+["']/i, label: "硬编码密码" },
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']+["']/i, label: "硬编码 API Key" },
  { pattern: /(?:secret|token)\s*[:=]\s*["'][A-Za-z0-9+/=]{16,}["']/i, label: "硬编码密钥/Token" },
  { pattern: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/, label: "AWS Access Key ID" },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, label: "私钥文件内容" },
];

const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024;

export async function runPreCommitChecks($: any, worktree: string): Promise<CheckReport> {
  const issues: CheckIssue[] = [];
  const stagedResult = await $`git -C ${worktree} diff --cached --name-only`;
  const stagedFiles = stagedResult.stdout.toString().trim().split("\n").filter(Boolean) as string[];

  if (stagedFiles.length === 0) {
    return {
      passed: false,
      issues: [{ type: "no-staged-files", severity: "error", message: "暂存区没有任何文件，请先使用 git add 添加要提交的文件。" }],
      stagedFiles: [], diffSummary: "", diffStat: "",
    };
  }

  const [diffStatResult, diffResult] = await Promise.all([
    $`git -C ${worktree} diff --cached --stat`,
    $`git -C ${worktree} diff --cached`,
  ]);
  const diffStat = diffStatResult.stdout.toString().trim();
  const fullDiff = diffResult.stdout.toString();
  const MAX_DIFF_LENGTH = 30_000;
  const diffSummary = fullDiff.length > MAX_DIFF_LENGTH
    ? fullDiff.slice(0, MAX_DIFF_LENGTH) + `\n\n... [diff 已截断，共 ${fullDiff.length} 字符，仅显示前 ${MAX_DIFF_LENGTH} 字符]`
    : fullDiff;

  for (const file of stagedFiles) {
    let content: string;
    try {
      const blobResult = await $`git -C ${worktree} show :${file}`;
      content = blobResult.stdout.toString();
    } catch { continue; }

    const lines = content.split("\n");
    let addedLines: { lineNo: number; text: string }[];
    try {
      const diffFileResult = await $`git -C ${worktree} diff --cached -U0 -- ${file}`;
      addedLines = parseAddedLines(diffFileResult.stdout.toString());
    } catch {
      addedLines = lines.map((text: string, i: number) => ({ lineNo: i + 1, text }));
    }

    checkConflictMarkers(addedLines, file, issues);
    checkDebugStatements(addedLines, file, issues);
    checkSensitiveInfo(addedLines, file, issues);
    checkTodoMarkers(addedLines, file, issues);
    checkFileSize(content, file, issues);
  }

  const lintIssues = await runProjectLint($, worktree);
  issues.push(...lintIssues);

  const hasErrors = issues.some((i) => i.severity === "error");
  return { passed: !hasErrors, issues, stagedFiles, diffSummary, diffStat };
}

function checkConflictMarkers(addedLines: { lineNo: number; text: string }[], file: string, issues: CheckIssue[]) {
  for (const { lineNo, text } of addedLines) {
    if (CONFLICT_MARKER_RE.test(text)) {
      issues.push({ type: "conflict-marker", severity: "error", message: "存在未解决的合并冲突标记", file, line: lineNo });
    }
  }
}
function checkDebugStatements(addedLines: { lineNo: number; text: string }[], file: string, issues: CheckIssue[]) {
  for (const { lineNo, text } of addedLines) {
    for (const { pattern, label } of DEBUG_PATTERNS) {
      if (pattern.test(text)) {
        issues.push({ type: "debug-statement", severity: "warning", message: `发现可能的调试语句: ${label}`, file, line: lineNo });
        break;
      }
    }
  }
}
function checkSensitiveInfo(addedLines: { lineNo: number; text: string }[], file: string, issues: CheckIssue[]) {
  for (const { lineNo, text } of addedLines) {
    for (const { pattern, label } of SENSITIVE_PATTERNS) {
      if (pattern.test(text)) {
        issues.push({ type: "sensitive-info", severity: "error", message: `可能包含${label}`, file, line: lineNo });
        break;
      }
    }
  }
}
function checkTodoMarkers(addedLines: { lineNo: number; text: string }[], file: string, issues: CheckIssue[]) {
  for (const { lineNo, text } of addedLines) {
    const match = text.match(/\b(TODO|FIXME|HACK|XXX)\b/);
    if (match) issues.push({ type: "todo-marker", severity: "info", message: `包含 ${match[1]} 标记`, file, line: lineNo });
  }
}
function checkFileSize(content: string, file: string, issues: CheckIssue[]) {
  const sizeInBytes = new TextEncoder().encode(content).byteLength;
  if (sizeInBytes > LARGE_FILE_THRESHOLD) {
    const sizeMB = (sizeInBytes / 1024 / 1024).toFixed(2);
    issues.push({ type: "large-file", severity: "warning", message: `文件体积过大 (${sizeMB} MB)，请确认是否需要提交`, file });
  }
}

function parseAddedLines(diffContent: string): { lineNo: number; text: string }[] {
  const result: { lineNo: number; text: string }[] = [];
  const lines = diffContent.split("\n");
  let currentLine = 0;
  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) { currentLine = parseInt(hunkMatch[1], 10); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({ lineNo: currentLine, text: line.slice(1) });
      currentLine++;
    } else if (!line.startsWith("-") && !line.startsWith("---")) {
      currentLine++;
    }
  }
  return result;
}

async function runProjectLint($: any, worktree: string): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const pkgContent = await fs.readFile(path.join(worktree, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgContent);
    const scripts = pkg.scripts || {};
    const lintScript = (["lint", "lint:check", "check"] as const).find((name) => scripts[name]);
    if (lintScript) {
      try {
        const shell = typeof $?.cwd === "function" ? $.cwd(worktree) : $;
        await shell`npm run ${lintScript} --silent`;
      } catch (lintError: any) {
        const output = [lintError.stdout?.toString() || "", lintError.stderr?.toString() || ""].filter(Boolean).join("\n").trim();
        if (output) {
          issues.push({ type: "lint-error", severity: "warning", message: `项目 lint (npm run ${lintScript}) 输出:\n${output.slice(0, 2000)}` });
        }
      }
    }
  } catch { /* no package.json */ }
  return issues;
}
