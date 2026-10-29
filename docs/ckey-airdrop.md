# CKEY 空投操作

CSV 放在 `coral/activity/`。此目录已被 `.gitignore` 排除；不要强制添加到 git。文件名（去掉 `.csv`）就是活动名称，同名活动稳定映射到同一个活动编号。表格是两列：

```csv
address,amount
0x1111111111111111111111111111111111111111,100
0x2222222222222222222222222222222222222222,100.5
```

金额是 CKEY 枚数，最多 18 位小数。`100` = 100 CKEY = `100000000000000000000` 最小单位。拒绝科学计数法、千分位、负数、零及超出 uint256 的数。旧版“活动,名称 + wei 金额”格式不再接受，禁止把旧 CSV 原样用于新版。

## 上线顺序

1. 审查本次 SQL 和代码；确认 production 目标、现有空投记录、活动映射与正式 CKEY 合约。历史未登记计划先审查，避免误当作新文件。
2. 使用现有 `db-backup:mainnet -- --restore-check` 流程备份并核验恢复。迁移工具检查备份哈希、来源和 24 小时时效。
3. `npm run ckey:airdrop:migrate -- --backup <备份路径>` 仅输出目标和迁移清单；确认后追加 `--apply`，手工输入 `MIGRATE AIRDROP`。该迁移在一个事务内执行 002、003，增加表/字段，不删历史记录。不对生产库使用 Prisma db push。
4. 官网执行 Prisma generate、构建、部署；配置保持原 production 环境，检查地址查询和登录后的空投卡片。
5. 预览实际 CSV，确认签名账户、BSC 56、CKEY 合约、人数、跳过地址、总额和 BNB 预算后，人工在钱包逐笔签名。普通 EOA 支持，智能账户/7702 当前明确拒绝。

## 本批每人 100 枚

```bash
cd /Users/jack/git/github/coral
npm run ckey:batch-transfer -- --csv 'activity/社区互动.csv' --expected-amount 100
```

也可无参数启动，在本地页面选择 CSV 和转出地址。`--csv` 路径模式只读取 `activity/` 内的 `.csv`（解析真实路径，拒绝越界符号链接）。每批最多 300 个有效地址，一地址一交易，需要逐笔签名。超过 300 个地址分批，保持活动文件名相同；同一批预览会显示合并及跳过记录。

默认：同一地址此前获得过本 CKEY 的任何活动空投，都跳过；同一活动永远不能再发。未完成计划必须先恢复，不允许用重复开关绕过。

确实需要在另一个活动再次发放：

```bash
npm run ckey:batch-transfer -- --csv 'activity/另一场活动.csv' --allow-repeat
```

`--allow-repeat` 仅对不同活动的已完成发放放行。预览会醒目标明这一设置。改变文件名但不加开关不能绕过历史防重。同文件内重复地址同金额合并，不同金额报错。`--campaign-code` 可用于明确关联已存在活动编号，但名称、发送者、代币必须一致；历史活动编号必须经审查后关联，不能凭改名假设是新活动。

## 恢复与补登记

确认后生成不可变计划，打印在终端，保存在 gitignored `mainnet-run/plans/`。不要删除，也不要重新上传同一文件代替恢复。

```bash
npm run ckey:batch-transfer -- --resume '<原计划路径>'
npm run ckey:batch-transfer -- --record-only '<原计划路径>'
```

- 每笔成功均核验真实交易、3 次确认、CKEY Transfer 的 from/to/value、区块哈希及时间，再入库。
- 转账失败或 RPC 超时不计入到账；数据库断线后停止继续签名。成功但未登记只补登记，不能重新发币。签名页的“重新核验 / 补登记”按钮只核对原交易，不请求新签名。
- `--resume` 对已有哈希逐笔核实。确认链上 reverted 后保存失败尝试并重新准备该行；链上未明确失败不更换 nonce。
- 已请求签名但未返回哈希：nonce 被使用时禁止重签。在本地签名页填写原交易哈希。nonce 未变化时使用原 nonce 和相同交易内容，不能改成新 nonce。
- 旧版计划仅允许 `--record-only`，且对应活动必须已存在；尚未登记的旧活动须人工审查后迁移，不能自动当作新活动执行。
- 不要用通用 `sign:mainnet` 绕过空投执行器；该入口已拒绝空投计划。
- 本地文件并非到账证据，数据库入库始终重新读链；不再用发送者余额差作为入库条件。

## 官网数据含义

空投表只放已到账记录，待签计划独立存储。公开 API 必须提供完整地址，返回该地址累计 CKEY，不提供全体名单、交易明细或人数。故障返回不可用，不伪装成零。登录后的累计空投按会话账户取数，不等于当前持仓，也不增加 USDT 投入、邀请奖励、身份或 NFT 数量。

## 本地验证

`node --test scripts/lib/ckey-batch.test.mjs scripts/lib/sign-server.test.mjs scripts/lib/sign-wallet.test.mjs`

`node scripts/test-ckey-airdrop-local.mjs` 只连接 `127.0.0.1:55438/ckey_test` 和 `127.0.0.1:18548` 的独立 Anvil（56），不读 `.env`。需先创建临时 Postgres、启动 Anvil，且存在 `out/CoralToken.sol/CoralToken.json`。该测试会重建测试库的四张空投表，禁止把端点改为真实数据库或链。


## 2026-10-16 本地验收结果

- 16 项 CSV、签名和恢复测试通过；网站 3 项地址/隐私/多语言测试通过。
- 独立 Anvil 上部署 CoralToken 并执行 4 笔成功转账及 1 笔回滚交易，本地 PostgreSQL 逐笔核验登记。覆盖并发锁、不可变计划、默认防重复、跨活动开关、部分成功、数据库失败后补登记及 18 位金额精度。
- FreeDao TypeScript、修改文件 ESLint 和隔离生产构建通过。构建出现抽奖 fair-draw 导出警告，未修改抽奖模块，发布前需留意该既有模块的构建告警。
- 本地 HTTP 验证：空地址/分页枚举/非法地址均 400，未登录 Dashboard 401，查询仅返回该地址累计值，传入其他地址不能改变当前会话的 Dashboard 数据，超频 429。
- Chrome 实际走完：桌面首页导航、390px 手机菜单、海报、联系方式、五语言、地址查询有效/无效/无记录/数据故障，以及测试会话 Dashboard 的 `100.000000000000000001 CKEY`。
- 截图在 `/Users/jack/Documents/Codex/airdrop-review-20261016/`；本地预览 `http://localhost:3108/activity/airdrop` 使用隔离测试数据。
- 未读取真实 CSV、未签真实钱包、未广播主网、未迁移 production、未部署、未 commit/push。所有已有未提交修改保留。

## 领取式空投合约 CkeyAirdrop

和上面的直接转账不同，这个合约让用户在个人中心自己领取。发放要两个人在链上各签一次。

### 角色

- Owner：注资、撤回未分配额度、退回误转入的 CKEY、恢复暂停、设置角色。不能放弃所有权。
- 提交人（`AIRDROP_PROPOSER`，网站 `AIRDROP_EDITOR_WALLETS`）：上传 CSV 后调用 `propose`，只提交名单哈希、条数和合计。
- 审核人（`AIRDROP_REVIEWER_WALLETS`）：调用 `grant` 提交完整名单，必须和提交人的哈希一致；或调用 `reject`。

三者必须是不同地址，合约会拒绝重叠。

### 上线步骤（主网需人工执行）

1. 部署：`CKEY_ADDRESS`、`OWNER`（必须等于 CKEY 的 owner）、`AIRDROP_PROPOSER`、`AIRDROP_REVIEWER`、`DEPLOY_PRIVATE_KEY`，主网另需 `ALLOW_MAINNET=1`。脚本 `script/DeployCkeyAirdrop.s.sol` 只部署，不加白名单、不铸币、不注资。
2. CKEY 仍禁止自由转账时，Owner 把空投合约加入 `transferAllowlist`，否则用户领取会失败。
3. Owner 手里准备好 CKEY，`approve` 空投合约后调用 `fund(amount)`。直接转进合约的 CKEY 不计入可分配额度，只能用 `returnStray` 退回。
4. 网站配置 `NEXT_PUBLIC_CKEY_AIRDROP` 和两份钱包名单。合约管理员用 Owner 钱包登录后，打开 `/admin/airdrop/owner` 注资、暂停、恢复、收回未领取和更换角色。直接转进合约的 CKEY 在同一页退回，不能用来发放。
5. 在 production 库执行 `mainnet/005-ckey-claim-settings.sql`。单个地址单次上限默认 500 CKEY，Owner 在同一管理页修改，不另签链上交易。

### 日常流程

上传 CSV（`address,amount,reason`，100 表示 100 CKEY，每批最多 100 行；地址须为有效的 0x 地址，单个地址单次默认不超过 500 CKEY）→ 草稿传错时，提交人在名单仍是草稿、且链上还没有提案时删除并重新上传 → 提交人在 `/admin/airdrop` 点「提交上链」→ 审核人核对后点「通过并发放」或「驳回」→ 用户在个人中心点「立即领取」。调低上限后，已经上传但超限的草稿不能再提交，需删除后重传。

出问题时，Owner 在 `/admin/airdrop/owner` 暂停；暂停期间同一页仍可收回未领取额度。提交人或审核人也可以直接调用合约的 `pause`，只有 Owner 能恢复。
