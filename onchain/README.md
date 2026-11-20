# GGBOY 链上程序

使用 Rust 和 Anchor 1.2.2。工作区包含两个独立程序，业务实现将使用 SPL Token。

- **策略金库**管理资产托管、份额铸销、存款、赎回和调仓。金库 PDA 通过 CPI 向借贷池供给和提取闲置资金。
- **抵押借贷市场**管理出借资金池、抵押仓位、借款、还款、计息和清算。两个程序分别管理各自的状态和资产。

Localnet 用于开发和集成测试，Devnet 用于公开演示。演示使用自铸的六位小数 `mockUSDC`、测试抵押币、测试预言机和测试兑换程序。

## 构建

在 WSL/Linux 准备 Rust、Anchor CLI 1.2.2 和 Agave/Solana CLI 4.1.2。已验证的宿主 Rust 版本为 1.100.0。进入本目录，运行以下命令。

```sh
anchor build --ignore-keys
```

成功后会在 `target/deploy/` 生成 `ggboy_vault.so` 和 `ggboy_lending.so`，在 `target/idl/` 生成对应的 JSON 接口文件。构建使用 Anchor 1.2.2 默认的 platform-tools v1.57 和 SBPF v3。初次运行需要联网下载依赖和工具链。

公开仓库记录程序公钥。单纯验证构建时用 `--ignore-keys` 跳过本地部署密钥与公开地址的一致性检查。部署自己的 Localnet 实例前，先用 `anchor keys sync` 同步本机的程序公钥，再用 `anchor build` 检查地址并重新构建。

当前两个程序各有无状态的 `ping` 指令，供构建与接口生成验收。业务逻辑和链上部署在后续实现。

[程序目录](programs/README.md)

[项目架构](../README.md) · [前端](../frontend/README.md) · [后端](../backend/README.md)
