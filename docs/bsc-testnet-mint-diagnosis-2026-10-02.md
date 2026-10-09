# 新测试币未到账诊断（2026-10-02）

只读查询 chainId97，区块约134456242。

- index1：`0xc297969E261Cd146F555eBc32255EB8371Ba7FCC`
- 当前金库：`0x97dA5a14F5A9A70Eb195aaE04B32dcf9D956dF8c`
- 金库usdt()与.env一致：`0x9E674AfE8C7c31DB30d4E2B93b524fe4302f0D57`
- 当前测试币 balanceOf(index1)=0，allowance(index1,当前金库)=60,000 USDT。
- 当前测试币 totalSupply=0，说明此代币尚未成功铸造任何测试币。
- 上一批测试币0x899CfB5b518c636B6FC79B5bcE4f76EbbbB007Ca总供应也为0。
- 最早旧币0xee7ed7e5b14f4da53aa1fcea1cf7d8dab66d8d89上，index1余额99,500。

结论：授权成功，但当前代币没有余额，无法入金60,000；dashboard的0与当前链上余额一致。尚未取得用户本次失败交易哈希，未认定具体回执revert类型。

发现铸币脚本原先优先读取终端导出的BSC_TESTNET_USDT，而不是新.env；旧终端残留配置可能把铸币发往旧币。缺少当时铸币日志，尚不能确认那次实际目标地址。

已修复为直接读取.env，检查链97和金库usdt()关联；增加JSON成功回执及每个账户100,000余额增量校验。29项既有JS测试通过，预览命令另行执行。本轮未广播铸币。

接续：npm run mint:test-usdt（核对当前新币），再npm run mint:test-usdt -- --apply；到账后在dashboard同步链上数据，再尝试入金。不要重新部署。
