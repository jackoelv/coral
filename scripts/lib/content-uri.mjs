/** Public leaf file name. The chain URI is this file under CONTENT_URI. */
export function rootFileName(ido, root) {
  return `56-${String(ido).toLowerCase()}-${root}.json`;
}

/** CONTENT_URI is an https directory. The script appends the file name. */
export function contentUriFor(base, fileName) {
  const trimmed = String(base || "").trim();
  if (!trimmed) throw new Error("CONTENT_URI 未设置。填一个以 / 结尾的 https 目录，明细文件要先能从那里打开。");
  if (!/^https:\/\//i.test(trimmed)) throw new Error("CONTENT_URI 必须是 https 链接");
  if (!trimmed.endsWith("/")) throw new Error("CONTENT_URI 必须以 / 结尾，脚本会接上明细文件名");
  if (fileName.includes("/") || fileName.includes("..")) throw new Error("明细文件名不合法");
  return `${trimmed}${fileName}`;
}

/**
 * A content-URI publish repeats publishRoot with the current root.
 * It is refused when the root itself would change.
 */
export function decideContentUriPublish({ sameRoot, chainUri, nextUri }) {
  if (!sameRoot) {
    return { action: "refuse", message: "root、contentHash 或累计金额和链上不一致。--content-uri 只补链接，不改 root。" };
  }
  if (String(chainUri || "") === nextUri) {
    return { action: "skip", message: "链上 contentUri 已经是这个链接，不再签名。" };
  }
  return { action: "sign", message: "链上 contentUri 还不是这个链接。明细文件要先能打开，再加 --apply 签名。" };
}
