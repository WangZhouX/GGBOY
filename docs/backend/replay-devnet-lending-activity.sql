-- 部署支持 LendingSupply 的索引器后，重置当前 GGBOY Devnet 借贷程序的续扫起点。
-- After deploying LendingSupply support, restart scanning the current GGBOY Devnet lending program from available history.
-- 已有交易、事件与回执不被删除，重复事件按网络、交易签名和原始日志行号去重。
-- Stored transactions and receipts remain available. Replay deduplicates by network, signature, and original log index.
UPDATE indexer_checkpoint
SET last_signature = NULL, last_slot = NULL, updated_at = CURRENT_TIMESTAMP
WHERE network = 'devnet'
  AND program_id = '8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H'
  AND last_signature IS NOT NULL;
