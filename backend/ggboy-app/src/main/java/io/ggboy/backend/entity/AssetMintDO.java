package io.ggboy.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * GGBOY 使用的 Mint 登记，用于金库、市场和仓位展示。
 * Mint registry for the assets and shares used by GGBOY vaults, markets and positions.
 *
 * <p>复合主键 / Composite primary key: {@code (network, mint_address)}.
 *
 * @param network Solana 网络，限 localnet 和 devnet。
 *        Solana network, either localnet or devnet.
 * @param mintAddress 对应 SPL Token 的链上 Mint 地址。
 *        On-chain SPL token mint address.
 * @param symbol 可用的展示简称，尚未配置时为空。
 *        Display ticker, if configured.
 * @param decimals 该 Mint 的小数位数，用于展示最小单位金额。
 *        Decimal precision of the mint, used to display base-unit amounts.
 * @param programId 该 Mint 账户的代币程序 ID。
 *        Token program ID that owns this mint account.
 */
@TableName("asset_mint")
public record AssetMintDO(
        @TableField(value = "network", updateStrategy = FieldStrategy.NEVER) String network,
        @TableField(value = "mint_address", updateStrategy = FieldStrategy.NEVER) String mintAddress,
        @TableField("symbol") String symbol,
        @TableField("decimals") short decimals,
        @TableField("program_id") String programId
) {

    /**
     * 以 MyBatis-Plus Lambda 查询可识别的属性名读取网络标识。
     * Exposes the network identifier as a property for MyBatis-Plus lambda queries.
     *
     * @return Solana 网络标识，取值为 localnet 或 devnet。 Solana network identifier, either localnet or devnet.
     */
    public String getNetwork() {
        return network;
    }

    /**
     * 以 MyBatis-Plus Lambda 查询可识别的属性名读取Mint 地址。
     * Exposes the mint address as a property for MyBatis-Plus lambda queries.
     *
     * @return SPL Token Mint 的公钥。 Public key of the SPL Token mint.
     */
    public String getMintAddress() {
        return mintAddress;
    }
}
