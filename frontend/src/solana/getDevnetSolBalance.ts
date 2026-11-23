/** 查询 Devnet SOL 余额所需的公开账户地址。 Public account address needed to query a Devnet SOL balance. */
export interface DevnetSolBalanceRequest {
  /** 已连接钱包的 Base58 公钥。 Base58 public key of the connected wallet. */
  walletAddress: string;
}

/** Solana Devnet 返回的账户余额。 Account balance returned by Solana Devnet. */
export interface DevnetSolBalanceResponse {
  /** 余额以 lamports 计，1 SOL 等于 10 亿 lamports。 The balance in lamports, with 1 SOL equal to 1 billion lamports. */
  lamports: bigint;
}

/** 首版直连 Solana 官方公开 Devnet RPC。 The first version connects directly to Solana's public Devnet RPC. */
export const devnetRpcUrl = 'https://api.devnet.solana.com';
/** 单个 HTTP 请求中的 JSON-RPC 响应关联标识。 JSON-RPC correlation ID within one HTTP request. */
const requestId = 1;
/** RPC 余额类型 u64 可表示的最大 lamports 数量。 Maximum lamport count representable by the RPC's u64 balance type. */
const maxLamports = 18_446_744_073_709_551_615n;

/**
 * 用公开公钥读取 Devnet 的已确认 SOL 余额。此调用无需钱包签名。
 * Read the confirmed Devnet SOL balance for a public key. This call requires no wallet signature.
 *
 * @param params 已连接钱包的公开地址。 Public address of the connected wallet.
 * @param signal 可在切换账户或网络时取消请求。 Optional signal to cancel the request when the account or network changes.
 * @returns 精确的 lamports 余额，包括已知的零余额。 Exact lamport balance, including known zero balances.
 * @throws 请求失败、RPC 拒绝、响应无效或当前浏览器无法精确读取金额时抛出。 Throws on HTTP, RPC, or response failure, or if exact decoding is unavailable.
 */
export async function getDevnetSolBalance(
  params: DevnetSolBalanceRequest,
  signal?: AbortSignal,
): Promise<DevnetSolBalanceResponse> {
  /** 钱包公钥是此只读 RPC 的唯一账户输入。 The wallet public key is the only account input to this read-only RPC. */
  const response = await fetch(devnetRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'getBalance',
      params: [params.walletAddress, { commitment: 'confirmed' }],
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Devnet balance HTTP request failed (${response.status}).`);

  // 读取原始 JSON，避免 response.json() 把超出 Number 安全范围的余额预先舍入。
  // Read raw JSON so response.json() cannot round lamport balances beyond the Number safe integer range.
  const body = await response.text();
  /** 运行时验证 RPC 响应，因为远程 JSON 的结构不可由 TypeScript 保证。 Validate the RPC response at runtime because TypeScript cannot guarantee remote JSON structure. */
  let payload: unknown;
  try {
    payload = JSON.parse(body, reviveBalanceValue);
  } catch {
    throw new Error('Devnet balance RPC returned invalid JSON.');
  }

  if (
    typeof payload !== 'object' || payload === null ||
    !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' ||
    !('id' in payload) || payload.id !== requestId
  ) {
    throw new Error('Devnet balance RPC returned an invalid response.');
  }
  if ('error' in payload) throw new Error('Devnet balance RPC returned an error.');

  // 接受精确解析且位于 u64 范围内的余额。零也是有效结果。
  // Accept only an exactly decoded balance within the u64 range. Zero is a valid result.
  const result = 'result' in payload ? payload.result : null;
  if (
    typeof result !== 'object' || result === null || !('value' in result) ||
    typeof result.value !== 'bigint' || result.value > maxLamports
  ) {
    throw new Error('Devnet balance RPC returned an invalid or imprecise balance.');
  }
  return { lamports: result.value };
}

/**
 * 在 JSON 解析时从原始数字文本精确还原余额。
 * Recover the exact balance from the original JSON number text during parsing.
 *
 * @param key 当前 JSON 字段名，RPC 余额在 result.value 中。 Current JSON property name; the RPC balance is in result.value.
 * @param value 浏览器已经解析的值。 Value already parsed by the browser.
 * @param context 支持原始文本的浏览器为原始值传入的额外上下文。 Additional context from browsers exposing the original primitive text.
 * @returns 可精确读取的余额转换为 bigint，其余值原样交给后续验证。 Exact balances become bigint; other values pass through for validation.
 */
function reviveBalanceValue(key: string, value: unknown, context?: { source: string }): unknown {
  if (key !== 'value' || typeof value !== 'number') return value;
  if (context) {
    /** u64 十进制最宽为 20 位，数字文本必须是非负整数。 A decimal u64 has at most 20 digits and must be a nonnegative integer. */
    const source = context.source;
    return source.length <= 20 && /^[0-9]+$/.test(source) ? BigInt(source) : value;
  }

  // 旧浏览器没有原始文本，仅接受 Number 能精确表示的整数。
  // Older browsers lack the source text, so only accept integers that Number can represent exactly.
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : value;
}
