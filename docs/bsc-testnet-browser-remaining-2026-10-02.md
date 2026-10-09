# BSC 测试网剩余检查清单（2026-10-02）

本轮浏览器控制超时，所有未完成项继续保留。以下从两份原文件逐项提取，保留来源章节与行号；两份文件有重叠，不应算成两个独立用例。结果见 `bsc-testnet-browser-results-2026-10-02.md`。

## 执行前条件

- [ ] 恢复 freedaotest 的浏览器点击、页面读取及钱包弹窗观察。
- [ ] 本机完成钱包导入/解锁，确认实际签名账户；不要在报告里记录密钥。
- [ ] 钱包当前网络为97，前端与六个测试网合约一致。
- [ ] 核对当前周数和历史领取；第187周的旧金额预期不能直接套用。
- [ ] 对网体奖准备或确认测试Postgres位置及配置；不擅自选择数据库。
- [ ] root发布前重算全量累计额、核对资金覆盖和发布上限。
- [ ] 另部署用例先明确新合约地址，禁止在现有部署执行破坏性项目。

## 如何接手

周息领取/入金需要可用钱包；跨周项目需要时间及交易前后快照；网体奖需要索引数据库、proof和发布流程；导入、结束、帽和权限迁移需要独立部署。每项通过须写实际回执与前后状态，失败写revert及交易哈希；不得仅凭页面跳转打勾。

## 来源：bsc-testnet-manual.md

- [ ] `currentWeek` 变成 187 后，索引 20 的 `pending = 1000` 枚 CKEY（2 张 × 500 × 100 × 1%）。若是 2,000 枚，说明第 186 周的档位没有改回原四档  
  来源：bsc-testnet-manual.md:29 · 1. 等第 187 周。本轮状态：未完成。

- [ ] 同一时刻，索引 19 的 `pending` 仍是 0  
  来源：bsc-testnet-manual.md:30 · 1. 等第 187 周。本轮状态：未完成。

- [ ] 索引 20 调用周息合约 `claim()`。CKEY 增加 1,000，USDT 不变，`pending` 回到 0  
  来源：bsc-testnet-manual.md:31 · 1. 等第 187 周。本轮状态：未完成。

- [ ] 索引 20 马上再 `claim` 失败（`NothingToClaim`）  
  来源：bsc-testnet-manual.md:32 · 1. 等第 187 周。本轮状态：未完成。

- [ ] 另留一个 2 张 NFT 的地址，第 187 周和第 188 周都不领。第 189 周一次 `claim` 拿到两周的和（2,000 枚）。不要用索引 20，它在上一项已经领过第 186 周  
  来源：bsc-testnet-manual.md:33 · 1. 等第 187 周。本轮状态：未完成。

- [ ] 在下一周内给这个地址再入金 4,000 USDT，NFT 变成 10 张  
  来源：bsc-testnet-manual.md:39 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 这笔入金里，周息先按旧的 2 张把已经结束的周结清，再铸新 NFT。结清金额是已结束周数 × 1,000 枚，不是按 10 张重算旧周  
  来源：bsc-testnet-manual.md:40 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 再过一周，新增加的 `pending` 是 **10,000** 枚（10 张 × 2%），旧周没有被改成 2%  
  来源：bsc-testnet-manual.md:41 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 9 张（入金 4,500）按 1%：一周 4,500 枚  
  来源：bsc-testnet-manual.md:45 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 10 张（入金 5,000）按 2%：一周 10,000 枚  
  来源：bsc-testnet-manual.md:46 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 19 张（入金 9,500）按 2%：一周 19,000 枚  
  来源：bsc-testnet-manual.md:47 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 20 张（入金 10,000）按 2.5%：一周 25,000 枚  
  来源：bsc-testnet-manual.md:48 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 59 张（入金 29,500）按 2.5%：一周 73,750 枚  
  来源：bsc-testnet-manual.md:49 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 60 张（入金 30,000）按 3%：一周 90,000 枚  
  来源：bsc-testnet-manual.md:50 · 2. 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] `closeSale` 之后再过一小时，已持有 NFT 的 `pending` 仍增加。索引 19 仍应是 0；持有 2 张及以上的地址按原四档增加  
  来源：bsc-testnet-manual.md:56 · 3. 关售不停周息。本轮状态：未完成。

- [ ] `openSale` 之后可以再入金。`saleOpenedAt` 仍是 `1790237062`，`idoEnded` 仍是 false  
  来源：bsc-testnet-manual.md:57 · 3. 关售不停周息。本轮状态：未完成。

- [ ] 单户上限改低后，领取会被帽截断，少掉的部分以后调高也不补。换一套新部署再测，这套不要调用 `setAccountCapBps`  
  来源：bsc-testnet-manual.md:61 · 4. 不要在这套上做的周息帽。本轮状态：未完成。

- [ ] 全站 `interestCap` 压到当前已结算额后，再过一周新利息为 0，调高后也不补。这套不要压帽，放到下面的新部署  
  来源：bsc-testnet-manual.md:62 · 4. 不要在这套上做的周息帽。本轮状态：未完成。

- [ ] 发第一期之前，`setMaxRootIncrease` 设成这一期增量盖得住的值。设成 0 等于不限制；测试网可以暂时这样，上主网前必须设上限  
  来源：bsc-testnet-manual.md:72 · 5.1 发布上限。本轮状态：未完成。

- [ ] 设一个故意很小的上限，发布更大的 `cumulative` 失败（`IncreaseTooLarge`）。然后把上限改回够用的值  
  来源：bsc-testnet-manual.md:73 · 5.1 发布上限。本轮状态：未完成。

- [ ] `npm run index:rewards` 连的是测试网，而不是本机 8545  
  来源：bsc-testnet-manual.md:85 · 5.2 小树。本轮状态：未完成。

- [ ] 索引追上最新区块后，库里 S、T、U 的上级和本人业绩与链上一致  
  来源：bsc-testnet-manual.md:86 · 5.2 小树。本轮状态：未完成。

- [ ] S 的网体增量是 32.97 USDT，与库内 wei 完全一致  
  来源：bsc-testnet-manual.md:87 · 5.2 小树。本轮状态：未完成。

- [ ] 另做一遍「S 业绩为 0」：S 还没入金时 T 入金 1,000，只产生直推 100，网体为 0  
  来源：bsc-testnet-manual.md:88 · 5.2 小树。本轮状态：未完成。

- [ ] root 发布前，页面或库里能看到预计金额，但用户 `claim` 失败  
  来源：bsc-testnet-manual.md:89 · 5.2 小树。本轮状态：未完成。

- [ ] 不带 `--apply` 的 `publish:root` 只打印，链上 `merkleRoot` 仍是 0  
  来源：bsc-testnet-manual.md:93 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 只设 `PRIVATE_KEY`、不设 `PUBLISHER_PRIVATE_KEY`，脚本拒绝发布  
  来源：bsc-testnet-manual.md:94 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 用不是 `publisher()` 的私钥发布，脚本拒绝。当前 publisher 是 `0x8149a60BC2863DC23B32A75EE89409E20808906a`  
  来源：bsc-testnet-manual.md:95 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 发布前金库 USDT 余额 ≥ 未领直推 + 这一期要新付的网体增量  
  来源：bsc-testnet-manual.md:96 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] `publish-root.mjs --apply` 成功。`merkleRoot` 非 0，`committed` 等于申报的累计合计。Owner 地址就是 publisher，这一笔同时证明 Owner 可以 `publishRoot`  
  来源：bsc-testnet-manual.md:97 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 公开明细 JSON 用 `verify-root` 核对通过  
  来源：bsc-testnet-manual.md:98 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 把明细里某个金额加 1 wei 再核对，失败  
  来源：bsc-testnet-manual.md:99 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] S 用库里的累计额和 proof 调用 `CoralRewards.claim`，到账差额。若之前没领过，这一笔增量是 32.97 USDT；到账以 proof 里的累计额减已领为准  
  来源：bsc-testnet-manual.md:100 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 同一 proof 再领失败（`NothingToClaim`）  
  来源：bsc-testnet-manual.md:101 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 错误 proof、别人的累计额、累计额小于已领，都失败  
  来源：bsc-testnet-manual.md:102 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 漏一期不补发历史 root：下一期用更高的累计额，一次领到差额  
  来源：bsc-testnet-manual.md:103 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 再发布一次完全相同的 root，数据库里生效期仍然只有 1 期  
  来源：bsc-testnet-manual.md:104 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 索引器读到 `TeamClaimed` 后，库里的已领金额等于链上 `claimed(S)`  
  来源：bsc-testnet-manual.md:105 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 根发布后立刻能领，没有挑战窗，也没有 `activateRoot`  
  来源：bsc-testnet-manual.md:106 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] 金库暂停时，网体奖 `claim` 失败。测完 `unpause`  
  来源：bsc-testnet-manual.md:107 · 5.3 发布、核对、领取。本轮状态：未完成。

- [ ] `setPublisher` 换成地址 P 后，旧 publisher 不能再发，P 可以发一笔你确认要发的 root  
  来源：bsc-testnet-manual.md:111 · 5.4 换 publisher。本轮状态：未完成。

- [ ] 测完 `setPublisher` 改回 `0x8149a60BC2863DC23B32A75EE89409E20808906a`  
  来源：bsc-testnet-manual.md:112 · 5.4 换 publisher。本轮状态：未完成。

- [ ] 资格跨档：本人先入金 500，下级再入金时上级拿 3%；本人累计到 2,000 / 10,000 / 30,000 / 60,000 之后，下一笔分别拿 5% / 7% / 9% / 10%。跨档从下一笔生效，不追溯刚才那一笔  
  来源：bsc-testnet-manual.md:118 · 5.5 大树。本轮状态：未完成。

- [ ] 极差：下级档位低于上级时，上级只拿差额。入金者自己的档位不把上级压低  
  来源：bsc-testnet-manual.md:119 · 5.5 大树。本轮状态：未完成。

- [ ] 平级：D 和 D 的上级都已是 10%。D 拿到极差之后，再上一个 10% 只再拿 D 这笔网体奖的 10%，更上面的 10% 不再抽  
  来源：bsc-testnet-manual.md:120 · 5.5 大树。本轮状态：未完成。

- [ ] 深链（例如 6 级）入金的 gas 和浅链同一笔金额接近  
  来源：bsc-testnet-manual.md:121 · 5.5 大树。本轮状态：未完成。

- [ ] 25% 帽不要在这套上把直推改成 2500。放到新部署，见第 7 节  
  来源：bsc-testnet-manual.md:122 · 5.5 大树。本轮状态：未完成。

- [ ] 等满 1 小时再 `acceptRewards`。这套不要接受。用户之后要向新合约领网体奖，接受前必须确认新合约的 `vault` 指向同一金库  
  来源：bsc-testnet-manual.md:126 · 6. 这套不要做的权限和资金操作。本轮状态：未完成。

- [ ] 五个合约各自 `transferOwnership`，新 Owner `acceptOwnership` 之后旧 Owner 不能再改参数。这套不转。要测就换一套新部署，测完转回  
  来源：bsc-testnet-manual.md:127 · 6. 这套不要做的权限和资金操作。本轮状态：未完成。

- [ ] `withdrawTreasury` 提取恰好等于当时的 `treasuryWithdrawable`。这套已经用 1 USDT 证明能转出（`0x935c8471a836a2853be5baf9a7e17d540f436bfe211b3beda360d4099c564812`），并且多提 1 wei 会 `InsufficientTreasury`。一次提光会让后面的网体奖没有 USDT 可付  
  来源：bsc-testnet-manual.md:128 · 6. 这套不要做的权限和资金操作。本轮状态：未完成。

- [ ] 未冻结时不能 `openSale`  
  来源：bsc-testnet-manual.md:136 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] `importUsers` 写入地址和邀请码，不铸 CKEY，不铸 NFT，不发直推  
  来源：bsc-testnet-manual.md:137 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 数组长度不一致失败  
  来源：bsc-testnet-manual.md:138 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 重复导入同一地址失败  
  来源：bsc-testnet-manual.md:139 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 导入自己当自己的上级失败  
  来源：bsc-testnet-manual.md:140 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 导入成环失败  
  来源：bsc-testnet-manual.md:141 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] `importVolumes` 只写本人业绩，`importedNfts = 业绩 / 500`，并占用全站 1 万张额度  
  来源：bsc-testnet-manual.md:142 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 导入的业绩不进上级伞下，不产生网体奖，也不增加 `totalContributed`  
  来源：bsc-testnet-manual.md:143 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 导入之后的新入金才产生直推和网体奖  
  来源：bsc-testnet-manual.md:144 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] `grantNft` 给未注册地址失败；张数为 0 失败；累计超过 `importedNfts` 失败  
  来源：bsc-testnet-manual.md:145 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] `grantNft` 成功后 NFT 到账，本人业绩不变。到账当周起才计周息，补发前的周为 0  
  来源：bsc-testnet-manual.md:146 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] `freezeImport` 后导入失败，然后才能 `openSale`  
  来源：bsc-testnet-manual.md:147 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 第一次 `openSale` 写入 `saleOpenedAt`，并让周息合约 `saleOpened = true`  
  来源：bsc-testnet-manual.md:148 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 开售前 `pending` 为 0  
  来源：bsc-testnet-manual.md:149 · 7.1 导入、冻结、开售。本轮状态：未完成。

- [ ] 先 `closeSale`，新入金停止  
  来源：bsc-testnet-manual.md:153 · 7.2 结束 IDO。本轮状态：未完成。

- [ ] 再 `endIdo`。`idoEnded = true`。周息算到调用时所在的那一周为止（含这一周），再过几小时也不再增加  
  来源：bsc-testnet-manual.md:154 · 7.2 结束 IDO。本轮状态：未完成。

- [ ] `endIdo` 不会把 `saleOpen` 设成 false。若没先关售，结束后仍能入金  
  来源：bsc-testnet-manual.md:155 · 7.2 结束 IDO。本轮状态：未完成。

- [ ] 第二次 `endIdo` 失败  
  来源：bsc-testnet-manual.md:156 · 7.2 结束 IDO。本轮状态：未完成。

- [ ] 结束后直推和已经发布的网体奖仍可领  
  来源：bsc-testnet-manual.md:157 · 7.2 结束 IDO。本轮状态：未完成。

- [ ] 结束后新的一周不再产生周息  
  来源：bsc-testnet-manual.md:158 · 7.2 结束 IDO。本轮状态：未完成。

- [ ] 直推比例 2500 时，继续入金直到直推累计接近全站 25%。此时再发布一笔会超帽的网体 root，失败；超帽的 `claim` 失败  
  来源：bsc-testnet-manual.md:162 · 7.3 上限和帽。本轮状态：未完成。

- [ ] 把周息全站帽调到当前已结算额，再过一周，新利息为 0，少掉的部分不会在调高帽之后补发。帽不能调到 5000 万枚以上  
  来源：bsc-testnet-manual.md:163 · 7.3 上限和帽。本轮状态：未完成。

- [ ] 单户帽按「当前张数 × 500 × 最新比例 × accountCapBps」。把 `accountCapBps` 改低后领取被截断，改回 10000 也不补发少掉的部分  
  来源：bsc-testnet-manual.md:164 · 7.3 上限和帽。本轮状态：未完成。

- [ ] NFT 铸到 10,000 张后继续入金：交易不回滚，只铸满剩余额度，多出来的记 `nftDeferred`，并且这几张不计周息  
  来源：bsc-testnet-manual.md:165 · 7.3 上限和帽。本轮状态：未完成。

- [ ] `export-deferred-nfts.mjs` 导出的地址和张数与链上 `nftDeferred` 一致  
  来源：bsc-testnet-manual.md:166 · 7.3 上限和帽。本轮状态：未完成。

- [ ] CKEY 总供应顶到 10 亿时继续入金会铸币失败。测试网跳过。跳过，本地 Forge 已测  
  来源：bsc-testnet-manual.md:167 · 7.3 上限和帽。本轮状态：未完成。

- [ ] 导入用户不自动得到 CKEY  
  来源：bsc-testnet-manual.md:171 · 7.4 早期用户本金。本轮状态：未完成。

- [ ] Owner 按「导入业绩 × 100」手动铸造后，余额正确，且可以和后来入金铸出的币加在一起  
  来源：bsc-testnet-manual.md:172 · 7.4 早期用户本金。本轮状态：未完成。

- [ ] 手动铸造的币同样默认不能转，除非白名单  
  来源：bsc-testnet-manual.md:173 · 7.4 早期用户本金。本轮状态：未完成。

## 来源：bsc-testnet-checklist.md

- [ ] Owner `withdrawTreasury` 提取恰好等于 `treasuryWithdrawable` 成功。这一套只提了 1 USDT 证明能转出，`0x935c8471a836a2853be5baf9a7e17d540f436bfe211b3beda360d4099c564812`，没有把可提取余额提光。一次提光见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:236 · 4. 直推领取和金库资金。本轮状态：未完成。

- [ ] 只有 1 张 NFT 的地址，过了一周后 `pending` 仍是 0。索引 19 已在第 186 周补到正好 1 张，当周 `pending = 0` 已核对；过周后见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:275 · 5.1 等一小时就能看的。本轮状态：未完成。

- [ ] `currentWeek` 变成 W+1 后，索引 20 的 `pending = 1000` 枚 CKEY（2 张 × 500 × 100 × 1%）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:276 · 5.1 等一小时就能看的。本轮状态：未完成。

- [ ] 索引 20 调用周息合约 `claim()`，CKEY 增加 1000，USDT 不变，`pending` 回到 0。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:277 · 5.1 等一小时就能看的。本轮状态：未完成。

- [ ] 没有可领时再 `claim` 失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:278 · 5.1 等一小时就能看的。本轮状态：未完成。

- [ ] 漏领一周没关系：两周都不领，一次 `claim` 拿到两周的和。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:279 · 5.1 等一小时就能看的。本轮状态：未完成。

- [ ] 在 W+1 周内让持有 2 张的地址再入金 4,000 USDT，NFT 变成 10 张。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:285 · 5.2 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 这一笔入金交易里，周息先按旧的 2 张把已经结束的周结清，再铸新 NFT。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:286 · 5.2 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 等到 W+2，`pending` 新增的是 **10,000** 枚（10 张 × 2%），不是把第 W 周也改成 2%。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:287 · 5.2 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 两档之间：9 张仍按 1%，刚好 10 张才按 2%；19 张按 2%，20 张按 2.5%；59 张按 2.5%，60 张按 3%。各用一个地址入金到对应张数，过一周核对。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:288 · 5.2 后买的 NFT 不改已经结束的周。本轮状态：未完成。

- [ ] 关售后再过一小时，已持有的 NFT **仍在计息**。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。本轮测完立刻重新开售，没有干等一小时  
  来源：bsc-testnet-checklist.md:296 · 5.3 关售不停周息，结束 IDO 才停。本轮状态：未完成。

- [ ] 等这一周结束后，利息按改回后的原四档计算。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。索引 20 在第 187 周若是 1,000 枚而不是 2,000 枚，就说明改回的四档生效  
  来源：bsc-testnet-checklist.md:312 · 5.4 改档位（同一周内改回）。本轮状态：未完成。

- [ ] 把单户上限暂时改低后，该地址继续领取会被帽截断，超出的部分不计、也不留到以后。少掉的利息不会补发，不在这套已有用户的合约上做。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:315 · 5.4 改档位（同一周内改回）。本轮状态：未完成。

- [ ] 不要在这套已有用户的合约上把全站 `interestCap` 压到当前 `totalAccrued`，否则所有人停息。全站帽测完即停的用例放到第 10 节的新部署。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:316 · 5.4 改档位（同一周内改回）。本轮状态：未完成。

- [ ] 暂停期间网体奖 `claim` 也会失败（金库 `disburse` 受暂停限制）。这套还没有发布 root，见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:323 · 6. 暂停。本轮状态：未完成。

- [ ] 在发第一期 root 之前，Owner `setMaxRootIncrease` 设一个你这期增量盖得住的值（例如小树预期网体奖的 2 倍）。设成 0 表示不限制，测试网可以暂时这样，但上主网前必须设上限。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:350 · 7.1 先设发布上限。本轮状态：未完成。

- [ ] 设一个故意很小的上限，发布一个更大的 `cumulative` 失败（`IncreaseTooLarge`）。然后把上限改回够用的值。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:351 · 7.1 先设发布上限。本轮状态：未完成。

- [ ] `npm run index:rewards` 连的是测试网 RPC、chainId 97、上面的金库地址，而不是本机 8545。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:369 · 7.2 小树（建议必做）。本轮状态：未完成。

- [ ] 索引追上最新区块后，库里 S/T/U 的上级、本人业绩与链上一致。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:370 · 7.2 小树（建议必做）。本轮状态：未完成。

- [ ] S 的累计网体奖 = 32.97 USDT（允许与库内 wei 完全一致，不允许四舍五入）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:371 · 7.2 小树（建议必做）。本轮状态：未完成。

- [ ] T 入金时 S 自己还没入金的话，重做一遍「S 业绩为 0」：T 入金 1,000 只产生直推 100，网体为 0。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:372 · 7.2 小树（建议必做）。本轮状态：未完成。

- [ ] 页面或库里在 root 发布前就能看到预计金额，但此时用户 `claim` 失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:373 · 7.2 小树（建议必做）。本轮状态：未完成。

- [ ] 不带 `--apply` 的 `publish:root` 只打印，链上 `merkleRoot` 仍是 0。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:379 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 只设 `PRIVATE_KEY`、不设 `PUBLISHER_PRIVATE_KEY`，脚本拒绝发布。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:380 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 用不是 `publisher()` 的私钥发布，脚本拒绝。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:381 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 发布前看金库 USDT 余额 ≥ 未领直推 + 这一期要新付的网体增量。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:382 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] `publish-root.mjs --apply` 成功。交易回执成功，`merkleRoot` 非 0，`committed` 等于申报的累计合计。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:383 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 公开明细 JSON 用 `verify-root` 核对通过。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:384 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 把明细里某个金额加 1 wei 再核对，失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:385 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] S 用库里的累计额和 proof 调用 `CoralRewards.claim`，到账 **32.97 USDT**（若之前已领过则为差额）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:386 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 同一 proof 再领失败（`NothingToClaim`）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:387 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 错误 proof、别人的累计额、累计额小于已领，都失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:388 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 漏一期不补发历史 root：下一期用更高的累计额，一次领到差额。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:389 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 再发布一次完全相同的 root，数据库里生效期仍然只有 1 期。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:390 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 索引器读到 `TeamClaimed` 后，库里的已领金额等于链上 `claimed(S)`。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:391 · 7.3 发布、核对、领取。本轮状态：未完成。

- [ ] 资格跨档：本人先入金 500，下级再入金时上级拿 3%；本人累计到 2,000 / 10,000 / 30,000 / 60,000 之后，下一笔分别拿 5% / 7% / 9% / 10%。跨档从**下一笔**生效，不追溯刚才那一笔。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:399 · 7.4 大树（选做，气体和 USDT 都多）。本轮状态：未完成。

- [ ] 极差：下级档位低于上级时，上级只拿差额。入金者自己的档位不把上级压低。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:400 · 7.4 大树（选做，气体和 USDT 都多）。本轮状态：未完成。

- [ ] 平级：D 和 D 的上级都已是 10%。D 拿到极差之后，再上一个 10% 只再拿 D 这笔网体奖的 10%，更上面的 10% 不再抽。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:401 · 7.4 大树（选做，气体和 USDT 都多）。本轮状态：未完成。

- [ ] 深链（例如 6 级）入金的 gas 和浅链同一笔金额接近，不会因为层级变深而明显增加。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:402 · 7.4 大树（选做，气体和 USDT 都多）。本轮状态：未完成。

- [ ] 25% 帽：`totalDirectAccrued + 申报的网体累计` 超过 `totalContributed` 的 25% 时，`publishRoot` 失败。领取时若这一笔会把已付额顶过帽，`claim` 失败。不要为了做这个用例去改当前这套的直推比例；放到第 10 节的新部署上，把直推设为 2500 再堆入金。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:403 · 7.4 大树（选做，气体和 USDT 都多）。本轮状态：未完成。

- [ ] Owner 自己仍可以 `publishRoot`。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)，和第一次发布放在一起做  
  来源：bsc-testnet-checklist.md:409 · 8. 权限和换奖励合约。本轮状态：未完成。

- [ ] `setPublisher` 换成地址 P 后，旧地址不能再发，P 可以发。测完改回你要长期使用的 publisher。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:410 · 8. 权限和换奖励合约。本轮状态：未完成。

- [ ] 再提案一次，等满 1 小时后 `acceptRewards` 成功，`rewards()` 换成新地址。这套地址不要接受。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:416 · 8. 权限和换奖励合约。本轮状态：未完成。

- [ ] Owner `transferOwnership` 后，旧 Owner 不能再改参数；新 Owner 调用 `acceptOwnership` 之后才能用。五个合约（金库、奖励、周息、CKEY、NFT）各自转一次。这套地址不转。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:418 · 8. 权限和换奖励合约。本轮状态：未完成。

- [ ] 未冻结就 `openSale` 的路径，这套已经开过售，无法在这里复现。见 [bsc-testnet-manual.md](bsc-testnet-manual.md) 第 10 节  
  来源：bsc-testnet-checklist.md:426 · 9. 当前这套已经做不了的：导入。本轮状态：未完成。

- [ ] 未冻结时不能 `openSale`  
  来源：bsc-testnet-checklist.md:436 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] `importUsers` 写入地址和邀请码，不铸 CKEY，不铸 NFT，不发直推  
  来源：bsc-testnet-checklist.md:437 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 数组长度不一致失败  
  来源：bsc-testnet-checklist.md:438 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 重复导入同一地址失败  
  来源：bsc-testnet-checklist.md:439 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 导入自己当自己的上级失败  
  来源：bsc-testnet-checklist.md:440 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 导入成环失败  
  来源：bsc-testnet-checklist.md:441 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] `importVolumes` 只写本人业绩，`importedNfts = 业绩 / 500`，并占用全站 1 万张额度  
  来源：bsc-testnet-checklist.md:442 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 导入的业绩不进上级伞下，不产生网体奖，也不增加 `totalContributed`（因此不进 25% 帽的分母）  
  来源：bsc-testnet-checklist.md:443 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 导入之后的新入金才产生直推和网体奖  
  来源：bsc-testnet-checklist.md:444 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] `grantNft` 给未注册地址失败；张数为 0 失败；累计超过 `importedNfts` 失败  
  来源：bsc-testnet-checklist.md:445 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] `grantNft` 成功后 NFT 到账，本人业绩不变。到账当周起才计周息，补发前的周为 0  
  来源：bsc-testnet-checklist.md:446 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] `freezeImport` 后导入失败，然后才能 `openSale`  
  来源：bsc-testnet-checklist.md:447 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 第一次 `openSale` 写入 `saleOpenedAt`，并让周息合约 `saleOpened = true`  
  来源：bsc-testnet-checklist.md:448 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 开售前 `pending` 为 0  
  来源：bsc-testnet-checklist.md:449 · 10.1 导入、冻结、开售顺序。本轮状态：未完成。

- [ ] 先 `closeSale`，新入金停止  
  来源：bsc-testnet-checklist.md:453 · 10.2 结束 IDO。本轮状态：未完成。

- [ ] 再 `endIdo`。`idoEnded = true`。周息算到调用时所在的那一周为止（含这一周），再过几小时也不再增加  
  来源：bsc-testnet-checklist.md:454 · 10.2 结束 IDO。本轮状态：未完成。

- [ ] `endIdo` **不会**把 `saleOpen` 设成 false。若没先关售，结束后仍能入金；所以顺序必须是先关售再结束  
  来源：bsc-testnet-checklist.md:455 · 10.2 结束 IDO。本轮状态：未完成。

- [ ] 第二次 `endIdo` 失败  
  来源：bsc-testnet-checklist.md:456 · 10.2 结束 IDO。本轮状态：未完成。

- [ ] 结束后直推和已经发布的网体奖仍可领  
  来源：bsc-testnet-checklist.md:457 · 10.2 结束 IDO。本轮状态：未完成。

- [ ] 结束后新的一周不再产生周息  
  来源：bsc-testnet-checklist.md:458 · 10.2 结束 IDO。本轮状态：未完成。

- [ ] 直推比例 2500 时，继续入金直到直推累计接近全站 25%。此时再发布一笔会超帽的网体 root，失败；超帽的 `claim` 失败  
  来源：bsc-testnet-checklist.md:462 · 10.3 上限和帽（专用部署）。本轮状态：未完成。

- [ ] 把周息全站帽调到当前已结算额，再过一周，新利息为 0，少掉的部分不会在调高帽之后补发。帽不能调到 5000 万枚以上  
  来源：bsc-testnet-checklist.md:463 · 10.3 上限和帽（专用部署）。本轮状态：未完成。

- [ ] 单户帽按「当前张数 × 500 × 最新比例 × accountCapBps」。默认 100% 时，终身周息不会超过这份本金  
  来源：bsc-testnet-checklist.md:464 · 10.3 上限和帽（专用部署）。本轮状态：未完成。

- [ ] NFT 铸到 10,000 张后继续入金：交易不回滚，只铸满剩余额度，多出来的记 `nftDeferred`，并且这几张**不计周息**  
  来源：bsc-testnet-checklist.md:465 · 10.3 上限和帽（专用部署）。本轮状态：未完成。

- [ ] `export-deferred-nfts.mjs` 导出的地址和张数与链上 `nftDeferred` 一致  
  来源：bsc-testnet-checklist.md:466 · 10.3 上限和帽（专用部署）。本轮状态：未完成。

- [ ] CKEY 总供应顶到 10 亿时，继续入金铸币失败。这要铸满 10 亿枚，气体成本极高，可以只在本地 Forge 承认已覆盖，测试网跳过并在这里注明「跳过，本地已测」  
  来源：bsc-testnet-checklist.md:467 · 10.3 上限和帽（专用部署）。本轮状态：未完成。

- [ ] 导入用户不自动得到 CKEY  
  来源：bsc-testnet-checklist.md:471 · 10.4 早期用户本金。本轮状态：未完成。

- [ ] Owner 按「导入业绩 × 100」手动铸造后，余额正确，且可以和后来入金铸出的币加在一起  
  来源：bsc-testnet-checklist.md:472 · 10.4 早期用户本金。本轮状态：未完成。

- [ ] 手动铸造的币同样默认不能转，除非白名单  
  来源：bsc-testnet-checklist.md:473 · 10.4 早期用户本金。本轮状态：未完成。

- [ ] 停周息的是 `endIdo`。这套不调用。见 [bsc-testnet-manual.md](bsc-testnet-manual.md) 第 10 节  
  来源：bsc-testnet-checklist.md:483 · 11. 和本地结果对照（不用再测功能，只确认没有测错网）。本轮状态：未完成。

- [ ] root 发布后立即能领，没有挑战窗，也没有 `activateRoot`。这套还没发布 root。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)  
  来源：bsc-testnet-checklist.md:484 · 11. 和本地结果对照（不用再测功能，只确认没有测错网）。本轮状态：未完成。

共保留 155 条源文件未勾选记录（含跨文件重叠）。
