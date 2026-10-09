# BSC 测试网手动测试清单

链：**BSC Testnet，chainId 97**。不是本地 Anvil（31337）。

写这份清单时（2026-10-01）链上已是下面这套状态。先做只读核对，再做用户路径。会改全站的项目放在文末，并标明要不要另部署一套。

每做完一项，把 `- [ ]` 改成 `- [x]`。失败时不要打勾，在该项下面写交易哈希和实际结果。

## 0. 地址与当前状态

| 合约 | 地址 |
|------|------|
| MockUSDT | `0xee7ed7e5b14f4da53aa1fcea1cf7d8dab66d8d89` |
| CKEY | `0xc8569f7ff099194bfc28ae2656667e3e219184b9` |
| NFT | `0x2a91a91156feb3b82de8bbe976c5b3f0360fb460` |
| 金库 CoralIdo | `0xc3d351404a64771c6273178b7d234149be881b3a` |
| 网体奖 CoralRewards | `0x60997ed167e18f5e5318e44ace586b8a45dd8f88` |
| 周息 FreeDaoNFTInterest | `0x5066a7c90909d681cef4cfa731ad3eb76e447f47` |
| Owner / 当前 publisher | `0x8149a60BC2863DC23B32A75EE89409E20808906a` |

区块浏览器：`https://testnet.bscscan.com/address/<地址>`

当时读到的状态（只作起点，以你测试时的链上值为准）：

- 已开售，导入已冻结，金库未暂停，IDO 未结束
- 全站已入金 12,000 USDT
- 直推 10%，最低入金 1 USDT，直推门槛 100 USDT
- 1 USDT = 100 CKEY
- 一周 = **1 小时**（从开售时间戳起算，不是北京时间周日）
- 当时 `currentWeek = 167`
- 奖励 root 还是空的，`maxRootIncrease = 0`（不限单次增量）
- 周息四档已写入：2 / 10 / 20 / 60 张，每周 1% / 2% / 2.5% / 3%
- 更换奖励合约的等待时间是 1 小时

### 0.1 只读核对（谁都可以做）

- [x] 钱包网络是 BSC Testnet，chainId 显示 97
- [x] 上面 6 个地址在浏览器上都能打开，且字节码不是空的
- [x] 金库 `usdt()` / `nemo()` / `nft()` / `rewards()` / `nftInterest()` 分别等于上表
- [x] `saleOpen = true`，`importFrozen = true`，`paused = false`，`idoEnded = false`
- [x] `minIdo = 1e18`，`minReferralAmount = 100e18`，`directReferralBps = 1000`
- [x] `tokensPerUsdt = 100e18`，`nftCap = 10000`，`weekDuration = 3600`，`weekByBlock = false`
- [x] `ambassadorMin = 100e18`，`partnerMin = 1000e18`，`rewardsDelay = 3600`
- [x] 周息 `calendarWeeks = false`，`saleOpened = true`，`interestCap = 5000万枚`，`accountCapBps = 10000`，`versionCount = 1`
- [x] CKEY `minter` 是金库，`interestMinter` 是周息合约，`paused = false`
- [x] NFT `minter` 是金库
- [x] MockUSDT `decimals = 18`
- [x] 奖励合约 `publisher()` 等于你准备用来发 root 的地址；此刻它等于 Owner
- [x] 记下测试开始时的 `currentWeek`、`totalContributed`、金库 USDT 余额，后面对照增量用

2026-10-01 17:29（UTC+8），区块 `134222188`：`currentWeek = 169`，`totalContributed = 12000 USDT`，金库 USDT 余额 `11000 USDT`。六个合约字节码长度都大于 0。`publisher()` 与 Owner 同为 `0x8149a60BC2863DC23B32A75EE89409E20808906a`。链 ID 用 RPC `eth_chainId` 核对，没有打开钱包页面。

## 1. 准备钱包和测试 USDT

准备 8 个测试网地址，不要用 Owner 当普通用户。下面用代号：

| 代号 | 用途 |
|------|------|
| A | 上级，先入金 |
| B | A 的下级 |
| C | A 的另一个下级，测小额 |
| D | B 的下级，测两级关系 |
| E | 无上级 |
| F | 只注册、不入金，用来测「有下级后不能再绑上级」 |
| G | 拆单入金 |
| P | 专门发 root 的地址（可以先仍用 Owner，第 8 节再换） |

- [X] 8 个地址都有测试网 BNB，够付 gas
- [X] 用 Owner 给 A–G 铸造 MockUSDT（`mint`）。小树大约每人 2,000 USDT 就够；第 7 节大树另说
- [X] 每个要入金的地址先 `approve` 金库，额度不少于计划入金
- [X] 额度不足时入金失败，批准后再入金成功
- [X] 向金库直接转 BNB 失败（金库不收 ETH）

2026-10-01 17:31（UTC+8）：地址 `0xc297969E261Cd146F555eBc32255EB8371Ba7FCC` 向金库转入 1 wei。交易 `0x9824903775a6e0e89ad8fb647a005fa1e6529a065239b8c4f39e594ed2e6fed9` 状态为 reverted，gas 21043。金库 BNB 余额仍是 0。

邀请码用大写字母或数字，1–32 位，例如 `TESTA001`。调用时是 `bytes32`，ASCII 左对齐，右边补 0。

## 2. 注册和邀请

### 2.1 成功路径

- [x] A `register(自己的码, 0x0)` 成功。`getAccount` 已注册，上级是 0，邀请码能反查到 A
- [x] B `register(自己的码, A的码)` 成功。`referrerOf(B) = A`，`hasChildren(A) = true`
- [x] C 同样绑定 A，成功
- [x] E `register` 不带上级，成功
- [x] F `register` 不带上级，成功
- [x] D 先只 `register` 自己的码、不绑上级，成功
- [x] D 再 `bindReferrer(B的码)` 成功。`referrerOf(D) = B`
- [x] 32 位全是大写字母或数字的邀请码可以注册

2026-10-01 18:12（UTC+8）。索引 1、2 已经注册过，这次用未注册的 3–9。gas 从索引 2 各转 0.002 BNB。

| 角色 | 索引 | 地址 | 邀请码 | 结果 |
|------|------|------|--------|------|
| A | 3 | `0xC0a5A322f3285d9DfAdd588d3d9be0ea90cc3969` | `T1001A01` | 已注册，上级是 0，`codeToAccount` 指向 A。`0x48062255aa8561561ee5c2ba53a24ab6ecd36522bd1ea47b6695ff3c91821ff4` |
| B | 4 | `0x8b99662ad52a674837BE88E1223665EAEd33E446` | `T1001B01` | 上级是 A，`hasChildren(A) = true`。`0x0d9f6df8db81af7138e349d7562c956eb4db27aa914f7ff275efedfa40fea3bb` |
| C | 5 | `0x07c9f71f23B4f5B1d026f7C07fC9c3ab0791B661` | `T1001C01` | 上级是 A。`0x4a47c5ad41b15e2b774b4c14e830be8f6cd9cfd368898d015967fe7922f93130` |
| E | 6 | `0x120aB60C24711C048D2C81f6CA6409460a95133D` | `T1001E01` | 已注册，上级是 0。`0x316a532bafc105a66ab9f4fc71baa636eef22ca8502f1ac32864ccddc93423b3` |
| F | 7 | `0x0571E71A467496762D665a6fc846354Bbd0cC5CB` | `T1001F01` | 已注册，上级是 0。`0x17027724cbb1107c9f67b6b2a3ff73a8671bb10f5c756dbdc264065af9eb035b` |
| D | 8 | `0xBC088f2AeE9ce51C1e1fF68Cf416E9549fE2a71D` | `T1001D01` | 先注册无上级 `0x4cae5dad6c39edcb3c8d5dbf851ae12f8ec0a389115ce7c7fbebeefeda6c1107`，再绑定 B `0x87acb093580da1ddd6b02a8e1777440aac2930e57b5dc471d631f99a26157b60`。`referrerOf(D) = B` |
| 32 位 | 9 | `0xa5186548b1Ed68cc64A5Bab66fDe062963DF3bd2` | `T1001ABCDEFGHIJKLMNOPQRSTUVWXYZ0` | 已注册，码长 32，能反查到该地址。`0x7b10e454fa624df010361cc2f22cf5e5b2932b42b091a714f011725980d6c696` |

### 2.2 应该失败

- [X] 空邀请码失败（`InvalidCode`）
- [X] 小写字母失败
- [X] 含空格、符号、中文失败
- [x] 中间插 0、后面又有字符失败（`bytes32` 里 0 只能出现在末尾填充）
- [x] 超过 32 位无法编码，不要当成合法码
- [x] 重复使用 A 的邀请码失败（`CodeTaken`）
- [x] A 再注册一次失败（`AlreadyRegistered`）
- [x] 未注册地址 `bindReferrer` 失败（`NotRegistered`）
- [x] B 再绑一次上级失败（`AlreadyBound`）
- [x] 用自己的邀请码当上级失败（`SelfReferral`）
- [x] 用不存在的邀请码当上级失败（`InvalidReferrer`）
- [x] 让一个新地址先当别人的上级（自己已有下级），再 `bindReferrer` 失败（`HasChildren`）。做法：F 邀请一个新地址注册成功后，F 再绑上级应失败
- [x] 已有上级的地址不能反过来绑自己的下级，避免成环

2026-10-01 18:20（UTC+8）。失败项用链上 `eth_call` 核对回滚原因，没有改账户状态。33 位字符串无法放进 `bytes32`，没有发交易。

| 项 | 调用方 | 回滚 |
|----|--------|------|
| 空码、小写 `t1001z01`、空格、`A-B001`、中文「中」、`AB\0C` | 索引 10，未注册 | `InvalidCode` |
| 再用 `T1001A01` | 索引 10 | `CodeTaken` |
| A 再注册 | 索引 3 | `AlreadyRegistered` |
| 未注册就 `bindReferrer` | 索引 10 | `NotRegistered` |
| B 再绑上级 | 索引 4 | `AlreadyBound` |
| E 用自己的 `T1001E01` 当上级 | 索引 6 | `SelfReferral` |
| E 用不存在的 `NOSUCH01` | 索引 6 | `InvalidReferrer` |
| F 已有下级后再绑 A | 索引 7 | `HasChildren` |
| B 改绑自己的下级 D | 索引 4 | `AlreadyBound` |

F 的新下级是索引 11 `0xe464819Ce6A4fb55e09F1BE0F43054d64F3Bb381`，邀请码 `T1001N11`，注册交易 `0x18fa8c737690ad0b3c0c97797f5c8696fe7d48c191786b3783d0a5d1f40625fc`。注册后 `hasChildren(F) = true`。gas 从索引 2 转入，交易 `0xe4615c523eae350226851f29d85aa7fd4d9bb89bfff4701cc591d7e3ec5441bf`。

## 3. 入金、身份、CKEY、NFT

入金前再看一眼 `saleOpen` 仍是 true。金额单位是 18 位小数的 USDT。

身份 `roleOf`：未注册或业绩为 0 是 `0 None`；有业绩且 &lt; 100 是 `1 Explorer`；≥ 100 且 &lt; 1000 是 `2 Ambassador`；≥ 1000 是 `3 Partner`。链上没有「共建者」，共建者只在链下算。

实发 CKEY 用 `tokensFor(金额) = 金额 × 100`。`quote()` 是另一套周递减显示，**入金不按 quote 铸**。

### 3.1 金额和身份

- [x] 未注册地址 `contribute` 失败（`NotRegistered`）
- [x] 已注册但金额为 0，或小于 1 USDT，失败（`AmountTooSmall`）
- [x] E 入金刚好 1 USDT：成功；业绩 1；CKEY +100；NFT 仍是 0；`roleOf = Explorer`；因为没有上级，没人得到直推
- [x] E 再入金 0.5 USDT 失败（低于最低入金）
- [x] C 入金 99 USDT：成功；CKEY +9,900；NFT 0；`roleOf = Explorer`；A 的直推**不增加**（不满 100）
- [x] B 入金 100 USDT：成功；CKEY +10,000；NFT 0；`nftRemainder = 100 USDT`；`roleOf = Ambassador`；A 的 `pendingOf` 增加 **10 USDT**
- [x] A 入金 1,000 USDT：成功；CKEY +100,000；NFT **2** 张；`roleOf = Partner`；A 没有上级，直推不增加
- [ ] 直推看推荐人本人累计是否 ≥ 100 USDT。零业绩上级的下级入金 100，该上级直推仍是 0。本人正好 100 的上级，下级入金 50，直推增加 5 USDT
- [x] 单笔 1,200 USDT：NFT +2，余数 200 USDT，CKEY +120,000
- [x] 单笔 499 USDT：NFT 不变，余数 499
- [x] 单笔 500 USDT：NFT +1，余数 0

2026-10-01 18:29（UTC+8）。未注册和金额过小用链上 `eth_call` 核对。成功入金的交易如下。

| 项 | 地址 | 交易 | 结果 |
|----|------|------|------|
| 未注册入金 | 索引 10 | 调用回滚 | `NotRegistered` |
| 金额 0、以及 E 再入 0.5 | 索引 6 E | 调用回滚 | `AmountTooSmall` |
| E 入金 1 | `0x120aB60C24711C048D2C81f6CA6409460a95133D` | `0xa5203a56bc4f23e2b11a3f0fe14bd102d6c8ea9a04efc9f2a0b1d045287f44b2` | 业绩 1，CKEY +100，NFT 0，角色 Explorer，无直推事件 |
| C 入金 99 | `0x07c9f71f23B4f5B1d026f7C07fC9c3ab0791B661` | `0x62e8e4f4cb1cb8caf7e293cb4fa51c1753a07542811482121cf3e4362bfe3cf6` | CKEY +9,900，NFT 0，角色 Explorer，A 的待领不变 |
| B 入金 100 | `0x8b99662ad52a674837BE88E1223665EAEd33E446` | `0xb00bcfaaa5b4b0562d97d6e62ce477bc232fce72865df6ba65011b9c760d84f9` | CKEY +10,000，NFT 0，余数 100，角色 Ambassador，A 待领 +10 |
| A 入金 1,000 | `0xC0a5A322f3285d9DfAdd588d3d9be0ea90cc3969` | `0x2ea1ec0db63907a1e9cb0d8e07da58406a1c903a0538e3894f81afc9067ec345` | CKEY +100,000，NFT 2，角色 Partner，全站直推总额不变 |
| F 的下级入金 100 | 下级索引 11 `0xe464819Ce6A4fb55e09F1BE0F43054d64F3Bb381` | `0xe0344e1a798d5ca20765e15ea331bffc35b9242712643a6731e5b338d05b95db` | F 本人业绩仍是 0，待领 +10 |
| 单笔 1,200 | 索引 12 `0x899a55eCCDb71F30894E33bbe8CAe0e5DA64566A` | `0x38676db47d27dd949cf499840888186ceb282193da432280c23bc7bfaef5c47f` | NFT 2，余数 200，CKEY +120,000 |
| 单笔 499 | 索引 13 `0xa061228A119370b2Fd4B08a494BA427f80881EBA` | `0x2a5e2b1547296075570c3eeebd1803390a0b7ed463abdb855cd86f4ec3bd4cc8` | NFT 0，余数 499 |
| 单笔 500 | 索引 14 `0xCC55C57A3be41dfb3dF30eCDC46D5beDdf14DD05` | `0x532b40f101f4800aa20a1d5e583168e0cbe344dfbc089074a2c3999aabffcc8d` | NFT 1，余数 0，CKEY +50,000 |

### 3.2 拆单凑 NFT

- [x] G 第一笔 250 USDT：NFT 0，余数 250，CKEY +25,000；若 G 的上级存在且 250 ≥ 100，上级直推 +25
- [x] G 第二笔 250 USDT：这一笔才铸出第 1 张 NFT，余数 0，CKEY 再 +25,000
- [x] 另一地址第一笔 400、第二笔 100：第二笔铸出 1 张。100 刚好达到直推门槛，上级直推只增加第二笔的 10%，第一笔 400 已经在当时记过 40

2026-10-01 22:28（UTC+8）。索引用的是尚未注册的 15–18，gas 从索引 2 各转 0.002 BNB。

| 角色 | 地址 | 交易 | 结果 |
|------|------|------|------|
| G 的上级 | 索引 15 `0xF89efe74a09E54474b58878825f94aa8f1D8afe3` | 邀请码 `T1001R15` | 两笔各记 25，合计待领 50 |
| G | 索引 16 `0x597ffbd40C2a5A249c22fc1A8A20f0a31E435A61` | 第一笔 `0xb6b798580b42ceedd79462f265a69a7ac1edc10731e9d5810a9b01e5ac37e495` | NFT 0，余数 250，CKEY +25,000，上级 +25 |
| G | 同上 | 第二笔 `0x6059ed54a58c611fa767d435537c57d5eea8b6c4c58cedbbb334262a33b1586a` | 这一笔铸出第 1 张，余数 0，CKEY 再 +25,000，上级再 +25 |
| 另一地址的上级 | 索引 17 `0x2d1fc830d6ea39fbd8ca0684b601c350d465aEB1` | 邀请码 `T1001R17` | 第一笔记 40，第二笔只再记 10 |
| 另一地址 | 索引 18 `0x0E3b61C283B1A10D23Aee2088820c8C46cadB682` | 400：`0xf5e92040ed63473c28cd0fff8a919615a377f3ca2e16944f183335b8dc44b2ae`；100：`0x4d6ce6b6ecb0281e37e46c32414f830cf61cbdea2908b3d041f4715e6ed18d95` | 第一笔 NFT 0、余数 400；第二笔才铸出 1 张，余数 0 |

### 3.3 一次调用完成注册和入金

- [x] 新地址 `registerAndContribute(新码, A的码, 100e18)`：同时完成注册、绑定 A、入金。A 直推 +10，该地址 CKEY +10,000
- [x] 已经注册的 B 再调 `registerAndContribute`，传入另一个新邀请码：交易仍可入金，但邀请码保持原来的，不会改绑上级

2026-10-02 10:08（UTC+8）。

| 项 | 地址 | 交易 | 结果 |
|----|------|------|------|
| 新地址一次完成 | 索引 19 `0x865616feF95FBeBd8c87ce70fFF1D3eCFD0072aE`，邀请码 `T1001N19` | `0xd69589cb660723e185f35897f50b19475e74546d1b54ed20b246567ce6b6751f` | 已注册，上级是 A，业绩 100，CKEY +10,000，A 待领 +10 |
| B 再次调用 | 索引 4 `0x8b99662ad52a674837BE88E1223665EAEd33E446`，传入未使用的 `T1001BNEW` 和 E 的邀请码 | `0x111792c8d2cb6da0aafd48fcb38cb2cdc37333bc3b4a024a8b6319afe26a300d` | 入金 100 成功，CKEY +10,000。邀请码仍是 `T1001B01`，上级仍是 A，新码没有被占用。直推仍记给 A，+10 |

### 3.4 铸币和转账限制

2026-10-02 10:21（UTC+8）。甲是索引 6 `0x120aB60C24711C048D2C81f6CA6409460a95133D`，乙是索引 5 `0x07c9f71f23B4f5B1d026f7C07fC9c3ab0791B661`。回滚项是 `eth_call`，没有落交易。

- [x] 用户自己不能给自己铸 CKEY（`NotAuthorized`）
- [x] 两个普通地址互转 CKEY 失败（`TransfersLocked`）
- [x] Owner 把地址甲加入转账白名单后，甲可以转给未白名单地址；未白名单地址也可以转给甲。加入 `0xd007eda47ed65b3d1f90beb2d9e97e5240b78111a2725cb2b40115d36cd8d216`，甲转乙 `0xf091ca92d25e6b576b359764d8d10ab669129b89ceac45cc3c0493d66e40e395`，乙转回甲 `0xa55ab71794e75a023812ce32beb39128abb6e6c2f97c3130dd2a746e9ca14420`
- [x] 两个都不在白名单里的地址仍然不能互转（乙转索引 4，`TransfersLocked`）
- [x] Owner `setTransferAllowlist(甲, false)` 后，上述放行取消。取消 `0xdac4db94bffa47889baeb6166153ba20368d0e72dcc6de528a5e40af71b60673`，之后再转回 `TransfersLocked`
- [x] NFT 不能转让给别人（灵魂绑定）。索引 20 的 NFT `transferFrom` 回滚 `TransfersLocked`
- [x] 普通地址调用 NFT `mint` 失败（`NotAuthorized`）
- [x] Owner 再调用 NFT `setMinter` 失败（`MinterAlreadySet`）
- [x] 入金铸出的 CKEY 记入金库 `totalNemoAllocated`。索引 6 入金 100，`0x5ab372784e2e4f865a07985f622f3c0d04e655a42a3309a002e0f9c8dfd89fb2`，分配额增加 10,000 枚
- [x] Owner 直接 `CoralToken.mint` 一笔「早期用户本金」成功，且**不**增加 `totalNemoAllocated`。`0x35fb8e559e876ec2a4034a0663704ac78b01ada50c17b794d7cd9d75bf9327f5` 铸 1 枚，分配额仍是 1,684,900 枚
- [x] 把别的代币误转到 CKEY 合约后，Owner `rescue` 可以取回。误转 1 MockUSDT `0x0f3fc1b601ff1109643de988b73ea3746c519dd4f7067e8c21803b4fbbe5e8e6`，取回 `0xc517ce14d31c0e8a2eb3a352df1a4469b1bd9923741da72ba59822f7a4e795db`
- [x] `rescue` CKEY 自己失败（`RescueSelf`）

### 3.5 quote 和实发不是一回事

- [x] 读 `quote(100e18)`，记下数字。当时是 **6,280** 枚，`tokensFor(100e18)` 是 **10,000** 枚
- [x] 同一时刻入金 100 USDT，实收 CKEY 是 10,000 枚，等于 `tokensFor`，不必等于 `quote`。交易 `0x5ab372784e2e4f865a07985f622f3c0d04e655a42a3309a002e0f9c8dfd89fb2`
- [x] Owner 调用 `setTokensPerUsdt` 改成 1 USDT = 50 枚后，**下一笔**入金按 50 铸；已经铸出的余额不变。改比例 `0xd49e35eed4929b70a25721fa02a023123388b03f8785424868d022e628f3674b`，入金 `0xed5b80658e3c8e07d132158dd5d4eaa07f0ccb6d2f56b1f1cefda31fc239a0e3`，新得 5,000 枚，改比例前的余额没有被改写
- [x] 测完把 `tokensPerUsdt` 改回 `100e18`。`0xad08d538ea5a49a50782bbb8dd8d6b751dcfd32d2068a62811213a0a68cb7b70`
- [x] Owner 改 `setNemoSchedule` / `setNemoBonus` 后，只影响之后的 `quote()` 显示，不改变 `tokensFor` 的实发。测完改回原参数。`setNemoBonus` 临时 `0xa892bf77e49cc0d0820d6565dc101c36cb4471b72e81fadb60489588ddce387e`，`quote(1000e18)` 从 64,056 变成 65,940，`tokensFor` 仍是 100,000；改回 `0xc4481788bf2851d2580c5d7769dc6602755ee256820b0f1857e33cc83a1465cb`。`setNemoSchedule` 临时 `0x0eb409b7985233a875bbb0b5e412f0df6d84be1532ab2183e8e36e14ec5c71fc`，`quote(100e18)` 变成 6,094，`tokensFor` 仍是 10,000；改回 `0xad22d78b88b700209458c6724404a97b055e976993971dbdd73bc25b8064848b`

## 4. 直推领取和金库资金

用第 3 节已经产生的直推，不要先动关售和暂停。

- [x] 没有直推的地址 `claim` 失败（`NothingToClaim`）。索引 4
- [x] A `claim` 成功，收到此前全部待领 USDT（按第 3 节实际累加：至少含 B 的 10）。`0xca25ec5d05d78b585c42842c775eb7c73fc058922169e8c03c70c6becf6e97ec`，到账 30 USDT
- [x] A 的 `pendingOf` 变为 0，`claimed` 等于原来的 `directRewards`（都是 30 USDT）
- [x] A 马上再 `claim` 失败（`NothingToClaim`）
- [x] 再让 B 入金 ≥ 100 后，A 又能领到新的一笔，金额是这笔的 10%。改回 1000 bps 后 B 入金 100，`0xfe34fe53de21662151b720b1fa66722978e0485437991542de5bb0ff9cfc11a2`，A 待领 +10
- [x] 金库 USDT 余额 = 可提取 `treasuryWithdrawable` + 准备金 `reservedRewards`。当时 15,899 = 15,559 + 340
- [x] `reservedRewards` = 未领直推 + 网体奖 `outstanding`。root 还没发布时，outstanding 为 0，准备金就等于未领直推。当时准备金 340，outstanding 0
- [ ] Owner `withdrawTreasury` 提取恰好等于 `treasuryWithdrawable` 成功。这一套只提了 1 USDT 证明能转出，`0x935c8471a836a2853be5baf9a7e17d540f436bfe211b3beda360d4099c564812`，没有把可提取余额提光。一次提光见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [x] 再多提取 1 wei 失败（`InsufficientTreasury`）。这里是「可提取余额 + 1 wei」的调用回滚，不是把余额提光之后再提
- [x] 提取不会让余额低于未领直推。A 仍能把自己的直推领走。提走 1 USDT 后 A 仍有 15 USDT 待领，之后关售期间和只停 CKEY 期间都领走了
- [x] `withdrawTreasury` 给零地址失败（`ZeroAddress`），金额 0 失败（`InsufficientTreasury`）
- [x] 金库里如果没有 CKEY，`withdrawUnsoldNemo` 失败。当时金库 CKEY 余额是 0，调用回滚 `InsufficientNemo`

直推比例（测完改回 1000）：

- [x] `setDirectReferralBps(2501)` 失败（`RewardBpsTooHigh`）
- [x] `setDirectReferralBps(500)` 成功。下一位下级入金 100，上级只得 5 USDT；改比例之前已经记下的直推金额不变。改比例 `0x3399b0b764881dee6ee21723020b47bd35cf0257c81578fedb1f85888382e1fd`，B 入金 `0xd3c9af97a3a73419c3038049f98630f8b98eb9e1b608c737672b32bb98fc2ee0`，A 新待领 +5，已领取的 30 USDT 不变
- [x] 改回 `1000`。再入金 100，上级得 10。改回 `0x27d650acf1fdcf682dfcd7ae1eb81dff7cf810daa549dcb9214c7bf345d1352f`，B 入金 `0xfe34fe53de21662151b720b1fa66722978e0485437991542de5bb0ff9cfc11a2`

门槛（测完改回）：

- [x] `setMinIdo(0)` 失败（`AmountTooSmall`）
- [x] `setMinReferralAmount` 改成 50e18 后，入金 50 也会发直推；改回 100e18 后，入金 50 不再发。改门槛 `0x53d43c0b1db9d5349eb1d0f1bc0cf97fd2ab3cc2e4b291a5eb4c3e8f7be7cca2`，索引 19 入金 50 `0xd39a506bfd525871e675c87f17e1d82813143a7216f6efbb5b2c8cf59752376e`，A 待领 +5。改回 `0x9b3382d241cc01510d671c66be730eda9f9a159257cb82bf83a99097753e0141`，再入金 50 `0xf55b672945adf6ce50ff5a19675d35a31c07a2115ca8cf9e0c30f76fea7b3477`，A 待领不加
- [x] `setIdentityThresholds(0, 1000e18)` 失败（`InvalidThresholds`）
- [x] `setIdentityThresholds` 把大使门槛设得高于合伙人门槛，失败（`InvalidThresholds`）
- [x] 合法地改门槛后，`roleOf` 按新门槛重算已有业绩；测完改回 100 / 1000。临时把大使门槛调到 500，`0x5adaa7649f54b490ab9b03309e3ff32b2a972037c7c2db6ccd4bd8c069a5f28b`，索引 6 从大使（2）变成探索者（1）。改回 `0xfd129e2331f3ebaec3c9aba8b404a3fe7f10b92b8b41296059015a834262487f`，身份回到大使

## 5. NFT 周息

测试网一周 = **1 小时**，从金库 `saleOpenedAt` 起算。`pending` 不含当前这一周，要等 `currentWeek` 变成下一周。

周息打到 CKEY，不打 USDT。本金 = 张数 × 500 USDT × 该周的 `tokensPerUsdt`（默认 100）。落在两档之间用已经达到的最高档。

| 张数 | 对应入金 | 每周 |
|------|----------|------|
| 0 或 1 | &lt; 1000 | 0 |
| 2–9 | 1000–4999 | 1% |
| 10–19 | 5000–9999 | 2% |
| 20–59 | 10000–29999 | 2.5% |
| ≥ 60 | ≥ 30000 | 3% |

### 5.1 等一小时就能看的

A 的 1,000 USDT 是 2026-10-01 入的，到本轮时已经过了很多周。当周 `pending = 0` 改用索引 20 核对。等满 1 小时之后的结果见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。

- [x] 还在第 W 周时，新的 2 张 NFT 地址 `pending = 0`（当周还没结束）。索引 20 `0x5fb9fa20B90B4542a91487cd93817e7Fe78c87Bc`，邀请码 `T1002W20`，第 **186** 周入金 1,000，`0x5940ba6832401517ab0aa5d94e895476b0bbb7296b87b43a6322ca587938d3bb`，NFT 余额 2，`pending = 0`。第 187 周从 2026-10-02 11:04:22（UTC+8）开始
- [ ] 只有 1 张 NFT 的地址，过了一周后 `pending` 仍是 0。索引 19 已在第 186 周补到正好 1 张，当周 `pending = 0` 已核对；过周后见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] `currentWeek` 变成 W+1 后，索引 20 的 `pending = 1000` 枚 CKEY（2 张 × 500 × 100 × 1%）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 索引 20 调用周息合约 `claim()`，CKEY 增加 1000，USDT 不变，`pending` 回到 0。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 没有可领时再 `claim` 失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 漏领一周没关系：两周都不领，一次 `claim` 拿到两周的和。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

### 5.2 后买的 NFT 不改已经结束的周

要等第 186 周结束。步骤和预期在 [bsc-testnet-manual.md](bsc-testnet-manual.md)。先读完索引 20 在第 187 周的 1,000 枚，再给它加 NFT。

- [ ] 在 W+1 周内让持有 2 张的地址再入金 4,000 USDT，NFT 变成 10 张。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 这一笔入金交易里，周息先按旧的 2 张把已经结束的周结清，再铸新 NFT。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 等到 W+2，`pending` 新增的是 **10,000** 枚（10 张 × 2%），不是把第 W 周也改成 2%。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 两档之间：9 张仍按 1%，刚好 10 张才按 2%；19 张按 2%，20 张按 2.5%；59 张按 2.5%，60 张按 3%。各用一个地址入金到对应张数，过一周核对。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

### 5.3 关售不停周息，结束 IDO 才停

这一组会关售。做完第 5.3 的前两项就重新开售，把 `endIdo` 留到第 10 节。

- [x] Owner `closeSale` 后，新入金失败（`SaleClosedError`）。关售 `0x5f19f887a0fe55e2b8a4f7fd0ebfc182f43989a69d428b630d92dea7562f41a0`
- [x] 关售期间，已有直推仍能 `claim`。`0x6240a2fc7f1200b0eb611f89ebee2434aa9b0ba39cf80747f838a36fbbc555e6`，A 领走 20 USDT
- [ ] 关售后再过一小时，已持有的 NFT **仍在计息**。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。本轮测完立刻重新开售，没有干等一小时
- [x] Owner `openSale` 后可以再次入金。`saleOpenedAt` 保持第一次开售的时间，周序号不重置。开售 `0x1c73004cb390fd2b57a675bbf6bd6e88e2113bf70d0c68b08f493610b4fceaa7`，`saleOpenedAt` 仍是 `1790237062`。之后索引 6 入金 1 USDT `0x0b62197ffdc7b7f3ec8946f6dac8db908509dbc29a18b4982badd499dd0c8314`
- [x] 还没 `endIdo`。不要在这一节调用它。`idoEnded` 仍是 false

### 5.4 改档位（同一周内改回）

改档位从**当前这一周**起生效，会影响所有人当周还没结算的利息。请在同一周内改回原档。

原档：`(2, 100bps)`、`(10, 200)`、`(20, 250)`、`(60, 300)`。

- [x] `setTiers` 空数组失败（`InvalidTiers`）
- [x] 超过 16 档失败（`InvalidTiers`）
- [x] 门槛不严格递增失败（`InvalidTiers`）
- [x] 某一档每周 0 或超过 10%（1000 bps）失败（`InvalidTiers`）
- [x] 合法改成只有一档 `(2, 200)`，`versionCount` 加 1，`fromWeek` 是当前周。`0x595c4b92f01701793642a5f2165b09f369787bf892bafa52d06d91f9aff8158f`，版本从 1 变成 2，`fromWeek = 186`
- [x] 同一周再改回原四档，这一周的版本被覆盖，而不是再叠一版。`0xe05c7c75223193dc729fd8c663343f26ed6c322380f5adb8e04ba666ac26b769`，`versionCount` 仍是 2。测完又写回一次 `0x9913fcfefa1f04f4d6486d7f2b9129fce2f2c711d012d2803b0f5d6206438b2d`。当前版本是 `(2,100)、(10,200)、(20,250)、(60,300)`
- [ ] 等这一周结束后，利息按改回后的原四档计算。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。索引 20 在第 187 周若是 1,000 枚而不是 2,000 枚，就说明改回的四档生效
- [x] `setInterestCap` 设成大于 5000 万枚失败（`InterestCapTooHigh`）
- [x] `setAccountCapBps` 大于 10000 失败（`InvalidTiers`）
- [ ] 把单户上限暂时改低后，该地址继续领取会被帽截断，超出的部分不计、也不留到以后。少掉的利息不会补发，不在这套已有用户的合约上做。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 不要在这套已有用户的合约上把全站 `interestCap` 压到当前 `totalAccrued`，否则所有人停息。全站帽测完即停的用例放到第 10 节的新部署。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

## 6. 暂停

暂停会影响所有人，测完立刻恢复。

- [x] 金库 `pause` 后：`register`、`bindReferrer`、`contribute`、`registerAndContribute`、直推 `claim` 都失败（`EnforcedPause`）。只停金库 `0xc4306d746d9afb6b604d8435dc798c4224b7fbf77d52d4217d64a4fa0ee0751b`，恢复 `0x9baaa925b32019733bec0094a03b0d371884044b07912d94ec23713a606fd57b`
- [ ] 暂停期间网体奖 `claim` 也会失败（金库 `disburse` 受暂停限制）。这套还没有发布 root，见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [x] 暂停期间周息 `claim` **仍然成功**（只暂停金库挡不住周息）。`0xa09b46f44734595d184f7052cfca0a45c814b5227c085fb6e90a9ff1feb441fc`，A 领走 16,000 枚 CKEY，USDT 不变。这是 A 截至当时已经结束的周，领完后待领为 0
- [x] `unpause` 后，入金和直提恢复。恢复后 B 又入金 100，`0x7e6e67d5b0c344d4de508dc071626d894d2c2229752ce518dc56969574a078cc`。双暂停时注册已确认失败，恢复后售卖保持打开
- [x] 只暂停 CKEY：新入金失败（铸币被停），周息领取也失败；直推 `claim` 仍可成功（它转的是 USDT）。第一次暂停 `0x3be1ce6975006cbd8c9ce5c7ffedf84891662d81e052c5fea972c4b15109f1e6`：周息回滚 `EnforcedPause`，直推领取 `0x0924e3bf814005af62991d7bafd57de5c0312a61d8871a3e9c1d2755b2aa8b1f`，A 领走 40 USDT，然后恢复 `0x3b7737f465b3f2592ccfd88e86371d4e8073584a6d71702038b5d8bc38c76449`。入金那一次当时授权不够，不能当成暂停证据。补测时先授权 1 USDT，再暂停 `0x844a79691ac023e9f66f12ee6e9220cea526c6b01becf21ca03bd49d71ec3e95`，入金回滚 `EnforcedPause`，恢复 `0xf3c504d7fc384fdb19b4ffbce64386d2b82ff181fcaab213526f3d7dfd806317`
- [x] CKEY `unpause` 后，入金和周息恢复。恢复后的入金见上一项 B 的 100 USDT；周息在只停金库、CKEY 已恢复时领走了 16,000 枚
- [x] 两个都暂停时，入金、直提、周息失败（`EnforcedPause`）；两个都恢复后恢复正常。金库暂停 `0x7b16e287dbd84690004341e3a7171591c832e43b174a0d08200e2a870401f376`，CKEY 暂停 `0xfe511911496854694fd494b4489b19c04fe905c2d1f67910070edf2f02d0fa56`，恢复 `0x36c868eb7c8665d796f7185bc5faa23232f340d2ac8fbeb87626b5659878c37f` 和 `0x9d611d4543f431be986b25eb5624fadfbd480f1f8fdd3d0e392b39d377ca01d3`。网体领取要等发布 root，见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

## 7. 网体奖（链下计算 + 测试网发布）

合约不在入金时发网体奖。索引器写入 Postgres，publisher 发 root 之后用户才能领。

拿奖人本人累计满 100 USDT 才有直推和网体奖。不到 100 的不占档位，直推也不顺延。凑满 100 只对之后的新入金计奖。下级入了多少只决定奖金金额。

档位看的是**这笔入金加进伞下之前**的「本人 + 伞下」：

| 之前的资格 | 费率 |
|------------|------|
| ≥ 500 | 3% |
| ≥ 2,000 | 5% |
| ≥ 10,000 | 7% |
| ≥ 30,000 | 9% |
| ≥ 60,000 | 10% |

极差从 0 往上算，入金者自己的档位不参与。两个都已是 10% 的上级：近的那个拿极差，再往上最近的另一个 10% 只再拿这笔网体奖的 10%，只抽一次。

### 7.1 先设发布上限

- [x] 陌生人调用 `publishRoot` 失败（`NotPublisher`）。索引 6 的调用
- [x] `setPublisher(0)` 失败（`ZeroAddress`）
- [ ] 在发第一期 root 之前，Owner `setMaxRootIncrease` 设一个你这期增量盖得住的值（例如小树预期网体奖的 2 倍）。设成 0 表示不限制，测试网可以暂时这样，但上主网前必须设上限。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 设一个故意很小的上限，发布一个更大的 `cumulative` 失败（`IncreaseTooLarge`）。然后把上限改回够用的值。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

### 7.2 小树（建议必做）

在索引开始之前，用新地址做这三笔，避免和旧的 12,000 USDT 混在预期里。旧入金如果没被索引过，索引器仍会从起始区块重放，预期以数据库算出来的累计额为准，下表只核对这三笔的增量。

1. 上级 S 无推荐人，先入金 **1,000** USDT（资格达到 3% 档）
2. 下级 T 绑定 S，入金 **1,000** USDT
3. 下级 U 绑定 S，入金 **99** USDT（S 已满 100，直推和网体都按 99 算）

手算：

- T 的 1,000：S 直推 **100**（链上）；网体 **30**（3%）
- U 的 99：S 直推 **9.9**；网体 **2.97**
- S 的网体累计 **32.97 USDT**；T、U 自己的网体是 0

本机 `.env` 的 `DATABASE_URL` 是空的，发布还会从金库付出 USDT。整节见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。

- [ ] `npm run index:rewards` 连的是测试网 RPC、chainId 97、上面的金库地址，而不是本机 8545。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 索引追上最新区块后，库里 S/T/U 的上级、本人业绩与链上一致。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] S 的累计网体奖 = 32.97 USDT（允许与库内 wei 完全一致，不允许四舍五入）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 另做一遍「S 本人累计不到 100」：T 入金 1,000，S 的直推是 0，网体也是 0。S 之后再凑满 100，这笔 1,000 不补。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 页面或库里在 root 发布前就能看到预计金额，但此时用户 `claim` 失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

### 7.3 发布、核对、领取

见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。第一次 `--apply` 会按索引器里的全部累计额从金库付 USDT，不是只付下面这 32.97。

- [ ] 不带 `--apply` 的 `publish:root` 只打印，链上 `merkleRoot` 仍是 0。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 只设 `PRIVATE_KEY`、不设 `PUBLISHER_PRIVATE_KEY`，脚本拒绝发布。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 用不是 `publisher()` 的私钥发布，脚本拒绝。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 发布前看金库 USDT 余额 ≥ 未领直推 + 这一期要新付的网体增量。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] `publish-root.mjs --apply` 成功。交易回执成功，`merkleRoot` 非 0，`committed` 等于申报的累计合计。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 公开明细 JSON 用 `verify-root` 核对通过。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 把明细里某个金额加 1 wei 再核对，失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] S 用库里的累计额和 proof 调用 `CoralRewards.claim`，到账 **32.97 USDT**（若之前已领过则为差额）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 同一 proof 再领失败（`NothingToClaim`）。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 错误 proof、别人的累计额、累计额小于已领，都失败。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 漏一期不补发历史 root：下一期用更高的累计额，一次领到差额。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 再发布一次完全相同的 root，数据库里生效期仍然只有 1 期。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 索引器读到 `TeamClaimed` 后，库里的已领金额等于链上 `claimed(S)`。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

### 7.4 大树（选做，气体和 USDT 都多）

每满 500 USDT 逐张铸 NFT。单笔 60,000 USDT 大约 120 张，气体约数百万，测试网要确认 gas 上限够。

见 [bsc-testnet-manual.md](bsc-testnet-manual.md)。

- [ ] 资格跨档：本人先入金 500，下级再入金时上级拿 3%；本人累计到 2,000 / 10,000 / 30,000 / 60,000 之后，下一笔分别拿 5% / 7% / 9% / 10%。跨档从**下一笔**生效，不追溯刚才那一笔。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 极差：下级档位低于上级时，上级只拿差额。入金者自己的档位不把上级压低。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 平级：D 和 D 的上级都已是 10%。D 拿到极差之后，再上一个 10% 只再拿 D 这笔网体奖的 10%，更上面的 10% 不再抽。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 深链（例如 6 级）入金的 gas 和浅链同一笔金额接近，不会因为层级变深而明显增加。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [ ] 25% 帽：`totalDirectAccrued + 申报的网体累计` 超过 `totalContributed` 的 25% 时，`publishRoot` 失败。领取时若这一笔会把已付额顶过帽，`claim` 失败。不要为了做这个用例去改当前这套的直推比例；放到第 10 节的新部署上，把直推设为 2500 再堆入金。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

## 8. 权限和换奖励合约

- [x] 非 Owner 调用 `pause`、`openSale`、`withdrawTreasury`、`setTokensPerUsdt`、`grantNft` 失败（`OwnableUnauthorizedAccount`）。调用地址是索引 6
- [x] 非 publisher 且非 Owner 不能 `publishRoot`（`NotPublisher`）
- [ ] Owner 自己仍可以 `publishRoot`。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)，和第一次发布放在一起做
- [ ] `setPublisher` 换成地址 P 后，旧地址不能再发，P 可以发。测完改回你要长期使用的 publisher。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [x] 金库 `setRewards` 在已经设置过之后再调用，失败（`RewardsAlreadySet`）
- [x] `setNftInterest` 再调用一次，失败（`InterestAlreadySet`）
- [x] `proposeRewards(新的奖励合约)` 成功，`proposedRewardsEta` 约等于现在 + 1 小时。备用合约 `0xce59d1bc0552aeb057a0e83836ca11f7b3a83c2b`（部署 `0x8973600dc194e3cf0e4a2d3d24fc7079c89ec0c13332eb0fe74f2f88646ff206`），提案 `0x95c0b63e88480c2bc31cc3ea82ebed25c1f1dd2abf96b0b45b4c30a3dc42baa7`，到期时间比当时区块时间晚 3600 秒
- [x] 没到点 `acceptRewards` 失败（`RewardsDelayPending`）
- [x] 等待期间 `cancelRewards` 成功，提案清空，原来的奖励合约不变。取消 `0xcf815d22735bddeb645278e7dfa4a23470d99bb436f00225ecb2b81532bd5d26`，`rewards()` 仍是 `0x60997ed167e18f5e5318e44ace586b8a45dd8f88`
- [ ] 再提案一次，等满 1 小时后 `acceptRewards` 成功，`rewards()` 换成新地址。这套地址不要接受。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)
- [x] 没有提案时 `acceptRewards` / `cancelRewards` 失败（`NoProposedRewards`）
- [ ] Owner `transferOwnership` 后，旧 Owner 不能再改参数；新 Owner 调用 `acceptOwnership` 之后才能用。五个合约（金库、奖励、周息、CKEY、NFT）各自转一次。这套地址不转。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

## 9. 当前这套已经做不了的：导入

导入已经冻结，不能在这套地址上重放导入。下面两项用来确认冻结生效。完整导入放到第 10 节。

- [x] `importUsers` / `importReferrers` / `importVolumes` 现在调用都失败（`ImportFrozenError`）
- [x] `freezeImport` 再调用一次失败（`ImportFrozenError`）
- [ ] 未冻结就 `openSale` 的路径，这套已经开过售，无法在这里复现。见 [bsc-testnet-manual.md](bsc-testnet-manual.md) 第 10 节

## 10. 另部署一套之后再测（会破坏规则或已经无法在现网复现）

这一节全部留到新部署。可打勾步骤在 [bsc-testnet-manual.md](bsc-testnet-manual.md)。10 亿枚铸币上限本地 Forge 已覆盖，测试网不铸满。

不要在 `0xc3d3…b3a` 这套上做本节。新部署仍用 `NETWORK=bscTestnet`，部署完核对 chainId 97、MockUSDT、一周 3600 秒、`rewardsDelay` 1 小时。部署后若 Owner 不是广播账户，要自己 `setRewards` 和 `setNftInterest`。

### 10.1 导入、冻结、开售顺序

- [ ] 未冻结时不能 `openSale`
- [ ] `importUsers` 写入地址和邀请码，不铸 CKEY，不铸 NFT，不发直推
- [ ] 数组长度不一致失败
- [ ] 重复导入同一地址失败
- [ ] 导入自己当自己的上级失败
- [ ] 导入成环失败
- [ ] `importVolumes` 只写本人业绩，`importedNfts = 业绩 / 500`，并占用全站 1 万张额度
- [ ] 导入的业绩不进上级伞下，不产生网体奖，也不增加 `totalContributed`（因此不进 25% 帽的分母）
- [ ] 导入之后的新入金才产生直推和网体奖
- [ ] `grantNft` 给未注册地址失败；张数为 0 失败；累计超过 `importedNfts` 失败
- [ ] `grantNft` 成功后 NFT 到账，本人业绩不变。到账当周起才计周息，补发前的周为 0
- [ ] `freezeImport` 后导入失败，然后才能 `openSale`
- [ ] 第一次 `openSale` 写入 `saleOpenedAt`，并让周息合约 `saleOpened = true`
- [ ] 开售前 `pending` 为 0

### 10.2 结束 IDO

- [ ] 先 `closeSale`，新入金停止
- [ ] 再 `endIdo`。`idoEnded = true`。周息算到调用时所在的那一周为止（含这一周），再过几小时也不再增加
- [ ] `endIdo` **不会**把 `saleOpen` 设成 false。若没先关售，结束后仍能入金；所以顺序必须是先关售再结束
- [ ] 第二次 `endIdo` 失败
- [ ] 结束后直推和已经发布的网体奖仍可领
- [ ] 结束后新的一周不再产生周息

### 10.3 上限和帽（专用部署）

- [ ] 直推比例 2500 时，继续入金直到直推累计接近全站 25%。此时再发布一笔会超帽的网体 root，失败；超帽的 `claim` 失败
- [ ] 把周息全站帽调到当前已结算额，再过一周，新利息为 0，少掉的部分不会在调高帽之后补发。帽不能调到 5000 万枚以上
- [ ] 单户帽按「当前张数 × 500 × 最新比例 × accountCapBps」。默认 100% 时，终身周息不会超过这份本金
- [ ] NFT 铸到 10,000 张后继续入金：交易不回滚，只铸满剩余额度，多出来的记 `nftDeferred`，并且这几张**不计周息**
- [ ] `export-deferred-nfts.mjs` 导出的地址和张数与链上 `nftDeferred` 一致
- [ ] CKEY 总供应顶到 10 亿时，继续入金铸币失败。这要铸满 10 亿枚，气体成本极高，可以只在本地 Forge 承认已覆盖，测试网跳过并在这里注明「跳过，本地已测」

### 10.4 早期用户本金

- [ ] 导入用户不自动得到 CKEY
- [ ] Owner 按「导入业绩 × 100」手动铸造后，余额正确，且可以和后来入金铸出的币加在一起
- [ ] 手动铸造的币同样默认不能转，除非白名单

## 11. 和本地结果对照（不用再测功能，只确认没有测错网）

本地 Forge 120 项、JS 21 项、Anvil 全链路已经通过。测试网如果和下面任何一条不一致，以测试网交易回执为准，回来改代码或改清单，不要改口径迁就。

- [x] 测试网一周是 1 小时，不是本地的 30 个区块，也不是主网的北京时间周日 0 点。`weekDuration = 3600`。第 186 周 2026-10-02 10:04:22 开始，第 187 周 11:04:22 开始（UTC+8）
- [x] 测试网换奖励合约要等 1 小时，不是本地 60 秒，也不是主网 24 小时。`rewardsDelay = 3600`。提案到期时间比当时区块晚 3600 秒
- [x] 测试网 USDT 是本次部署的 MockUSDT `0xee7ed7e5b14f4da53aa1fcea1cf7d8dab66d8d89`，不是主网 `0x55d398326f99059fF775485246999027B3197955`
- [x] `closeSale` 只关入金。关售后 `idoEnded` 仍是 false，重新开售后 `saleOpenedAt` 不变
- [ ] 停周息的是 `endIdo`。这套不调用。见 [bsc-testnet-manual.md](bsc-testnet-manual.md) 第 10 节
- [ ] root 发布后立即能领，没有挑战窗，也没有 `activateRoot`。这套还没发布 root。见 [bsc-testnet-manual.md](bsc-testnet-manual.md)

## 12. 记录

| 日期 | 清单编号 | 交易哈希 | 结果 | 备注 |
|------|----------|----------|------|------|
| 2026-10-02 | 3.4–6、7.1 回滚、8 的回滚和提案取消、9 的冻结回滚、11 的只读项 | 见各项 | 通过，参数已改回 | 要等 1 小时、网体奖、换所有权、提光金库、另部署，见 `docs/bsc-testnet-manual.md` |
