# localdev 市场推广模拟报告（第一阶段）

> 本报告由 `forge test --match-contract SimMarket` 根据链上实际记账生成，金额单位为整数 USDT（去掉 1e18）。

## 分支提醒

**禁止把 `localdev` 部署到 BSC 主网。** 本分支 `weekDuration = 30` 个区块，`currentWeek()` 用 `block.number`。主网必须改回 `7 days` + `block.timestamp`。构造函数已在 `chainid == 56` 拒绝部署。

## 模拟设定

- 地址：3000 个，每人预先打入 **10000 USDT**（开售前 mint + approve，不推进「周」）
- 邀请树：1 根 + 8 KOL + 24 团长 + 240 大使 + 2400 叶子（共 2673 人注册；其余 327 人只持币未注册）
- 入金：KOL/团长 1000U，大使 100U，叶子混杂 50 / 100 / 1000U
- 出块：每笔 `contribute` 后 `vm.roll(+1)`，每 30 块 ckey 少发 20 枚/100U
- 金库：`treasuryWithdrawable` 每达到 **5000U**，Admin 立刻 `withdrawTreasury` 抽走当时全部可提现额
- 停止条件：至少 3 个共建者，且出现一笔 3%/6%/9% 三段极差

### 开售（尚无入金）

| 项 | 值 |
|---|---:|
| block.number | 1 |
| currentWeek | 0 |
| tokensPer100 (枚/100U) | 10000 |
| 累计入金 (U) | 0 |
| 合约 USDT 余额 (U) | 0 |
| treasuryWithdrawable (U) | 0 |
| reservedRewards (U) | 0 |
| 共建者人数（根+8 KOL） | 0 |
| 已入金笔数 | 0 |
| Admin 累计抽走 (U) | 0 |

### 第一个共建者出现

| 项 | 值 |
|---|---:|
| block.number | 32 |
| currentWeek | 1 |
| tokensPer100 (枚/100U) | 9980 |
| 累计入金 (U) | 31000 |
| 合约 USDT 余额 (U) | 5310 |
| treasuryWithdrawable (U) | 810 |
| reservedRewards (U) | 4500 |
| 共建者人数（根+8 KOL） | 1 |
| 已入金笔数 | 31 |
| Admin 累计抽走 (U) | 25690 |

### 身份波结束（根/KOL/团长 1000U，大使 100U）

| 项 | 值 |
|---|---:|
| block.number | 274 |
| currentWeek | 9 |
| tokensPer100 (枚/100U) | 9820 |
| 累计入金 (U) | 57000 |
| 合约 USDT 余额 (U) | 11222 |
| treasuryWithdrawable (U) | 1782 |
| reservedRewards (U) | 9440 |
| 共建者人数（根+8 KOL） | 1 |
| 已入金笔数 | 273 |
| Admin 累计抽走 (U) | 45778 |

### 第一笔三段极差（3% / 6% / 9%）

| 项 | 值 |
|---|---:|
| block.number | 337 |
| currentWeek | 11 |
| tokensPer100 (枚/100U) | 9780 |
| 累计入金 (U) | 81200 |
| 合约 USDT 余额 (U) | 18403 |
| treasuryWithdrawable (U) | 4555 |
| reservedRewards (U) | 13848 |
| 共建者人数（根+8 KOL） | 2 |
| 已入金笔数 | 336 |
| Admin 累计抽走 (U) | 62797 |

### 第一阶段暂停（共建者 >= 3 且已出现三段极差）

| 项 | 值 |
|---|---:|
| block.number | 637 |
| currentWeek | 21 |
| tokensPer100 (枚/100U) | 9580 |
| 累计入金 (U) | 187150 |
| 合约 USDT 余额 (U) | 34639 |
| treasuryWithdrawable (U) | 1620 |
| reservedRewards (U) | 33019 |
| 共建者人数（根+8 KOL） | 3 |
| 已入金笔数 | 636 |
| Admin 累计抽走 (U) | 152511 |

## 共建者名单（根 + 8 个 KOL）

| 角色 | 地址 | 本人 (U) | 伞下 (U) | 身份 | 团队档 bps |
|---|---|---:|---:|---|---:|
| Root | `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf` | 1000 | 186150 | CoBuilder | 900 |
| KOL0 | `0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF` | 1000 | 111800 | CoBuilder | 900 |
| KOL1 | `0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69` | 1000 | 30350 | CoBuilder | 900 |
| KOL2 | `0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718` | 1000 | 6000 | Partner | 300 |
| KOL3 | `0xe1AB8145F7E55DC933d51a18c793F901A3A0b276` | 1000 | 6000 | Partner | 300 |
| KOL4 | `0xE57bFE9F44b819898F47BF37E5AF72a0783e1141` | 1000 | 6000 | Partner | 300 |
| KOL5 | `0xd41c057fd1c78805AAC12B0A94a405c0461A6FBb` | 1000 | 6000 | Partner | 300 |
| KOL6 | `0xF1F6619B38A98d6De0800F1DefC0a6399eB6d30C` | 1000 | 6000 | Partner | 300 |
| KOL7 | `0xF7Edc8FA1eCc32967F827C9043FcAe6ba73afA5c` | 1000 | 6000 | Partner | 300 |

## 50U 入金（应无推广奖）

付款人 `0x14a3788E9f6fF7867096f4AB23bc09bCF27E9e21` 投入 **50U**。

- 直推增量：**0U**（应为 0）
- 整条链团队奖增量：**0U**（应为 0）
- 直推人伞下业绩：3100U → 3150U（业绩仍计入）

结论：与合约一致——`< 100U` 只加业绩、不发直推/团队奖。

## 三段极差对照（抽一笔 ≥100U）

付款人 `0x29A3b098572e6C7A53065Cc0E18eF6d9f474f4fE` 投入 **1000U**（block 337，week 11）。

链：叶子 → 大使 `0xd817D23c981472d703bE36da777FFDb1ABEFd972`（300 bps）→ 团长 `0x4CCeBa2d7D2B4fdcE4304d3e09a1fea9fbEb1528`（600 bps）→ KOL `0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF`（900 bps）。

| 科目 | 公式 | 期望 (U) | 实际 (U) |
|---|---|---:|---:|
| 直推（大使） | amount × 10% | 100 | 100 |
| 大使团队 | amount × 3% | 30 | 30 |
| 团长级差 | amount × (6%-3%) | 30 | 30 |
| KOL 级差 | amount × (9%-6%) | 30 | 30 |
| 团队合计 | <= 9% | 90 | 90 |
| 直推+团队 | <= 19% | 190 | 190 |

结论：实际记账与 `_settleDirect` / `_settleTeam` 公式一致。直推与团队叠在大使身上（10%+3%），团长和 KOL 只拿级差，整条链不超过 19%。

## 暂停原因

已满足第一阶段目标：共建者人数 = 3，且已出现三段极差分配。后续推广波次未再跑。
