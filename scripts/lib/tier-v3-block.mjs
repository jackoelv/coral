export const DEFAULT_LEAD_BLOCKS = 6000n;

function flag(argv, name) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const pos = argv.indexOf(`--${name}`);
  if (pos >= 0 && argv[pos + 1] && !argv[pos + 1].startsWith("--")) return argv[pos + 1];
  return "";
}

export function parseTierArgs(argv) {
  const raw = flag(argv, "block");
  return { apply: argv.includes("--apply"), block: raw ? parseBlock(raw, "--block") : null };
}

export function parseBlock(raw, name) {
  const text = (raw || "").trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} 必须是大于 0 的区块号`);
  return BigInt(text);
}

/** A switch block the indexer has not scanned, and that is still ahead of the chain head. */
export function chooseSwitchBlock({ head, indexed = null, requested = null, lead = DEFAULT_LEAD_BLOCKS }) {
  if (typeof head !== "bigint" || head < 0n) throw new Error("链头不对");
  const target = requested == null ? head + lead : requested;
  if (target <= head) throw new Error(`切换区块 ${target} 必须晚于当前链头 ${head}`);
  if (indexed != null && target <= indexed) {
    throw new Error(`切换区块 ${target} 不晚于索引检查点 ${indexed}。已经扫过的入金不会重算。`);
  }
  return target;
}
