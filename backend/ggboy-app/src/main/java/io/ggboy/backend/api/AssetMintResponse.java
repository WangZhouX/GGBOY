package io.ggboy.backend.api;

import io.ggboy.backend.entity.AssetMintDO;

/**
 * 金库和借贷市场的资产标识及展示精度。
 * Asset identifier and display precision shared by vaults and lending markets.
 *
 * @param mint 资产的链上 Mint 公钥。 On-chain public key of the asset mint.
 * @param symbol 资产的展示简称，未配置时为空。 Display ticker, or null when unconfigured.
 * @param decimals 从 Mint 读取的小数位数。 Decimal precision read from the mint.
 */
public record AssetMintResponse(String mint, String symbol, int decimals) {

    /**
     * 使用已登记的 Mint 元数据组装资产响应。
     * Builds the asset response from registered mint metadata.
     *
     * @param record 同一部署网络的资产登记。 Asset registration for the same deployment network.
     * @return 用于识别资产和展示最小单位数量的数据。 Data to identify the asset and format base-unit amounts.
     */
    public static AssetMintResponse from(AssetMintDO record) {
        return new AssetMintResponse(record.mintAddress(), record.symbol(), record.decimals());
    }
}
