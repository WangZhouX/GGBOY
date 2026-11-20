package io.ggboy.common.tests;

import io.ggboy.common.utils.UnsignedIntegerUtil;

import java.math.BigInteger;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 验证 u64 数值与十进制文本契约。 Verifies the u64 numeric and decimal text contracts. */
class UnsignedIntegerUtilTest {

    /**
     * 验证零、十进制进位和有符号 long 边界两侧的值都可精确往返。
     * Verifies exact round trips at zero, across a decimal digit boundary and around the signed long limit.
     *
     * @param text 规范的 u64 十进制文本。 Canonical u64 decimal text.
     */
    @ParameterizedTest
    @ValueSource(strings = {"0", "9", "10", "9223372036854775807", "9223372036854775808", "18446744073709551615"})
    void roundTripsCanonicalText(String text) {
        // 解析结果要与独立构造的精确整数一致。 Compare the parsed value with an independently constructed exact integer.
        BigInteger value = UnsignedIntegerUtil.parseUint64(text);
        assertEquals(new BigInteger(text), value);
        assertEquals(text, UnsignedIntegerUtil.formatUint64(value));
    }

    /**
     * 验证越界值、非 ASCII 数字及非规范写法被拒绝。
     * Verifies rejection of out-of-range values, non-ASCII digits and noncanonical spellings.
     *
     * @param text 不符合公开传输格式的输入。 Input outside the public wire format.
     */
    @ParameterizedTest
    @ValueSource(strings = {"", "00", "01", "+1", "-0", "-1", " 1", "1 ", "1\n", "1.0", "1e1", "１", "١",
            "18446744073709551616", "100000000000000000000"})
    void rejectsInvalidText(String text) {
        assertThrows(IllegalArgumentException.class, () -> UnsignedIntegerUtil.parseUint64(text));
    }

    /** 数值格式化也必须遵守 u64 边界。 Formatting numeric inputs must respect the same u64 bounds. */
    @Test
    void rejectsOutOfRangeNumbers() {
        assertThrows(IllegalArgumentException.class, () -> UnsignedIntegerUtil.formatUint64(BigInteger.ONE.negate()));
        assertThrows(IllegalArgumentException.class, () -> UnsignedIntegerUtil.formatUint64(BigInteger.ONE.shiftLeft(64)));
    }

    /** 缺少输入不能转换成数值零。 Missing input cannot be converted to numeric zero. */
    @Test
    void rejectsNullInputs() {
        assertThrows(NullPointerException.class, () -> UnsignedIntegerUtil.parseUint64(null));
        assertThrows(NullPointerException.class, () -> UnsignedIntegerUtil.formatUint64(null));
    }
}
