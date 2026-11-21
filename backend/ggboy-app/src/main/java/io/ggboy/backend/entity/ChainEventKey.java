package io.ggboy.backend.entity;

/**
 * 在一个已确定的 Solana 网络中标识业务事件，供活动查询批量加载关联数据。
 * Identifies a business event within an already selected Solana network for batched activity detail reads.
 *
 * @param signature Base58 编码的交易主签名。 Primary transaction signature in Base58.
 * @param eventIndex 该事件在交易日志中的零基稳定序号。 Stable zero-based event index in the transaction log.
 */
public record ChainEventKey(String signature, int eventIndex) {
}
