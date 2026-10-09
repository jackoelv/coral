import { formatUnits, parseUnits } from "viem";

/// 金额用 USDT 个数。`max` 表示当前 treasuryWithdrawable。
export function parseWithdrawAmount(text, maxWei, decimals = 18) {
  if (maxWei < 0n) throw new Error("可提取金额无效");
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("缺少 --amount。只查询上限时不要带 --amount 和 --to");
  if (raw.toLowerCase() === "max") {
    if (maxWei === 0n) throw new Error("当前可提取金额是 0");
    return maxWei;
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`金额格式不对：${raw}。用 USDT 数量，例如 1 或 1.5，或 max`);
  }
  const fraction = raw.split(".")[1] || "";
  if (fraction.length > decimals) throw new Error(`USDT 最多 ${decimals} 位小数`);
  const amount = parseUnits(raw, decimals);
  if (amount === 0n) throw new Error("金额必须大于 0");
  if (amount > maxWei) {
    throw new Error(`金额超过可提取上限 ${formatUnits(maxWei, decimals)} USDT`);
  }
  return amount;
}
