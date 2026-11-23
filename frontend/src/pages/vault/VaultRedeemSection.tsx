import { VaultTransactionSection, type VaultTransactionSectionProps } from './VaultTransactionSection';

/**
 * 展示纯现金金库的赎回表单。
 * Render the cash-vault redemption form.
 */
export function VaultRedeemSection(props: VaultTransactionSectionProps) {
  return <VaultTransactionSection {...props} action="redeem" />;
}
