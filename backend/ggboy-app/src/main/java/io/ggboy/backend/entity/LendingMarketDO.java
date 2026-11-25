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
 * @param oracleAddress 市场配置的价格源账户地址，未配置时为空。
 *        Configured price feed account address, null when unconfigured.
 * @param oracleMaxAgeSeconds 报价允许的最大年龄（秒），未配置时为空。
 *        Maximum acceptable price age in seconds, null when unconfigured.
 */
@TableName("lending_market")
public record LendingMarketDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "market_address", updateStrategy = FieldStrategy.NEVER) String marketAddress,
        @TableField("program_id") String programId,
        @TableField("debt_mint") String debtMint,
        @TableField("collateral_mint") String collateralMint,
        @TableField("oracle_address") String oracleAddress,
        @TableField("oracle_max_age_seconds") Integer oracleMaxAgeSeconds
) {

    /**
     * 提供 Lambda 查询使用的网络属性访问器，对应 network 列。
     * Exposes the network property for lambda queries against the network column.
     *
     * @return 网络的小写协议值。 Lowercase network wire identifier.
     */
    public String getNetwork() {
        return network;
    }

    /**
     * 提供 Lambda 查询使用的市场地址访问器，对应 market_address 列。
     * Exposes the market address property for lambda queries against the market_address column.
     *
     * @return 借贷市场状态账户公钥。 Public key of the lending market state account.
     */
    public String getMarketAddress() {
        return marketAddress;
    }

    /**
     * 提供 Lambda 更新使用的价格源公钥访问器，对应 oracle_address 列。
     * Exposes the price feed public key for Lambda updates of the oracle_address column.
     *
     * @return 市场登记的价格源公钥，未登记时为空。 Registered price feed public key, or null before setup.
     */
    public String getOracleAddress() {
        return oracleAddress;
    }

    /**
     * 提供 Lambda 更新使用的价格有效期访问器，对应 oracle_max_age_seconds 列。
     * Exposes the maximum price age for Lambda updates of the oracle_max_age_seconds column.
     *
     * @return 价格有效期，单位为秒，未登记时为空。 Maximum price age in seconds, or null before setup.
     */
    public Integer getOracleMaxAgeSeconds() {
        return oracleMaxAgeSeconds;
    }
}
