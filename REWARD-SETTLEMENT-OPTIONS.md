# 多级奖金结算方案对比

日期：2026-09-20  
背景：阶段 1–5 已实现「链上实时经典极差 + 6 万平级抽成」。现评估是否改为链下计算 + 链上默克树记录。  
状态：**仅评估，未改动合约代码。** 架构现状见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 1. 先看实测：深度到底花多少 gas

在当时的代码（挂载链上团队模块，默认五档）上构造纯线性邀请链，测叶子一笔 1000 USDT 入金的 gas：

| 链深 | 首次入金（祖先 `teamVolume` 由 0 变非 0） | 同链第二笔（槽位已非 0） |
|------|------------------------------------------|--------------------------|
| 1 | 453,191 | — |
| 10 | 678,012 | — |
| 50 | 1,677,233 | — |
| 100 | 2,926,294 | 663,673 |

边际成本：首次约 **25,000 gas/层**（外部调用 + `SSTORE` 0→非 0 的 20k），稳定态约 **4,000 gas/层**。

结论有两点，都要说清楚：

1. **现在的 128 硬顶不是为了躲 OOG。** BSC 区块 gas 上限在 1 亿以上，2.9M 离爆还很远。硬顶真正的作用是**不让管理员把这道闸调没**，以及封住「有人叠出几千层链、让下游入金变得极贵甚至不可用」的路子。按 25k/层外推，几千层才会真的顶到区块上限。
2. **成本增长是线性且真实的。** 100 层首次入金 2.9M gas，是 depth 1 的 6.5 倍。用户付的手续费差 6 倍，这本身就是产品问题，与是否 OOG 无关。

另外要留意：`contribute` 的历史最大值 3.41M 出现在 6 万 USDT 那笔，主要是 NFT 按枚循环铸 120 枚（审计 L-1），**不是**树遍历。改链下结算不会解决这一条。

---

## 2. 三个方案

### A 方案：保持现状（链上实时全额结算）

入金一笔里同时做完：直推、五档极差、6 万抽成、伞下业绩上传到树顶。

### B 方案：折中（直推留链上，多级走链下 root）

- 链上即时发直推 10%（只一跳，O(1)）
- 多级极差 + 6 万抽成由链下计算器算，周期性发布默克树 root
- 链上不再维护 `teamVolume`，`_bumpAncestorTeam` 与模块回调全部删除

### C 方案：全链下（合约只做金库 + 记录 + claim）

直推也进 root。`contribute` 退化成：收 USDT、加 `selfVolume`、铸 CKEY/NFT、发事件。

---

## 3. Gas 与复杂度

| 维度 | A 现状 | B 折中 | C 全链下 |
|------|--------|--------|----------|
| `contribute` 复杂度 | O(链深) | **O(1)** | **O(1)** |
| 100 层首次入金 | 2.93M | 约 0.41M | 约 0.39M |
| 是否受深度影响 | 是 | 否 | 否 |
| 邀请深度上限 | 必须有（现 100/硬顶 128） | 可取消 | 可取消 |
| `claim` | 读三个字段，实测 92k | root 证明，约 95–110k |同 B |
| 新增链上写 | — | 每期一次 `publishRoot` | 同 B |
| 链下必需组件 | 无 | 索引器 + 计算器 + root 存档 | 同 B |

B / C 那一列是从实测倒推的：depth 1 的 453k 里约 46k 来自模块调用与一层业绩写入（`onContribute` 22k + `addTeamVolume` 24k），去掉即约 0.41M；余下成本是 USDT 转账、CKEY 铸造与 NFT 铸造，与树无关。

B 与 C 在 gas 上几乎没差别——直推只有一跳，留在链上几乎不花钱。**B 的 gas 收益等于 C，但保住了「入金立刻见到 10%」的体感。**

---

## 4. 合约会删掉什么（B 与 C 相同）

| 现有 | 改后 |
|------|------|
| `_bumpAncestorTeam`（金库唯一无界循环） | 删 |
| 链上团队模块及其宿主回调 | 删，或只留作链下计算器的规格参考 |
| `accrueTeam` / `addTeamVolume` / `_settling` / `_settleAmount` / `_settleDirectPaid` / `_settleTeamPaid` / `NotTeamModule` | 删 |
| `maxReferralDepth` / `MAX_REFERRAL_DEPTH_CAP` / `DepthExceeded` / `Account.depth` | 不再需要 |
| `teamTierVolume` / `teamTierBps` / `setTeamTiers` / `teamBpsForVolume` / `teamBpsOf` | 删 |
| `directRewards` + `teamRewards` + `claimed` 三份账 | 合成一个 `claimedOf[account]` |
| `teamVolume` | 链上不再维护（影响见第 6 节） |

新增：`merkleRoot`、`publishRoot(root, total)`、`claim(cumulative, proof)`、`claimedOf`。

审计里的 **M-1（直推与模块叠加 DoS）**、**M-4（换模块停售/停更业绩）**、**M-5（超帽硬 revert）** 会随之消失，因为这三条都源于「入金路径里要调外部模块并当场记账」。

---

## 5. 信任模型（这是真正的取舍）

**默克树只能证明「我在这份名单里」，不能证明「金额算对了」。** 光换成 root，等于把「谁拿多少」变成 owner 的一个按钮。要让不信任的用户真的能验，必须同时满足：

1. **输入全部在链上。** 邀请关系与入金金额继续上链（`Registered` / `ReferrerBound` / `Contributed` 事件即可，绑定仍保留 `hasChildren` 做 O(1) 防环）。任何人能用开源脚本重跑五档极差 + 6 万抽成，比对你发布的 root。
2. **计算器确定性且开源。** 同一批事件必须产出同一个 root，需要固定排序、固定整除口径、版本化。
3. **挑战期。** root 发布后延迟 N 小时才可领，中间可以复算喊错。没有这一步，前两条都只是摆设。
4. **累计式金额。** 叶子存 `(address, cumulativeAmount)`，`claim` 发 `cumulative - claimedOf[user]`；并要求 `cumulative` 单调不减，防止重发 root 把已确认额度改小。
5. **按 root 预存并锁定。** 发布时校验 `rootTotal ≤ 已入金未支付余额`，把这部分锁住，`withdrawTreasury` 不能碰。取代现在的 `reservedRewards`。
6. **全局上限仍留链上。** 累计已发布奖励 ≤ `totalContributed × 25%`。这条又便宜又能兜住链下算错或作恶（现有 `REWARD_CAP_BPS` 是写死常量，可以沿用同一口径）。

| 风险方向 | A 现状 | B / C |
|----------|--------|-------|
| 奖金规则被改 | 合约写死，改要换模块（可审计、有事件） | owner 发 root 即生效，靠复现 + 挑战期约束 |
| 入金被误配阻断 | 存在（M-1 / M-4 / M-5） | 基本消除 |
| 超发 | 逐笔 25% 硬帽 | 全局 25% 帽 + 按 root 预存 |
| 用户可自证 | 可直接读链上状态 | 需跑链下计算器 |
| 单点故障 | 无（合约自洽） | 索引器/发布流程停了就停发 |

净效果：**技术风险降低，治理风险上升。** 必须用多签 + timelock + 挑战期补上。

---

## 6. 会失去的产品能力

- **实时性**：C 连直推都要等下一期 root；B 保住直推即时，多级按日结或周结。
- **`teamVolume` 不再上链**：依赖它的「共建者（本人 ≥1000 且伞下 ≥3 万）」身份判定要挪到链下，或由 root 发布者一并写入。`roleOf` 目前就依赖这个字段。
- **链上可组合性**：其他合约无法直接读某人的档位/伞下业绩。
- **运维负担**：索引器、确定性计算器、root 存档（建议 IPFS）、以及针对历史数据的回归测试，全部变成上线必需项，不是可选项。

---

## 7. 不改合约也能缓解的事

如果暂时不想动架构，以下两条能直接压低深度带来的成本：

1. **极差发完就停止上传业绩**——但这会改变 ABCD 口径（C 入金后 A 不再变 9%），属产品决策。
2. **跳表优化**：给每个地址缓存「最近的更高档祖先」，发奖变成最多 5 跳 O(1)，**但业绩仍需沿父指针写**，所以 `contribute` 仍是 O(深度)，只省掉重复的 `qualOf` 读取。收益有限。

换句话说，在坚持「资格 = 本人 + 整条伞下、当笔立刻变档」的前提下，**写入的 O(深度) 无法消除**。要真正做到与深度无关，只能把结算移出这条路径——也就是 B 或 C。

---

## 8. 业界现成方案（2026-09 调研）

这个问题不需要自创算法。「链下算、链上按累计额提现」已经是成熟范式，多个主流协议在生产环境跑同一套结构。

### 8.1 累计式默克尔分发（Cumulative Merkle Drop）

叶子存 `keccak256(account, cumulativeAmount)`，链上只存一个 root 加 `claimed[account]`，领取时付 `cumulative - claimed`。重复点不会双付，新一期只增加差额。这正是第 5 节第 4 条写的做法，业界已有多份实现：

| 实现 | 值得抄的点 |
|------|-----------|
| [1inch CumulativeMerkleDrop](https://github.com/1inch/merkle-distribution/blob/master/contracts/CumulativeMerkleDrop.sol) | 汇编版 `_verifyAsm` 省 gas；[MixBytes 审计](https://github.com/mixbytes/audits_public/blob/master/1inch/Cumulative%20Merkle%20Drop/README.md)建议把余额与 `preclaimed` 检查放在验证之前，并只用 256 位版本避免碰撞 |
| [Morpho UniversalRewardsDistributor](https://github.com/morpho-org/universal-rewards-distributor/blob/main/src/UniversalRewardsDistributor.sol) | `submitRoot` 带 **timelock**，且 root 与 **IPFS hash 一起上链**；`updaterRole` 与 owner 分权。透明度做法可直接照搬 |
| [Pendle MultiTokenMerkleDistributor](https://docs.pendle.finance/cn/pendle-v2-dev/Contracts/LiquidityMining/MerkleDistributor) | `verify` 与 `claimVerified` 拆开，便于代付 gas 的无感领取 |
| Symbiotic `CumulativeMerkleRewards` | 按期对账：本期发放额 = 本期累计 − 上期累计，并要求时间戳递增 |

对我们的价值：`claim(cumulative, proof)` 不必自己设计，连审计意见都是公开的。

### 8.2 EIP-712 签名凭证（可做到实时提现）

后台对 `(领取人, 累计额, nonce, deadline)` 做 EIP-712 签名，用户带签名直接提现。不需要等 root，**这就是「实时」的来源**，而且比默克尔证明还便宜（省掉 proof 哈希，只做一次 `ecrecover`）。

必须做对的几件事（审计常见失分点）：

- domain separator 绑 `chainId` + `address(this)` + version，防跨链跨合约重放
- 结构里带 **nonce** 与 **deadline**，并强制校验
- `ecrecover` 后检查 `signer != address(0)`
- 用 `abi.encode` 而不是 `abi.encodePacked`
- 走 OpenZeppelin `EIP712` + `SignatureChecker`（顺带支持 EIP-1271 合约钱包）
- 签名私钥用 KMS/HSM，可轮换

**单靠签名的问题：签名私钥就是金库钥匙。** 泄露即可签出任意金额。所以必须配 8.4 的额度闸。

### 8.3 零知识证明计算过程（可信度最高）

若要连「金额算得对不对」都由链上验证，现在已有可落地的路径：把结算规则写成 Rust，在 [SP1](https://github.com/succinctlabs/sp1) 或 [RISC Zero](https://github.com/risc0/risc0-ethereum) 这类 zkVM 里跑，链上只验一个 Groth16 证明。

- 验证成本约 **30 万 gas，且与计算复杂度无关**——树多深、人多少都一样
- RISC Zero 的 Steel 库能让 guest 程序**读取经证明的链上状态**（按区块的 `eth_getProof`），也就是说可以证明「我确实是基于链上真实入金和邀请关系算的」
- 代价：要维护 Rust 版规则、证明生成需要算力（可用证明市场外包）、工程量最大

这是唯一能把「owner 说了算」彻底变成「数学说了算」的方案。当前阶段不建议上，但值得作为长期目标，因为它和 8.1 的接口兼容——照样是发 root，只是多附一个证明。

### 8.4 带押金的挑战（替代「靠人盯」）

第 5 节第 3 条说的挑战期，业界成品是 [UMA Optimistic Oracle V3](https://github.com/UMAprotocol/protocol/blob/master/packages/core/contracts/optimistic-oracle-v3/implementation/OptimisticOracleV3.sol)：发布方押金 + 存活期（默认 2 小时，可自定义），期内任何人可押同额押金发起争议，胜方拿回押金并分走败方一半。Polymarket 用的就是这套：2 小时挑战窗口，有争议才升级到代币投票。

关键启发：**挑战必须带押金**，否则任何人都能乱喊卡住全场领取；押金大小应随单期金额上调。

---

## 9. 推荐落地形态：root 定权 + 签名垫付

把你设想的「后台算好、页面显示、点提现就打款、每天发 root 做密码学挑战」补上一个关键约束就成立了。

**需要注意的是：如果打款金额由后台签名决定，而 root 只是事后审计，那 root 挡不住错误打款，只能事后发现。** 钱已经出去了。修正办法是让两者分工：

| 角色 | 用途 | 上限 |
|------|------|------|
| **每日 root** | 权威累计额。已结算部分按 `claim(cumulative, proof)` 领 | 受全局 25% 帽 + 按期预存锁定约束 |
| **签名凭证** | 只垫付「上一期 root 之后新产生」的那部分，实现实时提现 | 链上写死每人单期垫付上限、全局每日垫付上限、冷却时间 |

下一期 root 发布时，累计额天然包含已垫付的部分，`claimed[account]` 已经记账，不会重复发。签名私钥万一泄露，损失被垫付额度闸住，不是整个金库。

这样三件事同时成立：

- **实时**：网体收益入金后即可提，走签名路径
- **低 gas**：`contribute` 是 O(1)，与邀请深度无关；领取约 6–11 万 gas
- **可信**：每天 root + IPFS 叶子公开，任何人用开源计算器复算；配押金挑战窗口；未来可加 zk 证明升级到数学保证

要写进合约的硬闸（不依赖任何链下诚实）：

1. 累计已发放 ≤ `totalContributed × 25%`（沿用现有 `REWARD_CAP_BPS` 口径）
2. `cumulative` 单调不减，且 `claimed` 只增
3. 每日垫付总额上限 + 单账户上限
4. root 更新走 timelock，与 IPFS hash 一起上链（照 Morpho）
5. 多签持有 `cancelRoot` / 暂停垫付通道的权限

---

## 10. 建议

近期倾向 **B 方案 + 第 9 节形态**：gas 收益与全链下相同，保住直推即时反馈，删掉金库里唯一的无界循环，同时消掉三条 Medium 风险；网体收益靠签名垫付拿回实时性。

落地顺序：

1. 先把当时链上团队模块的逻辑 1:1 移植成链下计算器，用 `test/CoralIdo.team.t.sol` 里的 ABCD、6 万 overlay 数字做交叉验证（确保链下结果与链上现状完全一致）
2. 照 1inch / Morpho 写 `publishRoot(root, ipfsHash, total)` + `claim(cumulative, proof)`，加全局 25% 帽与 timelock
3. 再加 EIP-712 垫付通道与额度闸
4. 最后才删除模块回调与深度上限
5. 长期可选：把第 1 步的计算器移进 zkVM，root 附证明

这样任何一步出错都能回退到现在已经全绿的实现。
