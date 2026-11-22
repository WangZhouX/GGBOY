/** 页面 URL 由导航和路由定义共同使用。 Page URLs shared by navigation and route definitions. */
export const paths = {
  overview: '/overview',
  vault: '/vault',
  lending: '/lend',
  borrow: '/lend/borrow',
  supply: '/lend/supply',
  liquidations: '/lend/liquidations',
  strategy: '/strategy',
  activity: '/activity',
  activityReceipt: '/activity/:signature/events/:eventIndex',
} as const;

/** 布局导航和资产总览使用的业务入口。 Business destinations shown in the layout and overview. */
export const primaryPages = ['overview', 'vault', 'lending', 'strategy', 'activity'] as const;
