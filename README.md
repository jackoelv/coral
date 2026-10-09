# coral — ckey IDO（BSC USDT 金库）

金库只做入金、邀请、直推、铸币和导入。网体奖在链下按经典极差实时算进 Postgres，大约每 24 小时更新一次 Merkle root。用户自己提现时，合约才转出这笔网体奖。没有实时垫付。

完整结构见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [FUNCTIONAL-REPORT.md](FUNCTIONAL-REPORT.md)。内部安全审计报告只在本地保存，不放进公开仓库。主网仍需要外部审计，本期不广播主网。

仓库是独立 Foundry 项目。网站整合为后续工作。`CoralIdo.claim()` 只领 **USDT 直推**。网体奖走 `CoralRewards`。

---

## 合约分工

```mermaid
flowchart LR
  User[用户] -->|contribute| Vault[CoralIdo]
  Vault -->|直推即时| User
  Vault -->|mint| Token[CoralToken]
  Vault -->|每500U| NFT[FreeDaoNFT]
  Indexer[链下计算器] -->|每24小时 publishRoot| Rewards[CoralRewards]
  Rewards -->|disburse| Vault
  Vault -->|USDT| User
```

| 合约 | 功能 |
|------|------|
| `CoralIdo` | 邀请、入金、直推 10%、CKEY / NFT、导入、金库抽走。不沿邀请链循环 |
| `CoralRewards` | 累计 Merkle 领取、25% 全局帽、root timelock、押金挑战。不持有奖金 USDT |
| `CoralToken` | `ckey / CKEY`，CAP **10 亿**，默认禁转，Owner 可开转账白名单 |
| `FreeDaoNFT` | 每 **500 USDT** 一枚，禁止转让。早期用户的历史张数由管理员 `grantNft` 补发 |
| `FreeDaoNFTInterest` | IDO 期间按持有张数发 Ckey 周息。2/10/20/60 张对应每周 1% / 2% / 2.5% / 3%。用户自己领取 |

直推 + 已支付网体奖不得超过 `totalContributed` 的 25%（`REWARD_CAP_BPS = 2500`，没有管理员 setter）。

---

## 三套网络参数

`src/network/CoralNetworks.sol`。构造函数要求 `block.chainid` 与参数一致。

| | local `31337` | BSC 测试网 `97` | BSC 主网 `56` |
|--|--|--|--|
| USDT | 部署 MockUSDT | 沿用 `0x9E674AfE8C7c31DB30d4E2B93b524fe4302f0D57` | `0x55d398326f99059fF775485246999027B3197955` |
| root timelock | 60 秒 | 1 小时 | 24 小时 |
| 挑战押金 | 1 USDT | 10 USDT | 100 USDT |
| 周 | 30 个区块 | 1 小时 | 7 天 |

`quote()` 仍是历史周递减公式，**入金不使用**。实发 CKEY 为 `amount * tokensPerUsdt / 1e18`，默认 1U → 100 枚。

---

## 规则

| 项 | 口径 |
|----|------|
| 直推 | 链上即时。推荐人本人累计 ≥ 100U 后，按下级这笔金额的 10% 记给直接推荐人。下级入 50 也是 5。本人不到 100 的，直推是 0，不顺延 |
| 入金 &lt; 100U | 计入本人业绩。已有权益的上级仍按这笔金额拿直推和网体奖。入金者自己要等累计到 100 才开始有权益，不补以前的 |
| 网体奖 | 链下。拿奖人本人累计 ≥ 100U 才计奖。档位仍是本人 + 伞下，用加进伞下之前的业绩；不到 100 的不占档位 |
| 档位 | 500→3%，2k→5%，1 万→7%，3 万→9%，6 万→10% |
| 6 万平级 | 最近一个已有权益的 10% 祖先拿 D 本笔团队奖的 10%（不含直推）。只抽一份，不跳级 |
| 身份 | 探索者 / 大使 ≥100 / 合伙人 ≥1000。共建者需要伞下业绩，只在链下计算器里 |
| NFT | 本人累计满 1000U 才铸。张数是累计业绩 / 500：1000U 为 2 张，1500U 为 3 张。不满 1000 是 0 张 |
| NFT 周息 | 持有 2 / 10 / 20 / 60 张，每周按对应 Ckey 本金的 1% / 2% / 2.5% / 3% 再铸。主网截止为北京时间周日 0 点。关售停止 |

邀请码：1–32 位大写字母或数字，`bytes32` ASCII 左对齐。已有下级的地址不能再绑上级。

导入只写地址、邀请码和入金，不发直推、不发网体奖、不铸 Ckey、不铸 NFT。早期用户的 Ckey 本金由管理员手动铸，NFT 用 `grantNft` 补发；补发到账后的周息自动计算。网体奖只从导入之后的新入金，用 `scripts/lib/team-reward.mjs` 计算。

---

## 领奖

1. 用户 `claim()` 领直推，随时可领。
2. 运营用链下计算器产出叶子 `(地址, 累计网体奖)`，调用 `submitRoot(root, contentHash, 累计合计)`。
3. 挑战窗内任何人可押 USDT `challenge()`。Owner 可 `cancelPending()`（退押金）或 `dismissChallenge()`（押金给 Owner）。
4. 窗过且无人挑战后 `activateRoot()`。用户 `claim(cumulative, proof)` 只领累计额里还没拿到的增量。合约在这一笔提现里才记账、才转 USDT。

---

## 命令

```bash
bash scripts/install-deps.sh
forge build
forge test
npm install
npm run test:js

# 实时业绩进 Postgres；每天提交 root。缺 DATABASE_URL 时只打印说明。
DATABASE_URL=postgres://... IDO_ADDRESS=0x... RPC_URL=... npm run index:rewards
DATABASE_URL=postgres://... CHAIN_ID=31337 npm run publish:root

anvil --chain-id 31337
bash scripts/local-up.sh
node scripts/scale-anvil.mjs
```

`NETWORK=local|bscTestnet|bscMainnet`。主网脚本在没有 `ALLOW_MAINNET=true` 时拒绝广播。本期不要设这个变量。

```bash
# 测试网：没有下面两个变量时不会广播
NETWORK=bscTestnet BSC_TESTNET_RPC=... TEST_PRIVATE_KEY=0x... bash scripts/scale-network.sh

# 主网只准备脚本，不广播
NETWORK=bscMainnet forge script script/Deploy.s.sol:Deploy --sig "run()"
```

若 `OWNER` 不是广播账户，部署后由 Owner 自己调用 `CoralIdo.setRewards`。

---

## 历史导入

`--network bscMainnet` 使用库里的真实钱包。`local` 和 `bscTestnet` 按用户 id 派生模拟地址，树和业绩不变，并写出地址对照表。

```bash
DATABASE_URL=postgres://... node scripts/export-freedao.mjs --network bscMainnet --out import-data.json
node scripts/export-freedao.mjs --in scripts/fixtures/sample-users.json --network local --out import-data.json

IDO_ADDRESS=0x... RPC_URL=http://127.0.0.1:8545 LOCAL_PRIVATE_KEY=0x... \
  node scripts/import-onchain.mjs --in import-data.json
IDO_ADDRESS=0x... RPC_URL=... TEST_PRIVATE_KEY=0x... \
  node scripts/import-onchain.mjs --in import-data.json --apply --freeze
```

---

## 安全

内部审计报告和复现测试只在本地保存，不放进公开仓库。真实数据库端到端测试：`npm run e2e:postgres`。功能说明：[FUNCTIONAL-REPORT.md](FUNCTIONAL-REPORT.md)。主网部署前需要外部审计。

历史第一期笔记在本地知识库 `source/notes/nemoido-mainnet-2026-10-06/SECURITY.md`（口径已过时）。

---

## 本地账户（Anvil 默认助记词，禁止用于主网）

`test test test test test test test test test test test junk`

| 账户 | 地址 |
|------|------|
| #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |

根邀请码：`ROOTANVL`。

---

## Git 作者

本仓库提交身份固定为 **`freedaocrypto <jackoelv@freedao.life>`**（[`.gitconfig`](.gitconfig)）。克隆后执行一次：

```bash
bash scripts/setup-git-author.sh
```
