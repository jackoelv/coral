# BSC 测试网从头再部署

旧的金库、CKEY、NFT、奖励、周息地址作废。MockUSDT 沿用已经在测试网上的 `0x9E674AfE8C7c31DB30d4E2B93b524fe4302f0D57`，不再新铸。部署账户是 `.env` 里的 `TEST_PRIVATE_KEY`，它会成为五个新合约的 owner。

不要跑 `scripts/scale-network.sh`。它部署后会自动打几百笔入金。

部署必须用已经带 `setImageURI` 的这份源码。图片地址用固定文件，不用带 `dpl_` 的 `/_next/image`。

不要调用 `endIdo`。

这次部署的 `rewardsDelay` 是 **10 分钟**（`CoralNetworks.bscTestnet()`）。主网仍是 24 小时。这个值在金库构造时写死，部署后改不了。部署脚本会核对链上是 600 秒，不是就拒绝写回 `.env`。

下面每一步都在 `/Users/jack/git/github/coral`。部署脚本会自动更新 `.env`，再按这份 `.env` 清测试库、导入、开售，最后把公开地址上传到 Vercel Preview。无需复制日志里的地址、区块或 publisher 地址。要求 Node.js 22.16+（支持 `util.parseEnv`），Foundry 在 `~/.foundry/bin`。

## 1. 编译

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd /Users/jack/git/github/coral
npm install
forge build
```

## 2. 预览部署

已有 `.env` 必须配置 `BSC_TESTNET_RPC`、`TEST_PRIVATE_KEY`、`BSC_TESTNET_USDT` 和测试数据库连接；脚本不会替你选择数据库或修改连接串。`BSC_TESTNET_USDT` 必须是 `0x9E674AfE8C7c31DB30d4E2B93b524fe4302f0D57`，与 `CoralNetworks.bscTestnet()` 里的地址相同。改 `.env` 不会换成另一份币，合约参数仍用这个地址，两边不一致时写回会被拒绝。`TEST_PRIVATE_KEY` 对应地址需要测试 BNB，并且必须仍是这份 MockUSDT 的 owner。

```bash
npm run deploy:testnet
```

预览核对 RPC chainId 97、部署账户、publisher 是否需要生成，不广播、不改 `.env`。如果配置了不同的 `OWNER`，脚本拒绝本流程，避免后续权限不匹配。

## 3. 部署并自动写回 `.env`

```bash
npm run deploy:testnet -- --apply
```

脚本执行 `Deploy.s.sol:Deploy`，固定 `NETWORK=bscTestnet`。USDT 用合约参数里的现有 MockUSDT，不新铸。NFT 图片先设为 `https://test.freedao.life/media/nomad/rwa-nft-pass.webp`。广播记录里如果出现新的 MockUSDT，脚本拒绝写回。仅在部署成功、本次 broadcast 产物有效、五笔创建回执链上成功、金库 `usdt()` 等于 `.env` 的 `BSC_TESTNET_USDT`、其余关联和五个 Owner 均正确后写回 `.env`：

- 五个新的 `BSC_TESTNET_*` 地址。`BSC_TESTNET_USDT` 保持不动
- `INDEX_START_BLOCK` 和 `START_BLOCK`：五笔创建交易中最早区块，保证不漏初始事件
- `IDO_ADDRESS`、`REWARDS_ADDRESS`：与同批测试网地址一致
- `RPC_URL=BSC_TESTNET_RPC`、`CHAIN_ID=97`、`NETWORK=bscTestnet`、`NFT_IMAGE_URI`
- `PUBLISHER_ADDRESS`：自动从 publisher 私钥推导

已有 `PUBLISHER_PRIVATE_KEY` 保留；为空时自动生成独立私钥并写入 `.env`，不会在终端打印。它必须与部署私钥不同。`DATABASE_URL`、`DATABASE_URL_UNPOOLED`、`TEST_PRIVATE_KEY` 及其他原配置不变。

`.env` 原子替换，权限设为600；原文件备份为 `.env.backup-时间戳`，备份同样600且被git忽略。备份包含秘密，不要上传。

如果广播中途失败，脚本不会覆盖 `.env`。先检查 Foundry broadcast 记录并恢复失败交易，不要直接重复 `--apply` 生成另一套合约。若部署已成功、仅写回失败，可从当前 `broadcast/Deploy.s.sol/97/run-latest.json` 恢复配置：

```bash
npm run deploy:testnet -- --sync
```

`--sync` 不广播，但必须确认 run-latest 就是要恢复的这批部署；它会重新核对回执、Owner和金库关联。

部署写入的是 WebP。若 BSCScan 不显示这张图，等 `https://test.freedao.life/media/nomad/rwa-nft-pass.png` 能公开打开后，再把共享图片改成 PNG。先预览，确认后再发送：

```bash
npm run nft:image
npm run nft:image -- --apply
```

这一步只改已部署 NFT 的 `imageURI`，不重新部署，也不动 USDT 和金库。

## 4. 自动核对配置

部署脚本已核对两套地址和起始区块，可额外只打印公开值：

```bash
node --env-file=.env -e 'console.log({ ido: process.env.BSC_TESTNET_IDO, indexer: process.env.IDO_ADDRESS, start: process.env.START_BLOCK, indexStart: process.env.INDEX_START_BLOCK })'
```

`DATABASE_URL` 必须仍是测试库 `ep-empty-king`。正式库主机名含 `ep-autumn-cake`，清库脚本会拒绝。部署脚本不改数据库连接。

## 5. 清空测试库里和链对不上的记录

脚本先打印完整数据库连接。主机名必须包含 `ep-empty-king`。正式库主机名含 `ep-autumn-cake`，或其他主机，都会拒绝。不改链上数据。

会清空：

- 网站账号和邀请关系：`nomad_users`，以及订单、提现、直推记录、余额快照、活动邀请和积分等挂在这些账号上的表
- 链 97 上所有金库的 `nemo_team_proof`、`nemo_team_root`、`nemo_team_account`、`nemo_indexer_state`、`nemo_invite_cache`，不限当前金库地址

留下 `nemo_interest_boundary`、活动任务和奖品配置、旧站 `User` / `Order`。

先看连接和行数。输出里的 `host` 必须是测试库，`database` 必须是 `neondb`：

```bash
npm run reset:testnet-db
```

确认连接无误后再删除：

```bash
npm run reset:testnet-db -- --apply
```

这一步必须在导入之前。导入脚本也读 `.env` 里的新地址；地址还是旧的就会写进旧金库。

## 6. 导入前面那 30 个地址

来源是 FreeDao 生产库，经 `scripts/import-prod-to-testnet.mjs` 导出再上链。只写邀请码、上级和本人业绩，不铸 CKEY、不铸 NFT、不发直推。各地址本人业绩会加总记入 `totalImported`。这次历史入金是 4900 USDT，奖励上限按它的 25% 算，是 1225 USDT。这笔不代表金库里有 4900 USDT。索引扫到这笔导入时，会把本人业绩加进所有上级的伞下，但不发网体奖。历史网体奖按确认入金的先后另算，见第 12 节。不满 1000 USDT 不占 NFT 额度。满 1000 USDT 按累计业绩除以 500 占用额度，仍然不铸造。

`docs/bsc-testnet-deposits.csv` 是旧合约上的测试入金，不要导入。导入这一步仍不铸 CKEY、不铸 NFT、不发直推。开售之后用 `npm run settle:imported` 按规则补发，见第 9 节。

```bash
npm run import:testnet
```

预览里 `records` 必须是 30，并且和 `docs/bsc-testnet-imports.csv` 对得上，再执行：

```bash
npm run import:testnet -- --apply
```

## 7. 自动设置独立 publisher

无需手填地址，脚本直接读取 `.env` 两把私钥和奖励合约地址，核对 chainId、Owner及两套奖励地址一致。先预览，再执行；已设置正确时不重复发送交易。

```bash
npm run publisher:testnet
npm run publisher:testnet -- --apply
```

执行后核对链上 `publisher()` 等于 `.env` 中私钥推导地址，并同步 `PUBLISHER_ADDRESS`。

## 8. 冻结并开售

导入成功之后再跑。这一步会 `freezeImport`，然后 `openSale`。

```bash
npm run import:testnet -- --open
```

核对 `importFrozen() == true`，`saleOpen() == true`。

## 9. 按规则补发历史 CKEY、NFT，并结算周息

开售完成后再跑。只处理 `import-data.json` 里已经导入的地址，金额以链上本人业绩为准。

| 补发 | 规则 |
|------|------|
| CKEY | 本人业绩 × 每 USDT 100 枚，减去该地址已经持有的数量。由币的控制人铸造，不从客户钱包拉 USDT，不记直推和网体，不计入金库的入金铸币合计 |
| NFT | 业绩满 1000 USDT 起，每 500 USDT 一张，只补导入时占下、还没补发的张数。1000 USDT 是 2 张，1500 USDT 是 3 张 |
| 周息 | 按每笔已确认入金的时间，把开售之前已经结束的北京时间自然周直接铸成 CKEY。张数随业绩增加：满 1000 USDT 是 2 张、每周按本金 1%，之后每满 500 USDT 加一张，加张之前的周不按新张数重算。单人不超过这些 NFT 本金的 100%，全体不超过 5000 万枚。开售当周及之后不在这里补，由周息合约按补发后的 NFT 计算。没有 NFT 的地址是 0 |
| 直推 | 不补。过去的直推已经手动发过一部分，还没发的以后继续手动发。不要写进这个脚本，否则会和已经发出的重复 |
| 网体 | 不在这一步发奖。索引会把导入的本人业绩计入上级伞下。历史网体奖在第 12 节清算后放进默克尔 root |

先预览。每个有 NFT 的地址会打印以前的确认时间、今天、过去的周数、应该补的周息和实际补的周息。实际数小于应该补的数时，是碰到了单人或总上限。确认后再执行：

```bash
npm run settle:imported
npm run settle:imported -- --apply
```

重复执行会跳过已经补过的 CKEY、NFT 和周息。周息的已补金额写在 `import-interest-backfill.json`，不要删。控制人必须仍是 `.env` 里的 `TEST_PRIVATE_KEY`。交给多签之后不要再跑这一步。导入文件里如果还没有每笔确认时间，脚本会从来源库补读。

主网沿用同一脚本，等主网地址写进 `.env` 之后：

```bash
npm run settle:imported -- --network mainnet
npm run settle:imported -- --network mainnet --apply
```

主网读 `BSC_MAINNET_RPC`、`BSC_MAINNET_IDO`、`BSC_MAINNET_CKEY` 和 `MAINNET_PRIVATE_KEY`。同样要在开售之后、交给多签之前。

## 10. 给测试钱包补铸现有 MockUSDT

币仍是 `0x9E674AfE8C7c31DB30d4E2B93b524fe4302f0D57`。钱包里已经有的余额留在这份合约上。脚本读取 `/Users/jack/Documents/Sensitive/nemo-bsc-testnet-wallets.json` 里的地址，不使用里面的私钥。每个地址再铸 100,000 USDT。Gas 由 `.env` 的 `TEST_PRIVATE_KEY` 支付，收款地址自己不用出 gas。部署账户必须仍是这份 MockUSDT 的 owner。

先打印地址：

```bash
npm run mint:test-usdt
```

脚本固定优先读取仓库 `.env`，忽略终端残留的合约地址和部署私钥，并核对当前金库 `usdt()`。数量和 `BSC_TESTNET_USDT` 对得上后再铸造：

```bash
npm run mint:test-usdt -- --apply
```

每笔铸币会核对成功回执、目标代币及余额增加100,000；最后输出每个账户余额。若核对中途失败，先检查已成功地址，不要盲目整批重跑。这些地址以后自己入金时，钱包里还要有测试网 BNB。

## 11. 把公开地址上传到 Vercel Preview

只写 Preview。不上传私钥、数据库连接串、`CRON_SECRET`，也不改 Production。脚本从 `.env` 的 `BSC_TESTNET_*` 生成这些值：

- `NEXT_PUBLIC_CHAIN_NETWORK=testnet`
- `NEXT_PUBLIC_NEMO_NETWORK=bscTestnet`
- `NEXT_PUBLIC_BSC_TESTNET_USDT`、`NEXT_PUBLIC_BSC_TESTNET_IDO`、`NEXT_PUBLIC_BSC_TESTNET_REWARDS`、`NEXT_PUBLIC_BSC_TESTNET_INTEREST`、`NEXT_PUBLIC_BSC_TESTNET_NFT`
- `INDEX_START_BLOCK`
- `NEMO_RPC_URL`

先打印将要写入的值：

```bash
npm run vercel:testnet-preview
```

地址和起始区块与第 4 步一致后再上传：

```bash
npm run vercel:testnet-preview -- --apply
```

`NEXT_PUBLIC_` 是构建时写进前端的。上传之后还要重新部署 Preview，已上线的页面才会换合约。放在开售之后，避免页面先指向还不能入金的金库。

Preview 上的 `DATABASE_URL` 必须仍是测试库 `ep-empty-king`。这个脚本不改它。

本地 Next 还要改 FreeDao `.env.local` 里同一组 `NEXT_PUBLIC_BSC_TESTNET_*` 和 `INDEX_START_BLOCK`。不改的话，本机页面仍连旧金库。

网体索引不要挂在 Preview 上。Vercel 定时任务只对 Production 生效。主网上线时再把 `GET /api/cron/index-rewards` 写进 `vercel.json`，频率用每小时。

## 12. 本地索引，再用币安钱包测

登录地址必须等于钱包当前账户。开售后用现有 MockUSDT 入金。历史地址的 CKEY、NFT 和开售前的周息要等第 9 节补发之后才出现。历史直推不补：已经手动发过一部分，没发的以后手动发。USDT 余额仍在原来那份币上。

入金后按这个口径核对，不要用旧规则：

- 推荐人本人累计满 100 USDT（含导入）才有直推和网体奖。下级入 50 USDT，直推是 5。本人不到 100 的，这两项都是 0，直推不顺延。凑满 100 不补以前的下级入金。
- NFT 要本人累计满 1000 USDT 才有。1000 USDT 是 2 张，1500 USDT 是 3 张。只入 500 USDT 可以有网体 3% 资格，NFT 是 0，因此没有周息。
- 最低入金仍是 1 USDT。不再要求下级这一笔必须满 100 USDT。

网体业绩在本地跑，从 `START_BLOCK` 往后扫当前 `IDO_ADDRESS`。导入业绩会计入上级伞下，历史网体奖要再跑一次清算：

```bash
CHUNK_BLOCKS=50000 npm run index:rewards
npm run settle:historical-team
npm run settle:historical-team -- --apply
```

清算按每笔已确认入金的时间顺序重算差额。直推不进这张表。奖励上限包含导入的历史入金：4900 USDT 的 25% 是 1225 USDT，够覆盖这次 159 USDT 的历史网体奖。领取前仍要把这 159 USDT 打进金库。当前已部署的金库还没有 `totalImported`，要重新部署并导入后，发布脚本才会按这个上限放行。

页面上的「待结算」要等这次索引写完才有数。领取还要另一次发布。npm 命令自动读取仓库 `.env`，配置优先于终端遗留值。发布子进程只保留 `PUBLISHER_PRIVATE_KEY`，自动移除其他私钥，不用另开终端或source：

```bash
npm run publish:root
npm run publish:root -- --apply
```

第一次 `--apply` 会把库里累计的网体奖一次付清，不是只付最新一笔。金库里的 USDT 要够付未领直推加上这次新增的网体奖。

## 顺序执行速查

以下广播、清库和上传命令由你在终端执行；预览输出不对时不要执行紧随其后的 `--apply`。

```bash
cd /Users/jack/git/github/coral
export PATH="$HOME/.foundry/bin:$PATH"
npm install
forge build
npm run deploy:testnet
npm run deploy:testnet -- --apply
npm run reset:testnet-db
npm run reset:testnet-db -- --apply
npm run import:testnet
npm run import:testnet -- --apply
npm run publisher:testnet
npm run publisher:testnet -- --apply
npm run import:testnet -- --open
npm run settle:imported
npm run settle:imported -- --apply
npm run mint:test-usdt
npm run mint:test-usdt -- --apply
npm run vercel:testnet-preview
npm run vercel:testnet-preview -- --apply
```

随后重新部署 FreeDao 的 Vercel Preview，让公开配置进入新构建。部署目标域名及本地 FreeDao `.env.local` 是另一个项目的配置，不由本次 nemoido 部署脚本自动覆盖。完成测试入金后：

```bash
CHUNK_BLOCKS=50000 npm run index:rewards
npm run settle:historical-team
npm run settle:historical-team -- --apply
npm run publish:root
npm run publish:root -- --apply
```

root明细核对请使用 `npm run verify:root -- <发布输出的明细文件>`。导入预览必须确认30条符合当前生产库；数量变化时不要盲目套用历史30条。全程不调用 `scale-network.sh` 或 `endIdo`。

## 13. 多签接管，再换奖励合约

先完成上面的开售，并用非多签地址做一轮入金、索引、发布，至少领一笔网体奖。记下该地址的 `claimed` 和当时的 `totalTeamPaid`。

多签用钱包文件 index 17、18、19、20。任意 3 个签名立即生效。下面默认用 17、18、19 签名，gas 由 `TEST_PRIVATE_KEY` 支付。先预览，再加 `--apply`。

```bash
forge build
npm run multisig:testnet -- deploy
npm run multisig:testnet -- deploy --apply
npm run multisig:testnet -- transfer
npm run multisig:testnet -- transfer --apply
npm run multisig:testnet -- accept
npm run multisig:testnet -- accept --apply
npm run multisig:testnet -- exec --apply
npm run multisig:testnet -- replace --apply
```

`transfer` 只是发起。`accept` 之后五个合约的 `owner()` 才等于 `TESTNET_MULTISIG`。`exec` 把金库的最低推荐额设成当前值，只验证权限。`replace` 把 index 20 换成 index 16，再换回来。换回后签名人仍是 17、18、19、20。

然后部署下一份奖励合约。档位不在合约里：切换区块之前仍是 500 / 2,000 / 10,000 / 30,000 / 60,000 USDT 对应 3% / 5% / 7% / 9% / 10%；从接受交易所在区块起，新入金改为 1,000 / 10,000 / 80,000 USDT 对应 3% / 5% / 10%。新合约会种入旧的已领金额，避免同一笔奖领两次。

```bash
npm run rewards:migrate -- deploy
npm run rewards:migrate -- deploy --apply
npm run rewards:migrate -- propose
npm run rewards:migrate -- propose --apply
```

提议后等 `proposedRewardsEta`。测试网是 10 分钟。到点再接受。不要清索引库，也不要改 `START_BLOCK`。

```bash
npm run rewards:migrate -- accept
npm run rewards:migrate -- accept --apply
```

接受成功后 `.env` 的 `BSC_TESTNET_REWARDS`、`REWARDS_ADDRESS` 改为新地址，并写入 `TEAM_TIER_SWITCH_BLOCK`。再用非多签地址入金，然后：

```bash
CHUNK_BLOCKS=50000 npm run index:rewards
npm run publish:root
npm run publish:root -- --apply
npm run verify:root -- <发布输出的明细文件>
```

核对：

- 第一轮领过的地址，用旧累计额再领，合约拒绝。
- 切换之后的新入金按新三档计算，第一轮的网体奖数额不变。
- 直推仍在金库上，不受这次更换影响。


## 2026-10-06 主网上线指引

本文的reset、MockUSDT铸币、测试钱包映射和Preview上传不能照搬主网。主网准备、生产全量备份/恢复、参数复核以及life合并关卡见本地知识库 `source/notes/nemoido-mainnet-2026-10-06/mainnet/launch-checklist-2026-10-06.md`。本次没有广播主网或推送life。
