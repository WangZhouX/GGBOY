-- 登记已验证的 GGBOY Devnet 部署。运行前先在链上核对目录中的账户绑定。
-- Register the verified GGBOY Devnet deployment. Check its account bindings on-chain before running.
DO $registration$
DECLARE
    -- Devnet 部署的金库程序、状态 PDA 和两个资产 Mint 公钥。
    -- Public keys for the Devnet vault program, state PDA, and the two mints.
    deployment_network CONSTANT varchar(16) := 'devnet';
    vault_program CONSTANT varchar(44) := 'FjDzSyVW7P349yHXmhazzz2d3wXkTdDvNYcMrC4HZK75';
    vault_state CONSTANT varchar(44) := 'FnumrXNQLu5t1tLE9xJaVZiqGuDw5iyfQpo18j25ztP9';
    settlement_mint CONSTANT varchar(44) := '62vB22oh8fjXtitpKX3nLKyk9J7CVKb4ueKZcDGP1o1X';
    shares_mint CONSTANT varchar(44) := 'J1wgRZWWpB11ZYRD1fymCzCgnWA9ZihgqtaUUVpbWVNd';
    -- 两枚 Mint 的共同代币程序和小数位数。
    -- Shared token program and decimal precision of the two mints.
    token_program CONSTANT varchar(44) := 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    mint_decimals CONSTANT smallint := 6;
BEGIN
    -- 先写两枚 Mint，满足金库表的同网络外键约束。
    -- Insert both mints first to satisfy the vault table's same-network foreign keys.
    INSERT INTO public.asset_mint (network, mint_address, symbol, decimals, program_id)
    VALUES
        (deployment_network, settlement_mint, 'mockUSDC', mint_decimals, token_program),
        (deployment_network, shares_mint, 'GG-V', mint_decimals, token_program)
    ON CONFLICT (network, mint_address) DO NOTHING;

    -- 已存在的 Mint 须与本次登记一致。冲突则回滚整次登记。
    -- Existing mints must match this registration. A conflict rolls back the entire registration.
    IF (
        SELECT count(*)
        FROM public.asset_mint
        WHERE network = deployment_network
          AND decimals = mint_decimals
          AND program_id = token_program
          AND ((mint_address = settlement_mint AND symbol = 'mockUSDC')
            OR (mint_address = shares_mint AND symbol = 'GG-V'))
    ) <> 2 THEN
        RAISE EXCEPTION 'Existing Devnet vault mint metadata conflicts with this registration';
    END IF;

    -- 此部署是纯现金金库，对应策略资产和借贷市场字段为空。
    -- This cash-only deployment has null strategy asset and lending market fields.
    INSERT INTO public.vault (network, vault_address, program_id, quote_mint, share_mint)
    VALUES (deployment_network, vault_state, vault_program, settlement_mint, shares_mint)
    ON CONFLICT (network, vault_address) DO NOTHING;

    -- 允许重复登记同一个部署，遇到不同配置时保留原记录并报错。
    -- Allow exact replays and preserve existing records when a configuration conflicts.
    IF NOT EXISTS (
        SELECT 1
        FROM public.vault
        WHERE network = deployment_network
          AND vault_address = vault_state
          AND program_id = vault_program
          AND quote_mint = settlement_mint
          AND share_mint = shares_mint
          AND strategy_mint IS NULL
          AND lending_market_address IS NULL
    ) THEN
        RAISE EXCEPTION 'Existing Devnet vault configuration conflicts with this registration';
    END IF;
END;
$registration$;
