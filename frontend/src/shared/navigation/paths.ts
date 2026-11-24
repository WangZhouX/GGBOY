/** 页面 URL 由导航和路由定义共同使用。 Page URLs shared by navigation and route definitions. */
export const paths = {
  overview: '/overview',
  vault: '/vault',
  vaultDeposit: '/vault/deposit',
  vaultRedeem: '/vault/redeem',
  lending: '/lend',
  borrow: '/lend/borrow',
  /** 四个借款操作共用一个交易页，由 action 选择业务。 Four borrowing operations share a page selected by the action route segment. */
  borrowOperation: '/lend/borrow/:action',
  supply: '/lend/supply',
  supplyDeposit: '/lend/supply/deposit',
  /** 提取和出借使用各自的 URL 与交易状态。 Withdrawals and deposits use separate URLs and transaction state. */
  supplyWithdrawal: '/lend/supply/withdraw',
  liquidations: '/lend/liquidations',
  strategy: '/strategy',
  activity: '/activity',
  activityReceipt: '/activity/:signature/events/:eventIndex',
} as const;

/** 布局导航和资产总览使用的业务入口。 Business destinations shown in the layout and overview. */
export const primaryPages = ['overview', 'vault', 'lending', 'strategy', 'activity'] as const;
