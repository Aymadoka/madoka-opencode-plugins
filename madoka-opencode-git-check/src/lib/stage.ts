export async function stageFiles($: any, worktree: string, files: string[]) {
  if (files.length === 0) return { success: false, stagedFiles: [] as string[], message: "没有指定要暂存的文件。" };
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try { await $`git -C ${worktree} add -- ${file}`; succeeded.push(file); }
    catch { failed.push(file); }
  }
  if (failed.length > 0) {
    return {
      success: succeeded.length > 0,
      stagedFiles: succeeded,
      message: `暂存了 ${succeeded.length} 个文件。\n另有 ${failed.length} 个文件暂存失败: ${failed.map((f) => `\`${f}\``).join(", ")}`,
    };
  }
  return { success: true, stagedFiles: succeeded, message: `成功暂存 ${succeeded.length} 个文件。` };
}

export async function stageAll($: any, worktree: string) {
  try {
    await $`git -C ${worktree} add -A`;
    const result = await $`git -C ${worktree} diff --cached --name-only`;
    const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean) as string[];
    return { success: true, stagedFiles, message: `成功暂存全部变更 (${stagedFiles.length} 个文件)。` };
  } catch (err: any) {
    return { success: false, stagedFiles: [] as string[], message: `git add -A 失败: ${err.stderr?.toString() || "未知错误"}` };
  }
}
