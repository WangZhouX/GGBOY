# 策略金库 Solana 客户端

[devnetVault.ts](devnetVault.ts) 保存 GGBOY Devnet 金库的公开部署配置。程序 ID 和账户标识使用 [金库 IDL](ggboyVaultIdl.json)，mockUSDC Mint 来自 [部署记录](../../../../onchain/README.md#已确认的部署与初始化)。金库状态、现金托管和 GG-V Mint 地址按链上种子派生。读取时校验金库的账户归属、地址绑定、代币 Mint 和精度。

页面可读取同一个已确认 slot 的金库现金、份额供给和指定钱包的币量。可存 mockUSDC 来自钱包的规范关联代币账户，GG-V 汇总钱包名下全部同 Mint 账户。所有数量使用代币最小单位和 bigint。存入或赎回确认后可携带确认 slot 作为下一次读取的下限。

[depositVault.ts](depositVault.ts) 按公开 IDL 构造并模拟存入指令，将首次创建份额关联账户与存款合在同一笔交易。钱包签名后按交易签名查询确认结果，并用 blockhash 的最后有效块高识别过期。

[redeemVault.ts](redeemVault.ts) 构造原子的份额归集、销毁和现金返还交易，按需创建钱包 mockUSDC 的关联收款账户。存赎共用 [vaultTransaction.ts](vaultTransaction.ts) 的模拟和确认逻辑。回到页面可按原签名继续核对状态。

本目录包含 Solana 客户端代码。页面与交互位于 [策略金库](../../pages/vault/README.md)，历史查询通过 [金库 API](../../features/vault/api/README.md)。
