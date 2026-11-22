import createClient from 'openapi-fetch';
import type { paths } from './schema';

/**
 * 服务端报错或响应无法使用时的统一异常，供页面判断后续行为。
 * Common error for server failures or unusable responses, for page-level handling.
 */
export class ApiError extends Error {
  /**
   * 保存可展示的信息，并保留 HTTP 状态和后端错误码。
   * Stores the display message and preserves the HTTP status and backend error code.
   *
   * @param message 后端本地化文案或客户端通用提示。 Localized backend text or a generic client message.
   * @param kind HTTP 响应失败或响应格式无效。 HTTP failure or an invalid response format.
   * @param status 已读取到的 HTTP 状态码。 HTTP status code, when available.
   * @param code 后端提供的稳定错误码。 Stable error code supplied by the backend.
   */
  constructor(
    message: string,
    readonly kind: 'http' | 'invalid-response',
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 类型化请求客户端的返回结构。内部 data 由 OpenAPI 契约推断。
 * The typed request result. The inner data field is inferred from the OpenAPI contract.
 */
interface ApiRequestResult<T> {
  /** 请求成功时解析出的后端响应结构。 Parsed backend envelope on HTTP success. */
  data?: { data?: T; error?: unknown };
  /** HTTP 失败时读取的响应内容，代理也可能返回纯文本。 HTTP failure body, potentially plain text from a proxy. */
  error?: unknown;
  /** 原始响应，提供 HTTP 状态。 Original response, providing the HTTP status. */
  response: Response;
}

/**
 * 创建带有 OpenAPI 路径、参数和响应类型的请求客户端。
 * Creates a request client with OpenAPI path, parameter, and response types.
 *
 * @param getLanguage 返回当前界面的语言标记，每次请求时调用。 Returns the current UI language tag at request time.
 * @param baseUrl 可选地址前缀，默认使用浏览器当前站点。 Optional URL prefix, defaulting to the browser's current origin.
 * @returns 可发起类型化请求、传入 AbortSignal 的客户端。 Typed request client accepting an AbortSignal.
 */
export function createApiClient(getLanguage: () => string, baseUrl = '') {
  /** 路径和参数由生成的契约约束。 Paths and parameters follow the generated contract. */
  const client = createClient<paths>({
    baseUrl,
    headers: { Accept: 'application/json' },
    // 多个活动类型作为重复查询参数发送，符合 Spring 的读取方式。
    // Send multiple activity types as repeated query parameters, matching the Spring endpoint.
    querySerializer: { array: { style: 'form', explode: true } },
  });

  client.use({
    /**
     * 发送前读取语言，切换界面语言后无需重建客户端。
     * Reads the language at send time, so switching languages requires no new client.
     *
     * @param context 包含待发送 Request 的中间件上下文。 Middleware context containing the outgoing Request.
     * @returns 保留原请求取消信号并补齐语言标记的 Request。 Request with its cancellation signal and language header.
     */
    onRequest({ request }) {
      request.headers.set('Accept-Language', getLanguage());
      return request;
    },
  });

  return client;
}

/**
 * 拆开统一响应结构，失败时抛出可区分的异常，便于接入查询缓存。
 * Unwraps the common envelope and throws distinguishable errors for query caching.
 *
 * @param request 类型化请求返回的 Promise。 Promise returned by the typed request.
 * @returns 成功响应中非空的业务数据。 The non-null business data from a successful response.
 * @throws HTTP 失败或响应无效时抛出 ApiError，网络异常及取消原样传递。
 * Throws ApiError on HTTP or response-format failure. Network errors and cancellation are propagated as is.
 */
export async function unwrapApiResponse<T>(request: Promise<ApiRequestResult<T>>): Promise<NonNullable<T>> {
  // 这里区分 JSON 解析异常，保留网络异常和 AbortSignal 的原有行为。
  // Distinguish JSON parsing failures here while preserving native network and AbortSignal behavior.
  const result = await request.catch((error: unknown) => {
    if (error instanceof SyntaxError) {
      throw new ApiError('The API returned invalid JSON.', 'invalid-response');
    }
    throw error;
  });

  /** 服务端实际返回的 HTTP 状态。 HTTP status returned by the server. */
  const status = result.response.status;
  if (!result.response.ok) {
    /** 后端错误对象，反向代理的通用错误可能未提供。 Backend error details, possibly absent for proxy errors. */
    const details = readErrorDetails(result.error);
    throw new ApiError(details?.message ?? 'HTTP ' + status, 'http', status, details?.code);
  }

  /** HTTP 成功响应的外层结构，包含业务数据和空错误。 HTTP success envelope with business data and no error. */
  const envelope = result.data;
  // 零值和空列表都是成功数据，只有 null 或缺失数据才违反响应契约。
  // Zero and empty lists are successful data. Only null or missing payloads violate the contract.
  if (envelope?.data == null || envelope.error != null) {
    throw new ApiError('The API response does not contain valid data.', 'invalid-response', status);
  }

  return envelope.data;
}

/**
 * 从未知响应内容提取后端公开的错误字段。
 * Extracts public backend error fields from an unknown response body.
 *
 * @param body HTTP 失败时解析得到的响应内容。 Response body parsed for an HTTP failure.
 * @returns 可用的公开错误字段，无法识别时为 undefined。 Usable public error fields, or undefined for an unknown shape.
 */
function readErrorDetails(body: unknown): { code: string; message: string } | undefined {
  // 不把网关文本或任意错误对象直接显示为后端消息。
  // Do not surface arbitrary error objects or gateway text as a backend message.
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }

  /** 需要运行时检查的后端错误字段。 Backend error field that needs runtime validation. */
  const details = body.error;
  if (
    typeof details === 'object' &&
    details !== null &&
    'code' in details &&
    typeof details.code === 'string' &&
    'message' in details &&
    typeof details.message === 'string'
  ) {
    return { code: details.code, message: details.message };
  }

  return undefined;
}
