package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 链上策略金库登记，绑定计价和份额 Mint，并可接入一个借贷市场。
 * Registry of on-chain strategy vaults, with quote and share mints and an optional lending market.
 *
 * <p>复合主键 / Composite primary key: {@code (network, vault_address)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param vaultAddress 链上金库状态账户地址。
 *        On-chain vault state account address.
 * @param programId 拥有该金库状态账户的金库程序 ID。
 *        Vault program ID that owns this vault state account.
 * @param quoteMint 用于存入、赎回和净值计价的 Mint。
 *        Mint used for deposits, redemptions and NAV valuation.
 * @param shareMint 代表对该金库权益的份额 Mint。
 *        Mint representing shares in this vault.
 * @param strategyMint 首个策略资产的 Mint。未配置策略时为空。
 *        Mint of the initial strategy asset. Null when a strategy asset is unconfigured.
 * @param lendingMarketAddress 链上配置的出借市场地址。未配置时为空。
 *        On-chain address of the configured lending market. Null when unconfigured.
 */
@TableName("vault")
public record VaultDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "vault_address", updateStrategy = FieldStrategy.NEVER) String vaultAddress,
        @TableField("program_id") String programId,
        @TableField("quote_mint") String quoteMint,
        @TableField("share_mint") String shareMint,
        @TableField("strategy_mint") String strategyMint,
        @TableField("lending_market_address") String lendingMarketAddress
) {
}
