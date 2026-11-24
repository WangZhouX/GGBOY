-- 登记已核对的 GGBOY Devnet 借贷市场。执行前核对链上的 PDA、Mint 和托管绑定。
-- Register the verified GGBOY Devnet lending market. Verify the PDA, mints, and custody bindings on-chain before running.
DO $registration$
DECLARE
    -- 独立借贷部署的网络、程序、状态账户与资产 Mint 均使用链上的公开地址。
    -- The network, program, state account, and asset mints identify the verified public deployment.
    deployment_network CONSTANT varchar(16) := 'devnet';
    lending_program CONSTANT varchar(44) := '8cxYWp74a83XZMEDMMdiRPAcvWcCkajMwpCSGehoQu4H';
    market_state CONSTANT varchar(44) := 'HzzMy19zYvQ6ZKfEgeMwuin3eMp8RFBWeRar9vzncUvE';
    settlement_mint CONSTANT varchar(44) := '62vB22oh8fjXtitpKX3nLKyk9J7CVKb4ueKZcDGP1o1X';
    collateral_mint_address CONSTANT varchar(44) := 'AfJQ7YcnvUDncihfh9NoeF41Bw6eiB1eFcubmdw9fAg1';
    -- 两枚 Mint 由原版 SPL Token Program 持有，精度分别由链上 Mint 验证。
    -- Both mints are owned by the original SPL Token Program. Their precision is verified on-chain.
    token_program CONSTANT varchar(44) := 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    debt_decimals CONSTANT smallint := 6;
    collateral_decimals CONSTANT smallint := 9;
BEGIN
    -- 先登记 Mint，满足市场表的网络与 Mint 组合外键。
    -- Register the mints first to satisfy the market table's network and mint foreign keys.
    INSERT INTO public.asset_mint (network, mint_address, symbol, decimals, program_id)
    VALUES
        (deployment_network, settlement_mint, 'mockUSDC', debt_decimals, token_program),
        (deployment_network, collateral_mint_address, 'tSOL', collateral_decimals, token_program)
    ON CONFLICT (network, mint_address) DO NOTHING;

    -- 重跑只接受相同的归属、精度和展示名称，避免覆盖已登记资产。
    -- An exact rerun requires the same ownership, precision, and display names while preserving registered assets.
    IF (
        SELECT count(*)
        FROM public.asset_mint AS mint
        WHERE mint.network = deployment_network
          AND mint.program_id = token_program
          AND (
              (mint.mint_address = settlement_mint AND mint.symbol = 'mockUSDC' AND mint.decimals = debt_decimals)
              OR (mint.mint_address = collateral_mint_address AND mint.symbol = 'tSOL' AND mint.decimals = collateral_decimals)
          )
    ) <> 2 THEN
        RAISE EXCEPTION 'Existing Devnet lending mint metadata conflicts with this registration';
    END IF;

    -- 初始化阶段未配置预言机。仅登记市场绑定，市场观测由链上采集产生。
    -- Initialization has no oracle configuration. Register the market bindings. Pool observations come from chain reads.
    INSERT INTO public.lending_market (network, market_address, program_id, debt_mint, collateral_mint)
    VALUES (deployment_network, market_state, lending_program, settlement_mint, collateral_mint_address)
    ON CONFLICT (network, market_address) DO NOTHING;

    -- 配置冲突会回滚整次登记。重跑保留后来写入的可选预言机配置。
    -- Conflicts roll back the whole registration. Reruns preserve any optional oracle configuration added later.
    IF NOT EXISTS (
        SELECT 1 FROM public.lending_market AS market
        WHERE market.network = deployment_network
          AND market.market_address = market_state
          AND market.program_id = lending_program
          AND market.debt_mint = settlement_mint
          AND market.collateral_mint = collateral_mint_address
    ) THEN
        RAISE EXCEPTION 'Existing Devnet lending market configuration conflicts with this registration';
    END IF;
END;
$registration$;
