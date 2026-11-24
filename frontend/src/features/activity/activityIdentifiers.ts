/** Solana 公钥和签名使用的 Base58 字符表。 Base58 alphabet used for Solana keys and signatures. */
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * 验证 Base58 文本的解码长度，保留前导零字节并限制计算规模。
 * Check the decoded width of Base58 text, preserving leading zero bytes and bounding the input.
 *
 * @param value 待解码的 Base58 文本。 Base58 text to decode.
 * @param byteLength 期望的字节数。 Expected number of decoded bytes.
 * @param maxLength 给定字节数对应的最大编码字符数。 Maximum encoded character count for that byte width.
 */
function hasBase58Width(value: string, byteLength: number, maxLength: number): boolean {
  if (value.length < byteLength || value.length > maxLength) return false;

  /** 每个前导字符 1 对应一个零字节。 Each leading 1 represents one zero byte. */
  const leadingZeros = /^1*/.exec(value)?.[0].length ?? 0;
  /** 其余字符代表一个无符号的大端整数。 The remaining characters encode an unsigned big-endian integer. */
  let decoded = 0n;
  for (const character of value.slice(leadingZeros)) {
    /** 当前字符在 Base58 字符表中的数值。 Numeric Base58 value of the current character. */
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }

  /** 非零整数所需的有效字节数，零不再额外占字节。 Significant bytes of the integer, with no additional byte for zero. */
  const remainingBytes = decoded === 0n ? 0 : Math.ceil(decoded.toString(16).length / 2);
  return leadingZeros + remainingBytes === byteLength;
}

/**
 * 判断是否是 32 字节的 Solana 公钥。
 * Validate the 32-byte encoding of a Solana public key.
 *
 * @param value 钱包、业务账户、程序或 Mint 地址。 Wallet, subject, program, or mint address.
 */
export function isActivityPublicKey(value: string): boolean {
  return hasBase58Width(value, 32, 44);
}

/**
 * 判断是否是 64 字节的 Solana 交易签名。
 * Validate the 64-byte encoding of a Solana transaction signature.
 *
 * @param value 用于活动检索或回执链接的交易主签名。 Primary transaction signature for a search or receipt link.
 */
export function isActivitySignature(value: string): boolean {
  return hasBase58Width(value, 64, 88);
}

/**
 * 判断是否是后端接受的从零开始的事件序号。
 * Check a zero-based event index accepted by the backend.
 *
 * @param value 待校验的 JSON 数值或由路由转换的数字。 JSON value or number parsed from a route segment.
 */
export function isActivityEventIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}
