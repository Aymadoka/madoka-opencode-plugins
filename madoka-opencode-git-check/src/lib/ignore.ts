import * as fs from "node:fs/promises";
import * as path from "node:path";

interface IgnoreRule {
  markers: string[];
  dirMarkers: string[];
  patterns: string[];
  reason: string;
  category: string;
  ignoreEntries: string[];
}

const IGNORE_RULES: IgnoreRule[] = [
  { markers: ["package.json"], dirMarkers: ["node_modules"], patterns: [], reason: "Node.js 依赖目录应通过 npm install 恢复", category: "dependencies", ignoreEntries: ["node_modules/"] },
  { markers: ["Cargo.toml"], dirMarkers: ["target"], patterns: [], reason: "Rust 构建产物目录", category: "build", ignoreEntries: ["target/"] },
  { markers: ["go.mod"], dirMarkers: [], patterns: [], reason: "Go 模块缓存", category: "dependencies", ignoreEntries: ["vendor/"] },
  { markers: ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile"], dirMarkers: ["__pycache__", ".venv", "venv"], patterns: [], reason: "Python 缓存/虚拟环境", category: "runtime", ignoreEntries: ["__pycache__/", "*.pyc", "*.pyo", ".venv/", "venv/", ".eggs/", "*.egg-info/"] },
  { markers: ["composer.json"], dirMarkers: ["vendor"], patterns: [], reason: "PHP Composer 依赖目录", category: "dependencies", ignoreEntries: ["vendor/"] },
  { markers: ["Gemfile"], dirMarkers: [], patterns: [], reason: "Ruby 依赖", category: "dependencies", ignoreEntries: [".bundle/", "vendor/bundle/"] },
  { markers: ["build.gradle", "pom.xml"], dirMarkers: ["build", ".gradle"], patterns: [], reason: "Java/Kotlin 构建产物", category: "build", ignoreEntries: ["build/", ".gradle/", "*.class", "*.jar"] },
  { markers: ["Package.swift"], dirMarkers: [".build"], patterns: [], reason: "Swift 构建产物", category: "build", ignoreEntries: [".build/", "*.xcuserdata/", "DerivedData/"] },
  { markers: ["tsconfig.json"], dirMarkers: ["dist"], patterns: [], reason: "TypeScript 编译产物", category: "build", ignoreEntries: ["dist/", "*.tsbuildinfo"] },
  { markers: [], dirMarkers: ["dist", "build", "out", "_build"], patterns: [], reason: "通用构建输出目录", category: "build", ignoreEntries: ["dist/", "build/", "out/"] },
  { markers: [], dirMarkers: [".idea"], patterns: [], reason: "JetBrains IDE 配置", category: "editor", ignoreEntries: [".idea/"] },
  { markers: [], dirMarkers: [".vscode"], patterns: [], reason: "VS Code 配置", category: "editor", ignoreEntries: [".vscode/"] },
  { markers: [], dirMarkers: [], patterns: ["*.sublime-*"], reason: "Sublime Text 配置", category: "editor", ignoreEntries: ["*.sublime-project", "*.sublime-workspace"] },
  { markers: [], dirMarkers: [], patterns: [".DS_Store"], reason: "macOS 系统文件", category: "os", ignoreEntries: [".DS_Store"] },
  { markers: [], dirMarkers: [], patterns: ["Thumbs.db", "desktop.ini"], reason: "Windows 系统文件", category: "os", ignoreEntries: ["Thumbs.db", "desktop.ini"] },
  { markers: [], dirMarkers: [".sisyphus"], patterns: [], reason: "Sisyphus AI 持久化目录", category: "ai", ignoreEntries: [".sisyphus/"] },
  { markers: [], dirMarkers: [".cursor"], patterns: [], reason: "Cursor AI 编辑器配置", category: "ai", ignoreEntries: [".cursor/"] },
  { markers: [], dirMarkers: [".aider*"], patterns: [], reason: "Aider AI 备份/补丁", category: "ai", ignoreEntries: [".aider*"] },
  { markers: [], dirMarkers: [".copilot"], patterns: [], reason: "GitHub Copilot 配置", category: "ai", ignoreEntries: [".copilot/"] },
  { markers: [], dirMarkers: [".claude"], patterns: [], reason: "Claude Code 工作目录", category: "ai", ignoreEntries: [".claude/"] },
  { markers: [], dirMarkers: ["coverage", ".nyc_output"], patterns: [], reason: "测试覆盖率报告", category: "test", ignoreEntries: ["coverage/", ".nyc_output/"] },
  { markers: [], dirMarkers: [], patterns: [".env", ".env.local", ".env.*.local"], reason: "环境变量文件（可能包含敏感信息）", category: "misc", ignoreEntries: [".env", ".env.local", ".env.*.local"] },
  { markers: [], dirMarkers: [], patterns: ["*.log", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*"], reason: "日志文件", category: "misc", ignoreEntries: ["*.log", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*"] },
  { markers: [], dirMarkers: [], patterns: ["*.swp", "*.swo", "*~"], reason: "编辑器临时文件（Vim 等）", category: "editor", ignoreEntries: ["*.swp", "*.swo", "*~"] },
  { markers: [], dirMarkers: [], patterns: ["*.tgz", "*.tar.gz", "*.zip"], reason: "压缩包 / npm 产物", category: "misc", ignoreEntries: ["*.tgz"] },
  { markers: [], dirMarkers: [".terraform"], patterns: [], reason: "Terraform 状态和插件缓存", category: "runtime", ignoreEntries: [".terraform/", "*.tfstate", "*.tfstate.backup"] },
  { markers: ["docker-compose.yml", "Dockerfile"], dirMarkers: [], patterns: [], reason: "Docker 运行时数据", category: "runtime", ignoreEntries: [".docker/"] },
  { markers: [], dirMarkers: [".next"], patterns: [], reason: "Next.js 构建产物", category: "build", ignoreEntries: [".next/"] },
  { markers: [], dirMarkers: [".nuxt"], patterns: [], reason: "Nuxt.js 构建产物", category: "build", ignoreEntries: [".nuxt/"] },
  { markers: [], dirMarkers: [".turbo"], patterns: [], reason: "Turborepo 缓存", category: "build", ignoreEntries: [".turbo/"] },
];

export interface IgnoreScanReport {
  currentIgnore: string | null;
  trackedDirs: string[];
  trackedFiles: string[];
  configFiles: string[];
  suggestions: { pattern: string; reason: string; category: string; detected: string[] }[];
}

export async function scanForIgnore($: any, worktree: string): Promise<IgnoreScanReport> {
  let currentIgnore: string | null = null;
  try {
    currentIgnore = await fs.readFile(path.join(worktree, ".gitignore"), "utf-8");
  } catch { /* no .gitignore */ }

  const existingPatterns = new Set<string>();
  if (currentIgnore) {
    for (const line of currentIgnore.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) existingPatterns.add(trimmed);
    }
  }

  // 用 fs 替代 shell，更可靠且跨平台
  let entries: string[] = [];
  try { entries = await fs.readdir(worktree); } catch { entries = []; }
  // 过滤隐藏无关？保留全部
  entries = entries.filter((e) => e !== ".git");

  const trackedDirs: string[] = [];
  const trackedFiles: string[] = [];
  for (const entry of entries) {
    try {
      const stat = await fs.stat(path.join(worktree, entry));
      if (stat.isDirectory()) trackedDirs.push(entry);
      else trackedFiles.push(entry);
    } catch { trackedFiles.push(entry); }
  }

  let configFiles: string[] = [];
  try {
    const gitFiles = await $`git -C ${worktree} ls-files`;
    configFiles = gitFiles.stdout.toString().trim().split("\n").filter(Boolean) as string[];
  } catch { configFiles = trackedFiles; }

  const allItems = [...trackedDirs, ...trackedFiles, ...configFiles];
  const suggestions: IgnoreScanReport["suggestions"] = [];

  for (const rule of IGNORE_RULES) {
    const detected: string[] = [];
    for (const marker of rule.markers) {
      if (allItems.some((item) => item === marker || item.endsWith(`/${marker}`))) detected.push(marker);
    }
    for (const dirMarker of rule.dirMarkers) {
      // 支持 glob 如 .aider*
      if (dirMarker.includes("*")) {
        const prefix = dirMarker.replace("*", "");
        if (trackedDirs.some((d) => d.startsWith(prefix))) detected.push(dirMarker + "/");
      } else if (trackedDirs.some((d) => d === dirMarker)) detected.push(`${dirMarker}/`);
    }
    for (const pattern of rule.patterns) {
      if (allItems.some((item) => matchSimpleGlob(item, pattern))) detected.push(pattern);
    }
    if (detected.length > 0) {
      const newEntries = rule.ignoreEntries.filter((e) => !existingPatterns.has(e));
      if (newEntries.length > 0) {
        suggestions.push({ pattern: newEntries.join(", "), reason: rule.reason, category: rule.category, detected });
      }
    }
  }

  return { currentIgnore, trackedDirs, trackedFiles, configFiles, suggestions };
}

function matchSimpleGlob(filename: string, pattern: string): boolean {
  if (pattern === filename) return true;
  if (pattern.startsWith("*.")) return filename.endsWith(pattern.slice(1));
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return re.test(filename);
  }
  return false;
}

export function formatIgnoreScanReport(report: IgnoreScanReport): string {
  const lines: string[] = [];
  lines.push("## .gitignore 扫描报告\n");
  if (report.currentIgnore) {
    lines.push("### 当前 .gitignore\n");
    lines.push("```");
    lines.push(report.currentIgnore.trim());
    lines.push("```\n");
  } else {
    lines.push("### 当前状态\n");
    lines.push("项目中尚未创建 .gitignore 文件。\n");
  }
  lines.push("### 项目结构\n");
  lines.push(`目录: ${report.trackedDirs.join(", ") || "(空)"}`);
  lines.push(`文件: ${report.trackedFiles.join(", ") || "(空)"}\n`);

  if (report.suggestions.length === 0) {
    lines.push("### 检测结果\n");
    lines.push("当前 .gitignore 已覆盖所有检测到的忽略项，无需修改。");
  } else {
    lines.push("### 建议新增的忽略规则\n");
    const grouped = new Map<string, typeof report.suggestions>();
    for (const s of report.suggestions) {
      const arr = grouped.get(s.category) || [];
      arr.push(s);
      grouped.set(s.category, arr);
    }
    const categoryLabels: Record<string, string> = {
      dependencies: "依赖", build: "构建产物", editor: "编辑器", os: "操作系统",
      runtime: "运行时", ai: "AI 工具", test: "测试", misc: "其他",
    };
    for (const [cat, items] of grouped) {
      lines.push(`**${categoryLabels[cat] ?? cat}**\n`);
      lines.push("| 规则 | 原因 | 触发文件 |");
      lines.push("| ---- | ---- | -------- |");
      for (const item of items) {
        lines.push(`| \`${item.pattern}\` | ${item.reason} | ${item.detected.map((d) => `\`${d}\``).join(", ")} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export async function writeGitignore(_$: any, worktree: string, content: string) {
  try {
    const target = path.join(worktree, ".gitignore");
    // 确保末尾换行
    const normalized = content.endsWith("\n") ? content : content + "\n";
    await fs.writeFile(target, normalized, "utf-8");
    return { success: true, message: ".gitignore 已更新。" };
  } catch (err: any) {
    return { success: false, message: `写入 .gitignore 失败: ${err.message || "未知错误"}` };
  }
}
