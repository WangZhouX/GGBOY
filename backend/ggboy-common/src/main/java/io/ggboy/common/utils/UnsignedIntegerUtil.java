package io.ggboy.common.utils;

import java.math.BigInteger;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * 校验无符号整数，并在精确数值和 API 的十进制文本之间转换。
 * Validates unsigned integers and converts between exact values and decimal API text.
 */
public final class UnsignedIntegerUtil {

    /** 无符号 64 位整数的最大值，即 2 的 64 次方减一。 Maximum unsigned 64-bit integer, two to the power of 64 minus one. */
    private static final BigInteger UINT64_MAX = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);

    /** u64 的标准文本为单个零或最多 20 位的 ASCII 正整数。 Canonical u64 text is zero or a positive ASCII integer of up to 20 digits. */
    private static final Pattern UINT64_DECIMAL = Pattern.compile("0|[1-9][0-9]{0,19}");

    /** 工具方法通过类名调用。 Utility methods are accessed through the class. */
    private UnsignedIntegerUtil() {
    }

    /**
     * 校验数值处于无符号 64 位整数范围，返回原数值。
     * Checks that the value fits an unsigned 64-bit integer and returns the original value.
     *
     * @param value 待校验的整数。 Integer to validate.
     * @return 范围从零到 2 的 64 次方减一的原数值。 Original value in the range zero through two to the power of 64 minus one.
     * @throws NullPointerException 输入为空。 The input is null.
     * @throws IllegalArgumentException 输入超出 u64 范围。 The input is outside the unsigned 64-bit range.
     */
    public static BigInteger requireUint64(BigInteger value) {
        Objects.requireNonNull(value, "value");
        // 使用完整精度比较上下界，覆盖大于 Java 有符号 long 最大值的合法数值。
        // Compare both bounds at full precision to include valid values above the maximum signed Java long.
        if (value.signum() < 0 || value.compareTo(UINT64_MAX) > 0) {
            throw new IllegalArgumentException("Value is outside the unsigned 64-bit range");
        }
        return value;
    }

    /**
     * 将 API 中表示 slot 或代币最小单位的标准十进制字符串解析为 u64。
     * Parses a canonical decimal API string representing a slot or token base units into a u64.
     *
     * @param text 仅含 ASCII 数字的文本，只有零本身可以用零开头。 ASCII decimal digits, with an initial zero allowed only for zero itself.
     * @return 保持全部精度的非负整数。 Nonnegative integer with full precision.
     * @throws NullPointerException 文本为空引用。 The text is null.
     * @throws IllegalArgumentException 文本格式错误或数值超过 u64 上限。 The text is malformed or exceeds the u64 maximum.
     */
    public static BigInteger parseUint64(String text) {
        Objects.requireNonNull(text, "text");
        // 先限制位数和字符，避免构造超长整数，也避免 BigInteger 接受符号或非 ASCII 数字。
        // Bound the digit count and alphabet before allocating an integer, excluding signs and non-ASCII digits accepted by BigInteger.
        if (!UINT64_DECIMAL.matcher(text).matches()) {
            throw new IllegalArgumentException("Expected canonical unsigned 64-bit decimal text");
        }
        // 20 位文本仍有可能大于 2^64−1，复用数值输入的范围检查。
        // A 20-digit number can still exceed 2^64−1, so apply the same bounds as for numeric inputs.
        return requireUint64(new BigInteger(text));
    }

    /**
     * 将 u64 格式化为 API 使用的标准十进制字符串。
     * Formats a u64 as the canonical decimal string used in API responses.
     *
     * @param value 以整数表示的 slot 或代币最小单位数量。 Slot or token base-unit quantity as an integer.
     * @return 完整精度的 ASCII 十进制文本，零表示为单个字符 0。 Full-precision ASCII decimal text, with zero represented by a single 0.
     * @throws NullPointerException 数值为空引用。 The value is null.
     * @throws IllegalArgumentException 数值超出 u64 范围。 The value is outside the u64 range.
     */
    public static String formatUint64(BigInteger value) {
        return requireUint64(value).toString();
    }
}
