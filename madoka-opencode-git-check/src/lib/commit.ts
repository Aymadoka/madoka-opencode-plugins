export async function executeCommit($: any, worktree: string, commitMessage: string) {
  if (!commitMessage.trim()) return { success: false, message: "提交信息不能为空。" };
  try {
    const result = await $`git -C ${worktree} commit -m ${commitMessage}`;
    const output = result.stdout.toString().trim();
    const hashMatch = output.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
    const commitHash = hashMatch?.[1];
    return { success: true, message: output, commitHash };
  } catch (err: any) {
    const output = [err.stderr?.toString() || "", err.stdout?.toString() || ""].filter(Boolean).join("\n").trim();
    return { success: false, message: `git commit 失败:\n${output || "未知错误"}` };
  }
}
