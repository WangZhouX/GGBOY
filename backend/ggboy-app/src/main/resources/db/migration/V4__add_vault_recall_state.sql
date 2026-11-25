-- 保存自动收回的链上观测，使旧快照保持现金赎回。
-- Persist observed on-chain auto-recall state and retain cash-only redemption on historical rows.
ALTER TABLE vault_snapshot
    ADD COLUMN auto_recall_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN lending_position_open boolean,
    ADD CONSTRAINT vault_snapshot_recall_position_known
        CHECK (NOT auto_recall_enabled OR lending_position_open IS NOT NULL),
    ADD CONSTRAINT vault_snapshot_closed_lending_value_zero
        CHECK (lending_position_open IS DISTINCT FROM false OR lend_value_raw = 0);

COMMENT ON COLUMN vault_snapshot.auto_recall_enabled IS '同一观测 slot 的 Vault 状态是否允许赎回时自动收回借贷流动性。旧记录默认为 false。 / Whether the same-slot Vault state allowed automatic recall during redemption. Historical rows default to false.';
COMMENT ON COLUMN vault_snapshot.lending_position_open IS '同一观测 slot 的金库出借份额是否大于零。旧记录为空表示未采集此状态。 / Whether vault lending shares were nonzero at the same observed slot. Null means this state was not collected for the historical row.';
