# Coral 迁移与主网部署准备（2026-10-09）

## 本次边界

源：nemoido localdev de0edf9；原目录不修改。目标：现有 coral main，保留 jackoelv/coral 的 origin 和初始提交历史；源仓库历史完整保存在忽略目录 legacy-nemo-local/source-history.bundle。旧 .env、主网记录、历史导入与账本在 legacy-nemo-local/，不用于新部署、不纳入 Git。原目标 README/LICENSE/.gitignore 已在本次工作目录备份。

用户确认：项目 Coral / 珊瑚；凭证 ERC20 name=Ckey、symbol=CKEY；NFT name=FreeDaoRWA、symbol=FREEDAONFT。源码类型为 CoralToken、FreeDaoNFT、CoralIdo、CoralRewards、FreeDaoNFTInterest。CORAL 是项目/未来生态代币称呼，本次部署的 ERC20 是 CKEY，不额外部署一个 CORAL 币。

一期资产：帕劳雷迪森酒店两栋独栋别墅、十间海景客房的十年经营权，不涉及房地产所有权。现有四级身份、门槛、份额、33 席、奖励和发行机制保持各分支原样。33 席与一期客房分配关系须在后续交付安排中明确，未擅自改经济规则。英文未猜测酒店的官方英文名，暂保留用户提供的中文专名。旧建筑图换成现有生活方式图，旧吉祥物换成 FREEDAO 标识；正式新酒店照片待提供。

## 兼容性

保留 ABI 方法 nemo()/totalNemoAllocated()、事件 NemoAllocated/UnsoldNemoWithdrawn、错误 InsufficientNemo 及现有存储成员；合约类型名与编译产物路径改 Coral。函数选择器、事件/错误签名及存储布局不因改名改变。不是代理升级，五个核心合约重新部署，旧地址的余额、持仓、领取记录和权限不会自动迁移。

部署工具 token 配置键 BSC_MAINNET_NEMOKEY -> BSC_MAINNET_CKEY；测试网对应 token 键与 mint:ckey 同步改名。网站依靠 IDO.nemo() 读取凭证地址。现有 NEMO_* 环境变量、nemo_* 数据库表、API 路径、JSON 字段和本地工具标识保留兼容，不作为用户展示名称。索引必须按 chain_id + 新 IDO 地址建立独立范围，不复制旧检查点或 proof。

历史审计、测试报告属于旧项目证据，不能作为新 Coral 主网上线批准。数据库 schema 从指定知识库复制进 mainnet/，消除脚本对外部绝对 SQL 路径的依赖；没有运行数据库迁移。

## 新主网配置

真实文件 coral/.env.mainnet，权限 600；不是 .env.mainet。新建独立部署账户，不复用旧部署密钥。沿用已核实的 RPC、Owner、Publisher、NFT 图片与公开固定参数；数据库、合约地址、起始块等保持未配置，旧数据预算需重新核对。

- 链：BSC 56；USDT：0x55d398326f99059fF775485246999027B3197955，18 decimals。
- 新部署账户：0x32A07133E84C20DaDF57b627b028848A0b736409。
- 最终 Owner 候选：0xD25FFDaB817a1961E7c3224403d54a0182550968。
- Publisher 候选：0x4A42DcC443b08902488d334423EFCB502F434A56。
- 三者互异；部署账户 nonce=0，余额=0（预检时）。
- NFT 图片：https://test.freedao.life/media/nomad/rwa-nft-pass.webp，预检 HTTP 200；仍是测试域名。
- 预检 Gas：12,395,011 gas，0.05 gwei，约 0.00061975055 BNB；建议 0.001240 BNB，实际广播前重查。
- 初期五合约管理员为部署账户；不开售、不冻结导入、不迁移用户、不发布 root。完成旧链快照核对和初始化后，按原流程移交最终 Owner，并由其钱包接受权限。

## 验证

- Foundry 162 passed，0 failed，1 原有 skipped。
- JS 94 passed。
- 7 个合约 ABI（归一化类型标签后）、method selectors、storage layout 与同一源码基线一致。
- 本地 chain31337：部署、授权、两钱包注册入金、直推、NFT/Token、零入金拒绝、周息、Merkle 领取、重复领取拒绝通过。
- 本地模拟 chain56：主网 wrapper 部署、五个回执、关联、Ckey/CKEY、FreeDaoRWA/FREEDAONFT、不开售参数、deployed-stage 验证通过。
- BSC 公网只读预检及 forge 无广播仿真通过；未进行任何公网交易。
- 同版 Slither：旧基线和 Coral 各44项，分类无新增：High 1、Medium 11、Low 25、Informational 7。High 为 versionTiers 未初始化提示；构造函数通过 _writeTiers 写入，单测与模拟已验证档位，但本次不替代独立审计。

## 广播前集中确认

确认上述链上名称、Owner/Publisher、部署账户与签名渠道（仅此本机一次性部署密钥）；确认仅部署五合约及建立关联，保持 saleOpen=false、importFrozen=false。建议先向新部署账户准备0.001240 BNB，并明确最高 Gas 支出上限。部署不可撤销，会花费 BNB。

广播后：逐笔收据、bytecode/关联/名称验证、写回新合约地址与部署起始块、deployed-stage 验收、保存源码 hash/编译产物。未获许可前不 push、不更新 Vercel、不改变旧链。

## 后续迁移关卡

1. 旧链目前 saleOpen=true、importFrozen=true；先确认维护窗口和快照截止块，是否关闭旧链需单独授权。
2. 对所有真实用户逐地址核对本金、邀请、Token/NFT 持仓、已领直推/网体/周息；不得仅复用旧导入文件。
3. 明确新独立数据库或新地址索引隔离方案；完成备份、恢复验收、旧新奖励防重复核对。
4. 审核历史额度、缺口及偿付准备金后再迁移、冻结导入、开售、移交。
5. 最终 Owner 接受五笔权限；真实钱包登录/切链/入金/领取验收仍待执行。所有主网转账/签名需授权。
6. 三个网站分支分开发布，不能互相整支合并。life 保留原生产 Cron，life_dev 保留开发规则，preview 保留主网专用约束。推送 life 会触发生产构建，当前不执行。
