const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyx", ".pyi",
  ".go", ".rs",
  ".java", ".kt", ".kts", ".scala",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
  ".cs", ".swift", ".rb", ".php", ".lua",
  ".sh", ".bash", ".zsh", ".fish",
  ".pl", ".pm", ".r", ".R", ".dart",
  ".ex", ".exs", ".zig", ".v", ".sv", ".sql",
  ".vue", ".svelte",
]);
const CONFIG_EXTENSIONS = new Set([
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".env", ".xml", ".properties", ".plist",
]);
const CONFIG_FILENAMES = new Set([
  "tsconfig.json", "jsconfig.json",
  "package.json", "package-lock.json",
  "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.ts",
  ".prettierrc", ".prettierrc.js", ".prettierrc.json",
  "prettier.config.js", "prettier.config.mjs",
  "vite.config.ts", "vite.config.js",
  "webpack.config.js", "webpack.config.ts",
  "rollup.config.js", "rollup.config.ts",
  "next.config.js", "next.config.mjs", "next.config.ts",
  "nuxt.config.ts", "nuxt.config.js",
  "tailwind.config.js", "tailwind.config.ts",
  "postcss.config.js", "postcss.config.mjs",
  ".babelrc", "babel.config.js",
  "Makefile", "CMakeLists.txt",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  ".dockerignore", ".gitignore", ".gitattributes", ".editorconfig",
  "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
  "Gemfile", "Gemfile.lock",
  "requirements.txt", "Pipfile", "Pipfile.lock", "pyproject.toml", "setup.py", "setup.cfg",
  "biome.json", "biome.jsonc", "deno.json", "deno.jsonc",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".org"]);
const DOC_FILENAMES = new Set([
  "LICENSE", "LICENSE.md", "LICENSE.txt",
  "CHANGELOG", "CHANGELOG.md",
  "CONTRIBUTING", "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md", "SECURITY.md",
]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".styl", ".pcss"]);
const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp",
  ".mp4", ".webm", ".avi", ".mov", ".mkv",
  ".mp3", ".wav", ".ogg", ".flac", ".aac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".wasm",
]);
const BUILD_DIRS = ["dist/", "build/", "out/", ".next/", ".nuxt/", "target/", "__pycache__/", ".cache/"];

function getExtension(filePath: string): string {
  const base = filePath.split("/").pop() || "";
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return base.slice(dotIndex).toLowerCase();
}
function getFilename(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}
function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (/\/(tests?|spec|__tests__|e2e|__mocks__|__fixtures__|fixtures)\//i.test("/" + lower)) return true;
  const filename = getFilename(lower);
  return /\.(test|spec)\./i.test(filename) || /_(test|spec)\./i.test(filename);
}
function isBuildArtifact(filePath: string): boolean {
  return BUILD_DIRS.some((dir) => filePath.startsWith(dir));
}

export type FileCategory = "source" | "config" | "docs" | "test" | "style" | "asset" | "build" | "other";
export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";

export interface FileChange {
  file: string;
  status: FileStatus;
  category: FileCategory;
  additions?: number;
  deletions?: number;
  oldFile?: string;
}

export interface ScanReport {
  categories: Record<FileCategory, FileChange[]>;
  allFiles: FileChange[];
  stagedFiles: string[];
  branch: string;
  unpushedCommits: number;
}

export function classifyFile(filePath: string): FileCategory {
  if (isBuildArtifact(filePath)) return "build";
  if (isTestFile(filePath)) return "test";
  const filename = getFilename(filePath);
  const ext = getExtension(filePath);
  if (CONFIG_FILENAMES.has(filename)) return "config";
  if (DOC_FILENAMES.has(filename)) return "docs";
  if (/^readme/i.test(filename)) return "docs";
  if (STYLE_EXTENSIONS.has(ext)) return "style";
  if (ASSET_EXTENSIONS.has(ext)) return "asset";
  if (DOC_EXTENSIONS.has(ext)) return "docs";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  if (filename.startsWith(".env")) return "config";
  return "other";
}

const STATUS_MAP: Record<string, FileStatus> = {
  "M": "modified", "A": "added", "D": "deleted",
  "R": "renamed", "C": "copied", "?": "untracked",
};
function parseStatusCode(code: string): FileStatus {
  return STATUS_MAP[code.charAt(0)] || "modified";
}

export async function scanWorkingTree($: any, worktree: string): Promise<ScanReport> {
  const [statusResult, branchResult, stagedResult] = await Promise.all([
    $`git -C ${worktree} status --porcelain=v1`,
    $`git -C ${worktree} branch --show-current`,
    $`git -C ${worktree} diff --cached --name-only`,
  ]);
  let aheadResult: any;
  try {
    aheadResult = await $`git -C ${worktree} rev-list --count @{upstream}..HEAD`;
  } catch {
    aheadResult = { stdout: Buffer.from("0"), exitCode: 0 } as any;
  }
  if (aheadResult.exitCode !== undefined && aheadResult.exitCode !== 0) {
    aheadResult = { stdout: Buffer.from("0"), exitCode: 0 } as any;
  }

  const branch = branchResult.stdout.toString().trim() || "HEAD";
  const unpushedCommits = parseInt(aheadResult.stdout.toString().trim(), 10) || 0;
  const stagedFiles = stagedResult.stdout.toString().trim().split("\n").filter(Boolean) as string[];

  const allFiles: FileChange[] = [];
  const statusLines = statusResult.stdout.toString().trim().split("\n").filter(Boolean) as string[];

  for (const line of statusLines) {
    const indexStatus = line.charAt(0);
    const worktreeStatus = line.charAt(1);
    const rest = line.slice(3);
    let filePath: string;
    let oldFile: string | undefined;
    if (rest.includes(" -> ")) {
      const parts = rest.split(" -> ");
      oldFile = parts[0].trim();
      filePath = parts[1].trim();
    } else {
      filePath = rest.trim();
    }
    let status: FileStatus;
    if (indexStatus === "?" || worktreeStatus === "?") status = "untracked";
    else if (indexStatus !== " " && indexStatus !== "?") status = parseStatusCode(indexStatus);
    else status = parseStatusCode(worktreeStatus);

    const category = classifyFile(filePath);
    allFiles.push({ file: filePath, status, category, ...(oldFile ? { oldFile } : {}) });
  }

  // numstat 统计增删行
  const nonDeletedTextFiles = allFiles.filter((f) => f.status !== "deleted" && !ASSET_EXTENSIONS.has(getExtension(f.file)));
  if (nonDeletedTextFiles.length > 0) {
    try {
      const [cachedStat, worktreeStat] = await Promise.all([
        $`git -C ${worktree} diff --cached --numstat`,
        $`git -C ${worktree} diff --numstat`,
      ]);
      const statsMap = new Map<string, { additions: number; deletions: number }>();
      for (const raw of [cachedStat.stdout.toString(), worktreeStat.stdout.toString()]) {
        for (const statLine of (raw as string).split("\n").filter(Boolean)) {
          const parts = (statLine as string).split("\t");
          if (parts.length >= 3) {
            const additions = parseInt(parts[0], 10) || 0;
            const deletions = parseInt(parts[1], 10) || 0;
            const file = parts[2];
            const existing = statsMap.get(file);
            if (existing) { existing.additions += additions; existing.deletions += deletions; }
            else statsMap.set(file, { additions, deletions });
          }
        }
      }
      for (const change of allFiles) {
        const stat = statsMap.get(change.file);
        if (stat) { change.additions = stat.additions; change.deletions = stat.deletions; }
      }
    } catch { /* ignore */ }
  }

  const categories: Record<FileCategory, FileChange[]> = {
    source: [], config: [], docs: [], test: [], style: [], asset: [], build: [], other: [],
  };
  for (const change of allFiles) categories[change.category].push(change);

  return { categories, allFiles, stagedFiles, branch, unpushedCommits };
}

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  source: "📦 源码", config: "⚙️ 配置", docs: "📄 文档", test: "🧪 测试",
  style: "🎨 样式", asset: "🖼️ 资源", build: "🏗️ 构建产物", other: "📁 其他",
};
const STATUS_LABELS: Record<FileStatus, string> = {
  added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", copied: "复制", untracked: "未追踪",
};

export function formatScanReport(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`## 工作目录扫描报告\n`);
  lines.push(`**分支**: \`${report.branch}\``);
  if (report.unpushedCommits > 0) lines.push(`**未推送提交**: ${report.unpushedCommits} 个`);
  lines.push(`**变更文件数**: ${report.allFiles.length} 个`);
  if (report.stagedFiles.length > 0) lines.push(`**已暂存文件**: ${report.stagedFiles.length} 个 (之前 git add)`);
  lines.push("");
  if (report.allFiles.length === 0) {
    lines.push("✅ 工作目录干净，没有任何变更");
    return lines.join("\n");
  }
  for (const [category, label] of Object.entries(CATEGORY_LABELS) as [FileCategory, string][]) {
    const files = report.categories[category];
    if (files.length === 0) continue;
    lines.push(`### ${label} (${files.length} 个文件)\n`);
    for (const f of files) {
      const statusTag = STATUS_LABELS[f.status] || f.status;
      const stats = f.additions !== undefined || f.deletions !== undefined ? ` (+${f.additions ?? 0}/-${f.deletions ?? 0})` : "";
      const rename = f.oldFile ? ` (来自 \`${f.oldFile}\`)` : "";
      const staged = report.stagedFiles.includes(f.file) ? " ✅已暂存" : "";
      lines.push(`- \`${f.file}\` — ${statusTag}${stats}${rename}${staged}`);
    }
    lines.push("");
  }
  const totalAdditions = report.allFiles.reduce((s, f) => s + (f.additions ?? 0), 0);
  const totalDeletions = report.allFiles.reduce((s, f) => s + (f.deletions ?? 0), 0);
  lines.push(`---`);
  lines.push(`**总计**: +${totalAdditions}/-${totalDeletions} 行`);
  return lines.join("\n");
}
