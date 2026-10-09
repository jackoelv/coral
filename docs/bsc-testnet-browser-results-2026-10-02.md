# BSC 测试网浏览器测试结果（2026-10-02）

记录时间：2026-10-02T15:32:07+08:00。结论：**浏览器 E2E 阻塞，未完成剩余写交易测试**。没有把 RPC 读取计为浏览器测试通过。

## 范围与证据

依据 `bsc-testnet-manual.md` 和 `bsc-testnet-checklist.md` 当前未勾选项目。仓库分支 `localdev`。未修改原清单勾选状态，未提交 git。

通过只读调试接口核对 Chrome 实际启动参数：

- 可执行程序 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- user-data-dir `/Users/jack/Library/Application Support/Google/Chrome/freedaotest`
- profile-directory `Default`，调试端口 `9223`

## 实际浏览器尝试

| 测试 | 观察 | 判定 |
|---|---|---|
| 测试站 `/auth` | 显示钱包登录、邀请码输入、两个 Binance Wallet 入口及 MetaMask 入口 | 页面入口可见，不能据此认定登录成功 |
| 点击第一个 Binance Wallet 入口 | Input.dispatchMouseEvent 超时；是否完成点击无法确认 | BLOCKED |
| 读取点击后页面 | Runtime.evaluate 超过 3000ms 未返回 | BLOCKED |
| 原生 Chrome 检查钱包弹窗 | ScreenCaptureKit -3811 捕获失败 | BLOCKED |
| 打开周息合约 BscScan readContract 页面 | 导航等待超时，未读取到合约页面结果 | BLOCKED |

没有确认钱包当前账户、钱包 chainId、账户是否解锁或导入完毕。RPC chainId 不代表钱包当前网络。未输入私钥、助记词或密码，未发送交易，未修改合约参数。

## 补充只读链上快照（非浏览器 E2E）

使用现有 `FreeDao/e2e/browser-use/chain.mjs` 的 public client 查询；只读，不使用钱包私钥。两个快照不是同一区块的原子读取。

| 项目 | 本轮读取 |
|---|---|
| RPC chainId | 97 |
| 区块 | 134397874（索引20），134397882（索引19） |
| currentWeek | 191 |
| weekDuration | 3600 秒 |
| totalContributed | 18,700 USDT |
| saleOpen / paused / idoEnded | true / false / false |
| 六个目标合约字节码 | 全部非空 |
| merkleRoot | 全零，尚无已发布 root |
| 索引20 NFT / CKEY / pending | 2 / 100,000 / 5,000 枚 |
| 索引19 NFT / CKEY / pending | 1 / 50,000 / 0 枚 |

索引19跨周 pending 仍为0的**当前只读结果符合预期**，领取及浏览器展示未验证。

手册的第187周1,000枚是当时的目标，现在已到第191周。索引20当前5,000枚，与从第186周至190周共5个结束周、每周1,000枚的计算一致；这是累计结果一致，不能替代第187周现场快照、历史领取事件及版本状态的完整核对。现在若领取，不能仍断言只收到1,000枚。

root为零，因此网体奖有效 proof 领取、重复领取、发布后立即领取和暂停下网体领取仍缺发布前提。未核实当前 DATABASE_URL；手册里的“为空”仅是历史描述。

## 后续执行条件

恢复浏览器点击与观察通道后，先验证钱包当前账户及chainId97，再执行用户路径。保持同一个freedaotest档案。先按当前周数调整预期，不覆盖历史记录。

现有部署不得执行 endIdo、acceptRewards、所有权转移、提光金库、压低单户帽或将全站帽压到已结算额。相关用例要另部署。

逐项剩余清单见 `bsc-testnet-browser-remaining-2026-10-02.md`。

## 原始只读结果

### 索引20

```json
{
  "chainId": 97,
  "block": "134397874",
  "code": {
    "usdt": true,
    "token": true,
    "nft": true,
    "ido": true,
    "rewards": true,
    "interest": true
  },
  "saleOpen": true,
  "paused": false,
  "idoEnded": false,
  "currentWeek": "191",
  "totalContributed": "18700000000000000000000",
  "weekDuration": "3600",
  "merkleRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "address": "0x5fb9fa20B90B4542a91487cd93817e7Fe78c87Bc",
  "bnb": "952418900000000",
  "usdt": "100000000000000000000000",
  "token": "100000000000000000000000",
  "nft": "2",
  "account": [
    "0x0000000000000000000000000000000000000000",
    "0x5431303032573230000000000000000000000000000000000000000000000000",
    "1000000000000000000000",
    "0",
    "0",
    true
  ],
  "directPending": "0",
  "interestPending": "5000000000000000000000"
}
```

### 索引19

```json
{
  "chainId": 97,
  "block": "134397882",
  "code": {
    "usdt": true,
    "token": true,
    "nft": true,
    "ido": true,
    "rewards": true,
    "interest": true
  },
  "saleOpen": true,
  "paused": false,
  "idoEnded": false,
  "currentWeek": "191",
  "totalContributed": "18700000000000000000000",
  "weekDuration": "3600",
  "merkleRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "address": "0x865616feF95FBeBd8c87ce70fFF1D3eCFD0072aE",
  "bnb": "1888058500000000",
  "usdt": "100000000000000000000000",
  "token": "50000000000000000000000",
  "nft": "1",
  "account": [
    "0xC0a5A322f3285d9DfAdd588d3d9be0ea90cc3969",
    "0x54313030314e3139000000000000000000000000000000000000000000000000",
    "500000000000000000000",
    "0",
    "0",
    true
  ],
  "directPending": "0",
  "interestPending": "0"
}
```
