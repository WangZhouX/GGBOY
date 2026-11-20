package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 链上借贷市场登记，一个市场绑定一种借款资产和一种抵押资产。
 * Registry of on-chain lending markets, each with one debt asset and one collateral asset.
 *
 * <p>复合主键 / Composite primary key: {@code (network, market_address)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param marketAddress 链上借贷市场状态账户地址。
 *        On-chain lending market state account address.
 * @param programId 拥有该市场状态账户的借贷程序 ID。
 *        Lending program ID that owns this market state account.
 * @param debtMint 借贷池供给、借款和还款使用的 Mint。
 *        Mint used for supply, borrowing and repayments in the market.
 * @param collateralMint 该市场支持的抵押资产 Mint。
 *        Collateral asset mint accepted by this market.
 */
@TableName("lending_market")
public record LendingMarketDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "market_address", updateStrategy = FieldStrategy.NEVER) String marketAddress,
        @TableField("program_id") String programId,
        @TableField("debt_mint") String debtMint,
        @TableField("collateral_mint") String collateralMint
) {
}
