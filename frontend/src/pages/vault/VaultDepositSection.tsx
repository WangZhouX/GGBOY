import { VaultTransactionSection, type VaultTransactionSectionProps } from './VaultTransactionSection';

/**
 * 展示纯现金金库的存入表单。
 * Render the cash-vault deposit form.
 */
export function VaultDepositSection(props: VaultTransactionSectionProps) {
  return <VaultTransactionSection {...props} action="deposit" />;
}
