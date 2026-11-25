-- 允许清算回执保存借款资产的账面坏账损失。 Allow liquidation receipts to store book losses in the debt asset.
ALTER TABLE chain_event_asset
    DROP CONSTRAINT chain_event_asset_leg_type_check;

ALTER TABLE chain_event_asset
    ADD CONSTRAINT chain_event_asset_leg_type_check
    CHECK (leg_type IN ('ASSET_IN', 'ASSET_OUT', 'SHARES_MINTED', 'SHARES_BURNED', 'DEBT_REPAID', 'COLLATERAL_SEIZED', 'BAD_DEBT'));

COMMENT ON TABLE chain_event_asset IS '事件中的一项资产变动或坏账核销，保存当时的 Mint 和精度。 / One asset movement or bad debt write-off in an event, including its mint and precision at the time.';
COMMENT ON COLUMN chain_event_asset.amount_raw IS '转账或账面损失的金额，使用对应代币的最小单位。 / Amount transferred or written off in base units of the associated token.';
COMMENT ON COLUMN chain_event_asset.leg_type IS '转账或核销的业务语义。BAD_DEBT 表示借款资产账面损失。 / Business meaning of the transfer or write-off. BAD_DEBT represents a book loss in the debt asset.';
