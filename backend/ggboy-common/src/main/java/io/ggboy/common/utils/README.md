# 公共数值工具

跨模块工具类位于 `io.ggboy.common.utils` 包，类名统一以 `Util` 结尾。

[UnsignedIntegerUtil](UnsignedIntegerUtil.java) 支持 0 至 18,446,744,073,709,551,615 的闭区间，适用于链上 slot 和单笔 SPL 代币变动量。累计债务、净值等使用更宽精度的字段沿用各自的数据字典定义。

| 方法 | 用途 |
| --- | --- |
| `requireUint64(value)` | 校验 `BigInteger` 的范围并返回原值 |
| `parseUint64(text)` | 将规范十进制文本解析为 `BigInteger`。只接受 ASCII 数字，零写成 `"0"`，正数从非零数字开始 |
| `formatUint64(value)` | 校验范围并生成规范十进制文本，以便 API 在 JSON 字符串中传输完整精度 |

例如 `"18446744073709551615"` 可精确往返。`"01"`、`"-1"`、`"1.0"` 和超出上界的文本均无效。
