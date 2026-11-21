-- GGBOY 后端关系模型评审稿。仅在空白验证库中运行。
-- GGBOY relational schema for review. Run only in an empty verification database.

BEGIN;

-- 首期交易活动 / Phase 1 activity history

CREATE TABLE chain_transaction (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    signature varchar(88) NOT NULL,
    slot numeric(20,0) NOT NULL CHECK (slot BETWEEN 0 AND 18446744073709551615),
    block_time timestamptz,
    indexed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network, signature)
);

COMMENT ON TABLE chain_transaction IS '已最终确认且成功、包含 GGBOY 业务事件的交易。首期模拟数据使用同样结构。 / Finalized successful transactions with GGBOY business events. Phase one fixtures use the same structure.';
COMMENT ON COLUMN chain_transaction.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN chain_transaction.signature IS 'Solana 交易主签名，Base58 编码。 / Primary Solana transaction signature in Base58.';
COMMENT ON COLUMN chain_transaction.slot IS '交易实际落入的链上 slot。 / On-chain slot in which the transaction landed.';
COMMENT ON COLUMN chain_transaction.block_time IS '链上区块时间，RPC 未返回时为空。 / Block timestamp. Null when unavailable from RPC.';
COMMENT ON COLUMN chain_transaction.indexed_at IS '此交易首次写入索引库的时间。 / Time this transaction first entered the index.';

CREATE TABLE chain_event (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    signature varchar(88) NOT NULL,
    event_index integer NOT NULL CHECK (event_index >= 0),
    program_id varchar(44) NOT NULL,
    module varchar(16) NOT NULL CHECK (module IN ('VAULT', 'LENDING')),
    event_type varchar(48) NOT NULL,
    subject_address varchar(44) NOT NULL,
    PRIMARY KEY (network, signature, event_index),
    FOREIGN KEY (network, signature)
        REFERENCES chain_transaction (network, signature)
);

COMMENT ON TABLE chain_event IS '在一笔交易内发生的单个可展示业务事件。 / One displayable business event within a transaction.';
COMMENT ON COLUMN chain_event.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN chain_event.signature IS 'Solana 交易主签名，Base58 编码。 / Primary Solana transaction signature in Base58.';
COMMENT ON COLUMN chain_event.event_index IS '事件在整笔交易日志中的零基稳定序号。 / Stable zero-based index of the event in the full transaction log.';
COMMENT ON COLUMN chain_event.program_id IS '该事件的来源程序 ID。 / Program ID that emitted the event.';
COMMENT ON COLUMN chain_event.module IS '事件所属领域，限 VAULT 或 LENDING。 / Business domain of the event, VAULT or LENDING.';
COMMENT ON COLUMN chain_event.event_type IS '稳定的业务动作代码，由索引映射维护。 / Stable business action code maintained by the indexer mapping.';
COMMENT ON COLUMN chain_event.subject_address IS '本业务事件对应的金库或借贷市场状态地址。 / Vault or lending market state address associated with this event.';

CREATE TABLE chain_event_participant (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    signature varchar(88) NOT NULL,
    event_index integer NOT NULL CHECK (event_index >= 0),
    wallet_address varchar(44) NOT NULL,
    role varchar(24) NOT NULL CHECK (role IN ('ACTOR', 'INVESTOR', 'MANAGER', 'SUPPLIER', 'BORROWER', 'LIQUIDATOR', 'BENEFICIARY')),
    PRIMARY KEY (network, signature, event_index, wallet_address, role),
    FOREIGN KEY (network, signature, event_index)
        REFERENCES chain_event (network, signature, event_index)
);

COMMENT ON TABLE chain_event_participant IS '事件涉及的业务钱包或 PDA 及其角色，支持按任一参与方查询。 / Business wallets or PDAs and their roles in an event, searchable by any participant.';
COMMENT ON COLUMN chain_event_participant.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN chain_event_participant.signature IS 'Solana 交易主签名，Base58 编码。 / Primary Solana transaction signature in Base58.';
COMMENT ON COLUMN chain_event_participant.event_index IS '事件在整笔交易日志中的零基稳定序号。 / Stable zero-based index of the event in the full transaction log.';
COMMENT ON COLUMN chain_event_participant.wallet_address IS '参与业务的链上钱包或 PDA 地址。 / On-chain wallet or PDA participating in the business action.';
COMMENT ON COLUMN chain_event_participant.role IS '当前事件内的参与角色，同一地址可具有多个角色。 / Participant role in this event. An address may have multiple roles.';

CREATE TABLE chain_event_asset (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    signature varchar(88) NOT NULL,
    event_index integer NOT NULL CHECK (event_index >= 0),
    leg_index integer NOT NULL CHECK (leg_index >= 0),
    mint_address varchar(44) NOT NULL,
    decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 255),
    amount_raw numeric(20,0) NOT NULL CHECK (amount_raw BETWEEN 0 AND 18446744073709551615),
    leg_type varchar(24) NOT NULL CHECK (leg_type IN ('ASSET_IN', 'ASSET_OUT', 'SHARES_MINTED', 'SHARES_BURNED', 'DEBT_REPAID', 'COLLATERAL_SEIZED')),
    PRIMARY KEY (network, signature, event_index, leg_index),
    FOREIGN KEY (network, signature, event_index)
        REFERENCES chain_event (network, signature, event_index)
);

COMMENT ON TABLE chain_event_asset IS '事件中的一项实际资产变动，保存当时的 Mint 和精度。 / One actual asset movement in an event, including its mint and precision at the time.';
COMMENT ON COLUMN chain_event_asset.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN chain_event_asset.signature IS 'Solana 交易主签名，Base58 编码。 / Primary Solana transaction signature in Base58.';
COMMENT ON COLUMN chain_event_asset.event_index IS '事件在整笔交易日志中的零基稳定序号。 / Stable zero-based index of the event in the full transaction log.';
COMMENT ON COLUMN chain_event_asset.leg_index IS '事件内的零基资产变动序号，由事件映射定义。 / Zero-based asset movement index within the event, defined by its mapping.';
COMMENT ON COLUMN chain_event_asset.mint_address IS '交易发生时的 SPL Token Mint 地址，包括份额 Mint。 / SPL token mint address at the time of the transaction, including share mints.';
COMMENT ON COLUMN chain_event_asset.decimals IS '该 Mint 的小数位数，用于展示最小单位金额。 / Decimal precision of the mint, used to display base-unit amounts.';
COMMENT ON COLUMN chain_event_asset.amount_raw IS '实际资产变动量，使用对应代币的最小单位。 / Actual amount moved in base units of the associated token.';
COMMENT ON COLUMN chain_event_asset.leg_type IS '资产变动的业务语义。出入方向依据事件主体定义。 / Meaning of the asset movement. Direction is relative to the event subject.';

-- 链上索引与快照 / Phase 2 chain indexing and snapshots

CREATE TABLE indexer_checkpoint (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    program_id varchar(44) NOT NULL,
    last_signature varchar(88),
    last_slot numeric(20,0) CHECK (last_slot BETWEEN 0 AND 18446744073709551615),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network, program_id),
    CHECK ((last_signature IS NULL) = (last_slot IS NULL))
);

COMMENT ON TABLE indexer_checkpoint IS '按网络和程序保存已连续处理的最终确认交易边界，用于重启和补扫。 / Contiguous finalized indexing frontier per network and program, used to restart and backfill.';
COMMENT ON COLUMN indexer_checkpoint.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN indexer_checkpoint.program_id IS '该检查点跟踪的链上程序 ID。 / ID of the on-chain program tracked by this checkpoint.';
COMMENT ON COLUMN indexer_checkpoint.last_signature IS '已处理边界的交易主签名，首次推进前为空。 / Primary signature at the processed frontier. Null before the first advance.';
COMMENT ON COLUMN indexer_checkpoint.last_slot IS '已处理边界所在的 slot，首次推进前为空。 / Slot of the processed frontier. Null before the first advance.';
COMMENT ON COLUMN indexer_checkpoint.updated_at IS '检查点的最后推进时间，初始化时为创建时间。 / Time the checkpoint last advanced, initially set to creation time.';

CREATE TABLE asset_mint (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    mint_address varchar(44) NOT NULL,
    symbol varchar(24),
    decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 255),
    program_id varchar(44) NOT NULL,
    PRIMARY KEY (network, mint_address)
);

COMMENT ON TABLE asset_mint IS 'GGBOY 使用的 Mint 登记，用于金库、市场和仓位展示。 / Mint registry for the assets and shares used by GGBOY vaults, markets and positions.';
COMMENT ON COLUMN asset_mint.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN asset_mint.mint_address IS '对应 SPL Token 的链上 Mint 地址。 / On-chain SPL token mint address.';
COMMENT ON COLUMN asset_mint.symbol IS '可用的展示简称，尚未配置时为空。 / Display ticker, if configured.';
COMMENT ON COLUMN asset_mint.decimals IS '该 Mint 的小数位数，用于展示最小单位金额。 / Decimal precision of the mint, used to display base-unit amounts.';
COMMENT ON COLUMN asset_mint.program_id IS '该 Mint 账户的代币程序 ID。 / Token program ID that owns this mint account.';

CREATE TABLE lending_market (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    market_address varchar(44) NOT NULL,
    program_id varchar(44) NOT NULL,
    debt_mint varchar(44) NOT NULL,
    collateral_mint varchar(44) NOT NULL,
    oracle_address varchar(44),
    oracle_max_age_seconds integer,
    PRIMARY KEY (network, market_address),
    UNIQUE (network, market_address, debt_mint),
    FOREIGN KEY (network, debt_mint)
        REFERENCES asset_mint (network, mint_address),
    FOREIGN KEY (network, collateral_mint)
        REFERENCES asset_mint (network, mint_address),
    CHECK (debt_mint <> collateral_mint),
    -- 预言机账户和正数有效期需要同时配置。 / Configure the oracle account and positive maximum age together.
    CONSTRAINT lending_market_oracle_configuration_ck CHECK (
        (oracle_address IS NULL AND oracle_max_age_seconds IS NULL)
        OR (oracle_address IS NOT NULL AND oracle_max_age_seconds IS NOT NULL AND oracle_max_age_seconds > 0)
    )
);

COMMENT ON TABLE lending_market IS '链上借贷市场登记，绑定借款资产、抵押资产及可选价格源配置。 / Registry of on-chain lending markets with their debt asset, collateral asset and optional price feed configuration.';
COMMENT ON COLUMN lending_market.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN lending_market.market_address IS '链上借贷市场状态账户地址。 / On-chain lending market state account address.';
COMMENT ON COLUMN lending_market.program_id IS '拥有该市场状态账户的借贷程序 ID。 / Lending program ID that owns this market state account.';
COMMENT ON COLUMN lending_market.debt_mint IS '借贷池供给、借款和还款使用的 Mint。 / Mint used for supply, borrowing and repayments in the market.';
COMMENT ON COLUMN lending_market.collateral_mint IS '该市场支持的抵押资产 Mint。 / Collateral asset mint accepted by this market.';
COMMENT ON COLUMN lending_market.oracle_address IS '链上市场配置的价格源账户地址，未配置时为空。 / Address of the price feed account configured by the on-chain market, null when unconfigured.';
COMMENT ON COLUMN lending_market.oracle_max_age_seconds IS '允许的报价最大年龄（秒），未配置时为空。 / Maximum acceptable price age in seconds, null when unconfigured.';

-- 组合外键同时校验金库与借贷市场使用相同计价资产。
-- The composite foreign key also requires the vault and market to use the same quote asset.
CREATE TABLE vault (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    vault_address varchar(44) NOT NULL,
    program_id varchar(44) NOT NULL,
    quote_mint varchar(44) NOT NULL,
    share_mint varchar(44) NOT NULL,
    strategy_mint varchar(44),
    lending_market_address varchar(44),
    PRIMARY KEY (network, vault_address),
    UNIQUE (network, share_mint),
    FOREIGN KEY (network, quote_mint)
        REFERENCES asset_mint (network, mint_address),
    FOREIGN KEY (network, share_mint)
        REFERENCES asset_mint (network, mint_address),
    FOREIGN KEY (network, strategy_mint)
        REFERENCES asset_mint (network, mint_address),
    FOREIGN KEY (network, lending_market_address, quote_mint)
        REFERENCES lending_market (network, market_address, debt_mint),
    CHECK (quote_mint <> share_mint),
    CHECK (strategy_mint IS NULL OR (strategy_mint <> quote_mint AND strategy_mint <> share_mint))
);

COMMENT ON TABLE vault IS '链上策略金库登记，绑定计价和份额 Mint，并可接入一个借贷市场。 / Registry of on-chain strategy vaults, with quote and share mints and an optional lending market.';
COMMENT ON COLUMN vault.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN vault.vault_address IS '链上金库状态账户地址。 / On-chain vault state account address.';
COMMENT ON COLUMN vault.program_id IS '拥有该金库状态账户的金库程序 ID。 / Vault program ID that owns this vault state account.';
COMMENT ON COLUMN vault.quote_mint IS '用于存入、赎回和净值计价的 Mint。 / Mint used for deposits, redemptions and NAV valuation.';
COMMENT ON COLUMN vault.share_mint IS '代表对该金库权益的份额 Mint。 / Mint representing shares in this vault.';
COMMENT ON COLUMN vault.strategy_mint IS '首个策略资产的 Mint。未配置策略时为空。 / Mint of the initial strategy asset. Null when a strategy asset is unconfigured.';
COMMENT ON COLUMN vault.lending_market_address IS '链上配置的出借市场地址。未配置时为空。 / On-chain address of the configured lending market. Null when unconfigured.';

CREATE TABLE vault_snapshot (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    vault_address varchar(44) NOT NULL,
    slot numeric(20,0) NOT NULL CHECK (slot BETWEEN 0 AND 18446744073709551615),
    observed_at timestamptz NOT NULL DEFAULT now(),
    oracle_slot numeric(20,0) CHECK (oracle_slot BETWEEN 0 AND 18446744073709551615),
    cash_raw numeric(20,0) NOT NULL CHECK (cash_raw BETWEEN 0 AND 18446744073709551615),
    strategy_amount_raw numeric(20,0) NOT NULL CHECK (strategy_amount_raw BETWEEN 0 AND 18446744073709551615),
    strategy_value_raw numeric(39,0) CHECK (strategy_value_raw >= 0 AND strategy_value_raw <> 'NaN'::numeric),
    lend_value_raw numeric(39,0) NOT NULL CHECK (lend_value_raw >= 0 AND lend_value_raw <> 'NaN'::numeric),
    lending_withdrawable_raw numeric(39,0) NOT NULL CHECK (lending_withdrawable_raw >= 0 AND lending_withdrawable_raw <> 'NaN'::numeric),
    nav_raw numeric(39,0) CHECK (nav_raw >= 0 AND nav_raw <> 'NaN'::numeric),
    total_shares_raw numeric(20,0) NOT NULL CHECK (total_shares_raw BETWEEN 0 AND 18446744073709551615),
    PRIMARY KEY (network, vault_address, slot),
    FOREIGN KEY (network, vault_address)
        REFERENCES vault (network, vault_address),
    CHECK (lending_withdrawable_raw <= lend_value_raw),
    CHECK ((nav_raw IS NULL) = (strategy_value_raw IS NULL)),
    CHECK (nav_raw = cash_raw + strategy_value_raw + lend_value_raw),
    CHECK (oracle_slot <= slot)
);

COMMENT ON TABLE vault_snapshot IS '金库在某一最终确认观测 slot 的估值、资金分布和赎回流动性。 / Vault valuation, allocation and redemption liquidity at a finalized observation slot.';
COMMENT ON COLUMN vault_snapshot.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN vault_snapshot.vault_address IS '链上金库状态账户地址。 / On-chain vault state account address.';
COMMENT ON COLUMN vault_snapshot.slot IS 'RPC 读取金库和估值输入所处的最终确认观测 slot。 / Finalized RPC observation slot of the vault and valuation inputs.';
COMMENT ON COLUMN vault_snapshot.observed_at IS '索引器取得该快照的时间，API 统一输出 UTC。 / Time the indexer obtained the snapshot. The API emits UTC.';
COMMENT ON COLUMN vault_snapshot.oracle_slot IS '使用的预言机发布 slot。未取得可用价格时为空。 / Publish slot of the oracle price used. Null when a usable price is unavailable.';
COMMENT ON COLUMN vault_snapshot.cash_raw IS '金库持有的结算现金，单位为计价 Mint 最小单位。 / Cash held by the vault in base units of the quote mint.';
COMMENT ON COLUMN vault_snapshot.strategy_amount_raw IS '金库持有的策略资产量，单位为策略 Mint 最小单位。 / Strategy assets held, in base units of the strategy mint.';
COMMENT ON COLUMN vault_snapshot.strategy_value_raw IS '按有效预言机价格折算的策略资产价值，单位为计价 Mint 最小单位。需要价格且价格不可用时为空。 / Strategy value from a usable oracle price, in quote mint base units. Null when a required price is unavailable.';
COMMENT ON COLUMN vault_snapshot.lend_value_raw IS '出借仓位账面价值，已反映计息和确认坏账，单位为计价 Mint 最小单位。 / Lending position book value after accrued interest and recognized bad debt, in quote mint base units.';
COMMENT ON COLUMN vault_snapshot.lending_withdrawable_raw IS '当前可从借贷池提取的金额，单位为计价 Mint 最小单位。 / Amount currently withdrawable from the lending pool, in quote mint base units.';
COMMENT ON COLUMN vault_snapshot.nav_raw IS '金库现金、策略估值和出借价值之和，单位为计价 Mint 最小单位。策略估值为空时为空。 / Sum of vault cash, strategy value and lending value in quote mint base units. Null if strategy value is unavailable.';
COMMENT ON COLUMN vault_snapshot.total_shares_raw IS '当前已发行的份额总量，单位为份额 Mint 最小单位。 / Current outstanding share supply in base units of the share mint.';

CREATE TABLE lending_market_snapshot (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    market_address varchar(44) NOT NULL,
    slot numeric(20,0) NOT NULL CHECK (slot BETWEEN 0 AND 18446744073709551615),
    observed_at timestamptz NOT NULL DEFAULT now(),
    cash_raw numeric(20,0) NOT NULL CHECK (cash_raw BETWEEN 0 AND 18446744073709551615),
    available_to_borrow_raw numeric(39,0) NOT NULL CHECK (available_to_borrow_raw >= 0 AND available_to_borrow_raw <> 'NaN'::numeric),
    total_debt_raw numeric(39,0) NOT NULL CHECK (total_debt_raw >= 0 AND total_debt_raw <> 'NaN'::numeric),
    supply_rate_bps integer NOT NULL CHECK (supply_rate_bps >= 0),
    borrow_rate_bps integer NOT NULL CHECK (borrow_rate_bps >= 0),
    utilization_bps integer NOT NULL CHECK (utilization_bps BETWEEN 0 AND 10000),
    borrow_ltv_bps integer NOT NULL CHECK (borrow_ltv_bps BETWEEN 0 AND 10000),
    liquidation_threshold_bps integer NOT NULL CHECK (liquidation_threshold_bps BETWEEN 1 AND 10000),
    oracle_address varchar(44),
    oracle_collateral_mint varchar(44),
    oracle_debt_mint varchar(44),
    oracle_price_numerator numeric(39,0),
    oracle_price_denominator numeric(39,0),
    oracle_slot numeric(20,0),
    oracle_published_at timestamptz,
    oracle_price_version varchar(64),
    risk_batch_published boolean NOT NULL DEFAULT false,
    PRIMARY KEY (network, market_address, slot),
    FOREIGN KEY (network, market_address)
        REFERENCES lending_market (network, market_address),
    CHECK (available_to_borrow_raw <= cash_raw),
    CHECK (borrow_ltv_bps < liquidation_threshold_bps),
    -- 有值时报价为正，发布时间和 slot 不晚于快照观测。 / When present, prices are positive and publication time and slot do not exceed the observation.
    CONSTRAINT lending_market_snapshot_oracle_values_ck CHECK (
        (oracle_price_numerator > 0 AND oracle_price_numerator <> 'NaN'::numeric)
        AND (oracle_price_denominator > 0 AND oracle_price_denominator <> 'NaN'::numeric)
        AND (oracle_slot BETWEEN 0 AND 18446744073709551615 AND oracle_slot <= slot)
        AND (isfinite(oracle_published_at) AND oracle_published_at <= observed_at)
        AND oracle_price_version ~ '^[0-9a-f]{64}$'
    ),
    -- 只在批次完成且报价字段齐全时标记已发布。 / Mark the batch published only when complete and all quote fields are present.
    CONSTRAINT lending_market_snapshot_risk_publication_ck CHECK (
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
    )
);

COMMENT ON TABLE lending_market_snapshot IS '借贷市场在某一最终确认观测 slot 的资金池状态、报价及风险批次信息。 / Market pool state, quote and risk batch information at a finalized observation slot.';
COMMENT ON COLUMN lending_market_snapshot.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN lending_market_snapshot.market_address IS '链上借贷市场状态账户地址。 / On-chain lending market state account address.';
COMMENT ON COLUMN lending_market_snapshot.slot IS 'RPC 读取市场与计算输入所处的最终确认观测 slot。 / Finalized RPC observation slot of the market and calculation inputs.';
COMMENT ON COLUMN lending_market_snapshot.observed_at IS '索引器取得该快照的时间，API 统一输出 UTC。 / Time the indexer obtained the snapshot. The API emits UTC.';
COMMENT ON COLUMN lending_market_snapshot.cash_raw IS '池内现金余额，单位为借款 Mint 最小单位。 / Pool cash balance in debt mint base units.';
COMMENT ON COLUMN lending_market_snapshot.available_to_borrow_raw IS '应用市场级限制后的可借金额，单位为借款 Mint 最小单位。 / Amount available to borrow after market-level limits, in debt mint base units.';
COMMENT ON COLUMN lending_market_snapshot.total_debt_raw IS '计息后未偿且未核销的总债务，单位为借款 Mint 最小单位。 / Accrued outstanding debt excluding write-offs, in debt mint base units.';
COMMENT ON COLUMN lending_market_snapshot.supply_rate_bps IS '按基点表示的出借年化利率。 / Annualized supply rate in basis points.';
COMMENT ON COLUMN lending_market_snapshot.borrow_rate_bps IS '按基点表示的借款年化利率。 / Annualized borrow rate in basis points.';
COMMENT ON COLUMN lending_market_snapshot.utilization_bps IS '按基点表示的资金利用率。 / Pool utilization in basis points.';
COMMENT ON COLUMN lending_market_snapshot.borrow_ltv_bps IS '按基点表示的借款 LTV 上限。 / Maximum borrowing loan-to-value ratio in basis points.';
COMMENT ON COLUMN lending_market_snapshot.liquidation_threshold_bps IS '按基点表示、用于计算健康度的清算阈值。 / Liquidation threshold used to calculate health, in basis points.';
COMMENT ON COLUMN lending_market_snapshot.oracle_address IS '读取原始报价的价格源账户地址。 / Price feed account address from which the original quote was read.';
COMMENT ON COLUMN lending_market_snapshot.oracle_collateral_mint IS '报价的抵押资产 Mint 地址。 / Collateral asset mint address in the quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_debt_mint IS '报价的债务资产 Mint 地址。 / Debt asset mint address in the quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_price_numerator IS '每整单位抵押资产所值整单位债务资产的报价分子。 / Numerator of the whole debt tokens per whole collateral token price ratio.';
COMMENT ON COLUMN lending_market_snapshot.oracle_price_denominator IS '每整单位抵押资产所值整单位债务资产的报价分母。 / Denominator of the whole debt tokens per whole collateral token price ratio.';
COMMENT ON COLUMN lending_market_snapshot.oracle_slot IS '预言机原始报价的链上发布 slot。 / On-chain publication slot of the original oracle quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_published_at IS '预言机原始报价的发布时间。 / Publication time of the original oracle quote.';
COMMENT ON COLUMN lending_market_snapshot.oracle_price_version IS '该批次所用报价的 64 字符小写十六进制版本。 / The 64-character lowercase hexadecimal version of the quote used by this batch.';
COMMENT ON COLUMN lending_market_snapshot.risk_batch_published IS '索引器已完整发布该 slot 的风险批次时为 true。 / True once the indexer publishes the complete risk batch for this slot.';

CREATE TABLE vault_position_snapshot (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    vault_address varchar(44) NOT NULL,
    wallet_address varchar(44) NOT NULL,
    slot numeric(20,0) NOT NULL CHECK (slot BETWEEN 0 AND 18446744073709551615),
    observed_at timestamptz NOT NULL DEFAULT now(),
    shares_raw numeric(20,0) NOT NULL CHECK (shares_raw BETWEEN 0 AND 18446744073709551615),
    position_value_raw numeric(39,0) CHECK (position_value_raw >= 0 AND position_value_raw <> 'NaN'::numeric),
    redeemable_raw numeric(39,0) CHECK (redeemable_raw >= 0 AND redeemable_raw <> 'NaN'::numeric),
    PRIMARY KEY (network, vault_address, wallet_address, slot),
    FOREIGN KEY (network, vault_address)
        REFERENCES vault (network, vault_address),
    CHECK ((position_value_raw IS NULL) = (redeemable_raw IS NULL)),
    CHECK (redeemable_raw <= position_value_raw)
);

COMMENT ON TABLE vault_position_snapshot IS '一个链上持有人在指定金库和观测 slot 的份额、估值和可赎回额度。 / Shares, valuation and redeemable amount for one on-chain holder, vault and observation slot.';
COMMENT ON COLUMN vault_position_snapshot.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN vault_position_snapshot.vault_address IS '链上金库状态账户地址。 / On-chain vault state account address.';
COMMENT ON COLUMN vault_position_snapshot.wallet_address IS '持有金库份额的链上账户所有者地址。 / On-chain owner address holding the vault shares.';
COMMENT ON COLUMN vault_position_snapshot.slot IS 'RPC 读取该份额仓位与估值输入所处的最终确认观测 slot。 / Finalized RPC observation slot of the share position and valuation inputs.';
COMMENT ON COLUMN vault_position_snapshot.observed_at IS '索引器取得该快照的时间，API 统一输出 UTC。 / Time the indexer obtained the snapshot. The API emits UTC.';
COMMENT ON COLUMN vault_position_snapshot.shares_raw IS '已持有的份额，单位为份额 Mint 最小单位。 / Shares held in base units of the share mint.';
COMMENT ON COLUMN vault_position_snapshot.position_value_raw IS '该持有人的份额价值，单位为计价 Mint 最小单位。需要估值且估值不可用时为空。 / Value of the shares in quote mint base units. Null when a required valuation is unavailable.';
COMMENT ON COLUMN vault_position_snapshot.redeemable_raw IS '该持有人的当前可赎回额上限，单位为计价 Mint 最小单位。需要估值且估值不可用时为空。 / Current redemption value ceiling in quote mint base units. Null when a required valuation is unavailable.';

CREATE TABLE lending_position_snapshot (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    market_address varchar(44) NOT NULL,
    wallet_address varchar(44) NOT NULL,
    slot numeric(20,0) NOT NULL CHECK (slot BETWEEN 0 AND 18446744073709551615),
    observed_at timestamptz NOT NULL DEFAULT now(),
    oracle_slot numeric(20,0) CHECK (oracle_slot BETWEEN 0 AND 18446744073709551615),
    supply_shares_raw numeric(20,0) NOT NULL CHECK (supply_shares_raw BETWEEN 0 AND 18446744073709551615),
    supplied_value_raw numeric(39,0) NOT NULL CHECK (supplied_value_raw >= 0 AND supplied_value_raw <> 'NaN'::numeric),
    collateral_raw numeric(20,0) NOT NULL CHECK (collateral_raw BETWEEN 0 AND 18446744073709551615),
    debt_raw numeric(39,0) NOT NULL CHECK (debt_raw >= 0 AND debt_raw <> 'NaN'::numeric),
    health_factor numeric(51,12) CHECK (health_factor >= 0 AND health_factor <> 'NaN'::numeric),
    is_liquidatable boolean,
    oracle_price_version varchar(64),
    PRIMARY KEY (network, market_address, wallet_address, slot),
    FOREIGN KEY (network, market_address)
        REFERENCES lending_market (network, market_address),
    CHECK (
        (debt_raw = 0 AND health_factor IS NULL AND is_liquidatable IS FALSE)
        OR (
            debt_raw > 0 AND (
                (oracle_slot IS NULL AND health_factor IS NULL AND is_liquidatable IS NULL)
                OR (oracle_slot IS NOT NULL AND health_factor IS NOT NULL AND is_liquidatable IS NOT NULL)
            )
        )
    ),
    CHECK (oracle_slot <= slot),
    -- 记录报价版本时必须保留相应的历史预言机 slot。 / A price version requires the corresponding historical oracle slot.
    CONSTRAINT lending_position_snapshot_oracle_version_ck CHECK (
        oracle_price_version IS NULL
        OR (oracle_slot IS NOT NULL AND oracle_price_version ~ '^[0-9a-f]{64}$')
    )
);

COMMENT ON TABLE lending_position_snapshot IS '一个市场参与者在某一观测 slot 的供给、抵押、欠款和风险状态。 / Supply, collateral, debt and risk observed for one market participant at a given slot.';
COMMENT ON COLUMN lending_position_snapshot.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN lending_position_snapshot.market_address IS '链上借贷市场状态账户地址。 / On-chain lending market state account address.';
COMMENT ON COLUMN lending_position_snapshot.wallet_address IS '仓位所属的出借人、借款人或供给资金的金库 PDA 地址。 / Owner address of the supplier, borrower or vault PDA supplying funds.';
COMMENT ON COLUMN lending_position_snapshot.slot IS 'RPC 读取该仓位及其计算输入所处的最终确认观测 slot。 / Finalized RPC observation slot of the position and calculation inputs.';
COMMENT ON COLUMN lending_position_snapshot.observed_at IS '索引器取得该快照的时间，API 统一输出 UTC。 / Time the indexer obtained the snapshot. The API emits UTC.';
COMMENT ON COLUMN lending_position_snapshot.oracle_slot IS '使用的预言机发布 slot。未取得可用价格时为空。 / Publish slot of the oracle price used. Null when a usable price is unavailable.';
COMMENT ON COLUMN lending_position_snapshot.supply_shares_raw IS '持有的借贷池份额原始单位数量，依据借贷程序的份额精度。 / Lending pool shares held in the internal raw units defined by the lending program.';
COMMENT ON COLUMN lending_position_snapshot.supplied_value_raw IS '供给份额对应的账面资产价值，单位为借款 Mint 最小单位。 / Book value of supplied shares in debt mint base units.';
COMMENT ON COLUMN lending_position_snapshot.collateral_raw IS '当前托管抵押品的数量，单位为抵押 Mint 最小单位。 / Collateral held in custody, in collateral mint base units.';
COMMENT ON COLUMN lending_position_snapshot.debt_raw IS '当前计息后的未偿债务，单位为借款 Mint 最小单位。 / Current outstanding debt with accrued interest, in debt mint base units.';
COMMENT ON COLUMN lending_position_snapshot.health_factor IS '无量纲健康度，展示精度为 12 位小数。无债务或需用的价格无效时为空。 / Dimensionless health factor displayed to 12 decimals. Null when debt is zero or a required price is unusable.';
COMMENT ON COLUMN lending_position_snapshot.is_liquidatable IS '按完整精度评估的清算资格。无债务为 false，有债务但价格不可用时为空。 / Liquidation eligibility evaluated at full precision. False for zero debt and null if debt exists but its price input is unavailable.';
COMMENT ON COLUMN lending_position_snapshot.oracle_price_version IS '计算该仓位健康度所用报价的 64 字符小写十六进制版本。旧仓位或无可用报价时为空。 / The 64-character lowercase hexadecimal version of the quote used for position health, null for legacy positions or when no usable quote exists.';

-- 可选风险提示 / Optional phase 3 risk alerts

CREATE TABLE risk_alert (
    network varchar(16) NOT NULL CHECK (network IN ('localnet', 'devnet')),
    market_address varchar(44) NOT NULL,
    wallet_address varchar(44) NOT NULL,
    slot numeric(20,0) NOT NULL CHECK (slot BETWEEN 0 AND 18446744073709551615),
    alert_type varchar(24) NOT NULL CHECK (alert_type IN ('LOW_HEALTH', 'LIQUIDATABLE')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network, market_address, wallet_address, slot, alert_type),
    FOREIGN KEY (network, market_address, wallet_address, slot)
        REFERENCES lending_position_snapshot (network, market_address, wallet_address, slot)
);

COMMENT ON TABLE risk_alert IS '风险规则命中的一条记录，保留触发它的借贷仓位快照。 / A risk rule hit retaining the lending position snapshot that triggered it.';
COMMENT ON COLUMN risk_alert.network IS 'Solana 网络，限 localnet 和 devnet。 / Solana network, either localnet or devnet.';
COMMENT ON COLUMN risk_alert.market_address IS '链上借贷市场状态账户地址。 / On-chain lending market state account address.';
COMMENT ON COLUMN risk_alert.wallet_address IS '被提示风险的借贷仓位所有者地址。 / Owner address of the lending position flagged by the rule.';
COMMENT ON COLUMN risk_alert.slot IS '触发规则的借贷仓位快照观测 slot。 / Observation slot of the lending position snapshot that triggered the rule.';
COMMENT ON COLUMN risk_alert.alert_type IS '风险规则代码，当前为 LOW_HEALTH 或 LIQUIDATABLE。 / Risk rule code, currently LOW_HEALTH or LIQUIDATABLE.';
COMMENT ON COLUMN risk_alert.created_at IS '该规则命中首次记录的时间。 / Time this rule hit was first recorded.';

-- 为活动筛选和风险历史的读取顺序提供索引。
-- Index activity filters and the read order for risk history.

CREATE INDEX chain_transaction_feed_idx
    ON chain_transaction (network, slot DESC, signature DESC);
COMMENT ON INDEX chain_transaction_feed_idx IS '按网络和游标顺序读取交易活动。 / Read transaction activity in network and cursor order.';

CREATE INDEX chain_event_type_feed_idx
    ON chain_event (network, event_type, signature, event_index);
COMMENT ON INDEX chain_event_type_feed_idx IS '按业务类型筛选事件并关联父交易。 / Filter events by business type and join their parent transaction.';

CREATE INDEX chain_event_participant_wallet_idx
    ON chain_event_participant (network, wallet_address, signature, event_index);
COMMENT ON INDEX chain_event_participant_wallet_idx IS '按任一业务参与钱包定位事件。 / Locate events by any participating wallet.';

CREATE INDEX risk_alert_wallet_feed_idx
    ON risk_alert (network, wallet_address, slot DESC, market_address, alert_type);
COMMENT ON INDEX risk_alert_wallet_feed_idx IS '按网络和钱包读取风险命中历史。 / Read risk hits by network and wallet.';

-- 固定市场风险观测 slot 后按健康度和钱包地址续页。
-- Seek by health factor and wallet address within the observed market risk slot.
CREATE INDEX lending_position_snapshot_liquidation_order_idx
    ON lending_position_snapshot (network, market_address, slot, health_factor, wallet_address)
    WHERE health_factor IS NOT NULL;
COMMENT ON INDEX lending_position_snapshot_liquidation_order_idx IS '清算市场按观测 slot、健康度及钱包地址分页。 / Page liquidation market candidates by observation slot, health factor and wallet address.';

COMMIT;
