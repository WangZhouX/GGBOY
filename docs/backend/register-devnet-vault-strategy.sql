-- 先用 initialize-vault-strategy.mjs 核对链上启用状态和 Mint 绑定，再登记已启用的策略金库。
-- Run after initialize-vault-strategy.mjs verifies activation and mint bindings on-chain.
DO $registration$
DECLARE
    -- 当前 GGBOY Devnet 的公开金库、借贷市场和代币地址。
    -- Public vault, lending market, and token addresses for the GGBOY Devnet deployment.
    vault_address_to_register CONSTANT varchar(44) := 'FnumrXNQLu5t1tLE9xJaVZiqGuDw5iyfQpo18j25ztP9';
    vault_program CONSTANT varchar(44) := 'FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75';
    market_address_to_register CONSTANT varchar(44) := 'HzzMy19zYvQ6ZKfEgeMwuin3eMp8RFBWeRar9vzncUvE';
    lending_program CONSTANT varchar(44) := '8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H';
    settlement_mint CONSTANT varchar(44) := '62vB22oh8fjXtitpKX3nLKyk9J7CVKb4ueKZcDGP1o1X';
    strategy_asset CONSTANT varchar(44) := 'AfJQ7YcnvUDncihfh9NoeF41Bw6eiB1eFcubmdw9fAg1';
BEGIN
    -- 借贷市场必须已登记，且与金库的策略和结算资产相匹配。
    -- The lending market must be registered with the same strategy and settlement mints.
    IF NOT EXISTS (
        SELECT 1
        FROM public.lending_market
        WHERE network = 'devnet'
          AND market_address = market_address_to_register
          AND program_id = lending_program
          AND debt_mint = settlement_mint
          AND collateral_mint = strategy_asset
    ) THEN
        RAISE EXCEPTION 'Devnet strategy lending market is missing or conflicts with this registration';
    END IF;

    -- 只更新原有纯现金登记，或接受已绑定相同策略的重跑。
    -- Update only the original cash-vault registration or accept an exact replay.
    UPDATE public.vault
    SET strategy_mint = strategy_asset,
        lending_market_address = market_address_to_register
    WHERE network = 'devnet'
      AND vault_address = vault_address_to_register
      AND program_id = vault_program
      AND quote_mint = settlement_mint
      AND (
          (strategy_mint IS NULL AND lending_market_address IS NULL)
          OR (strategy_mint = strategy_asset AND lending_market_address = market_address_to_register)
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Devnet vault is missing or conflicts with this strategy registration';
    END IF;
END;
$registration$;
