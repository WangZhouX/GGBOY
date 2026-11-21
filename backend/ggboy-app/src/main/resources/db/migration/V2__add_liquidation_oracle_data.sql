-- 在原有借贷表中记录清算市场所需的可验证报价与风险批次。
-- Record verifiable quotes and risk batches for the liquidation market in existing lending tables.
-- 历史行保留空字段及未发布状态。 / Historical rows retain null fields and unpublished status.

ALTER TABLE lending_market
    ADD COLUMN oracle_address varchar(44),
    ADD COLUMN oracle_max_age_seconds integer,
    -- 预言机账户和正数有效期需要同时配置。 / Configure the oracle account and positive maximum age together.
    ADD CONSTRAINT lending_market_oracle_configuration_ck CHECK (
        (oracle_address IS NULL AND oracle_max_age_seconds IS NULL)
        OR (oracle_address IS NOT NULL AND oracle_max_age_seconds IS NOT NULL AND oracle_max_age_seconds > 0)
    );

COMMENT ON TABLE lending_market IS '链上借贷市场登记，绑定借款资产、抵押资产及可选价格源配置。 / Registry of on-chain lending markets with their debt asset, collateral asset and optional price feed configuration.';
COMMENT ON COLUMN lending_market.oracle_address IS '链上市场配置的价格源账户地址，未配置时为空。 / Address of the price feed account configured by the on-chain market, null when unconfigured.';
COMMENT ON COLUMN lending_market.oracle_max_age_seconds IS '允许的报价最大年龄（秒），未配置时为空。 / Maximum acceptable price age in seconds, null when unconfigured.';

ALTER TABLE lending_market_snapshot
    ADD COLUMN oracle_address varchar(44),
    ADD COLUMN oracle_collateral_mint varchar(44),
    ADD COLUMN oracle_debt_mint varchar(44),
    ADD COLUMN oracle_price_numerator numeric(39,0),
    ADD COLUMN oracle_price_denominator numeric(39,0),
    ADD COLUMN oracle_slot numeric(20,0),
    ADD COLUMN oracle_published_at timestamptz,
    ADD COLUMN oracle_price_version varchar(64),
    ADD COLUMN risk_batch_published boolean NOT NULL DEFAULT false,
    -- 有值时报价为正，发布时间和 slot 不晚于快照观测。 / When present, prices are positive and publication time and slot do not exceed the observation.
    ADD CONSTRAINT lending_market_snapshot_oracle_values_ck CHECK (
        (oracle_price_numerator > 0 AND oracle_price_numerator <> 'NaN'::numeric)
        AND (oracle_price_denominator > 0 AND oracle_price_denominator <> 'NaN'::numeric)
        AND (oracle_slot BETWEEN 0 AND 18446744073709551615 AND oracle_slot <= slot)
        AND (isfinite(oracle_published_at) AND oracle_published_at <= observed_at)
        AND oracle_price_version ~ '^[0-9a-f]{64}$'
    ),
    -- 只在批次完成且报价字段齐全时标记已发布。 / Mark the batch published only when complete and all quote fields are present.
    ADD CONSTRAINT lending_market_snapshot_risk_publication_ck CHECK (
        NOT risk_batch_published OR (
            oracle_address IS NOT NULL
            AND oracle_collateral_mint IS NOT NULL
            AND oracle_debt_mint IS NOT NULL
            AND oracle_price_numerator IS NOT NULL
            AND oracle_price_denominator IS NOT NULL
            AND oracle_slot IS NOT NULL
            AND oracle_published_at IS NOT NULL
            AND oracle_price_version IS NOT NULL
        )
    );

COMMENT ON TABLE lending_market_snapshot IS '借贷市场在某一最终确认观测 slot 的资金池状态、报价及风险批次信息。 / Market pool state, quote and risk batch information at a finalized observation slot.';
COMMENT ON COLUMN lending_market_snapshot.oracle_address IS '读取原始报价的价格源账户地址。 / Price feed account address from which the original quote was read.';
COMMENT ON COLUMN lending_market_snapshot.oracle_collateral_mint IS '报价的抵押资产 Mint 地址。 / Collateral asset mint address in the quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_debt_mint IS '报价的债务资产 Mint 地址。 / Debt asset mint address in the quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_price_numerator IS '每整单位抵押资产所值整单位债务资产的报价分子。 / Numerator of the whole debt tokens per whole collateral token price ratio.';
COMMENT ON COLUMN lending_market_snapshot.oracle_price_denominator IS '每整单位抵押资产所值整单位债务资产的报价分母。 / Denominator of the whole debt tokens per whole collateral token price ratio.';
COMMENT ON COLUMN lending_market_snapshot.oracle_slot IS '预言机原始报价的链上发布 slot。 / On-chain publication slot of the original oracle quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_published_at IS '预言机原始报价的发布时间。 / Publication time of the original oracle quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_price_version IS '该批次所用报价的 64 字符小写十六进制版本。 / The 64-character lowercase hexadecimal version of the quote used by this batch.';
COMMENT ON COLUMN lending_market_snapshot.risk_batch_published IS '索引器已完整发布该 slot 的风险批次时为 true。 / True once the indexer publishes the complete risk batch for this slot.';

ALTER TABLE lending_position_snapshot
    ADD COLUMN oracle_price_version varchar(64),
    -- 记录报价版本时必须保留相应的历史预言机 slot。 / A price version requires the corresponding historical oracle slot.
    ADD CONSTRAINT lending_position_snapshot_oracle_version_ck CHECK (
        oracle_price_version IS NULL
        OR (oracle_slot IS NOT NULL AND oracle_price_version ~ '^[0-9a-f]{64}$')
    );

COMMENT ON COLUMN lending_position_snapshot.oracle_price_version IS '计算该仓位健康度所用报价的 64 字符小写十六进制版本。旧仓位或无可用报价时为空。 / The 64-character lowercase hexadecimal version of the quote used for position health, null for legacy positions or when no usable quote exists.';

-- 固定市场风险观测 slot 后按健康度和钱包地址续页。
-- Seek by health factor and wallet address within the observed market risk slot.
CREATE INDEX lending_position_snapshot_liquidation_order_idx
    ON lending_position_snapshot (network, market_address, slot, health_factor, wallet_address)
    WHERE health_factor IS NOT NULL;
COMMENT ON INDEX lending_position_snapshot_liquidation_order_idx IS '清算市场按观测 slot、健康度及钱包地址分页。 / Page liquidation market candidates by observation slot, health factor and wallet address.';
