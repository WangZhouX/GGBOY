package io.ggboy.core.asset;

import io.ggboy.common.utils.SolanaAddressUtil;
import io.ggboy.common.utils.UnsignedIntegerUtil;

import java.math.BigInteger;

/**
 * 一笔 SPL Token 资产变动的精确金额。 / Exact amount of one SPL token movement.
 *
 * @param mint 代币 Mint 的 Base58 公钥。 / Base58 public key of the token mint.
 * @param decimals Mint 的小数位数，范围为 0 到 255。 / Mint decimal precision, from 0 through 255.
 * @param amountRaw 以最小代币单位表示的无符号 64 位整数。 / Unsigned 64-bit quantity in token base units.
 */
public record TokenAmount(String mint, int decimals, BigInteger amountRaw) {

    /**
     * 校验 Mint 的公钥编码和链上金额字段的范围。 / Validates the mint public key encoding and on-chain amount ranges.
     *
     * @throws NullPointerException Mint 或原始金额为空。 / The mint or raw amount is null.
     * @throws IllegalArgumentException 公钥编码、精度或数量越界。 / The key encoding, precision or quantity is invalid.
     */
    public TokenAmount {
        // 钱包、账户和 Mint 公钥使用相同的 Base58 编码约束。
        // Wallet, account, and mint public keys share the same Base58 encoding requirements.
        SolanaAddressUtil.requirePublicKey(mint, "mint");
        if (decimals < 0 || decimals > 255) {
            throw new IllegalArgumentException("decimals must be between 0 and 255");
        }
        // SPL 单笔数量是 u64，合法值可以超过 Java 有符号 long 的正数上限。
        // A single SPL quantity is a u64 and may exceed the positive range of a signed Java long.
        UnsignedIntegerUtil.requireUint64(amountRaw);
    }
}
