/** Mainnet NFT interest weeks end at Sunday 00:00:00 Asia/Shanghai. */

export const FIRST_SUNDAY_BEIJING = 230400n;
export const WEEK_SECONDS = 7n * 24n * 60n * 60n;

export function interestWeek(timestamp) {
  const ts = BigInt(timestamp);
  if (ts < FIRST_SUNDAY_BEIJING) return 0n;
  return (ts - FIRST_SUNDAY_BEIJING) / WEEK_SECONDS;
}

/** Unix time when week `week` starts. Block N is the last block strictly before the next boundary. */
export function weekBoundary(week) {
  return FIRST_SUNDAY_BEIJING + BigInt(week) * WEEK_SECONDS;
}
