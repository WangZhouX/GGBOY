/** 页面、导航和界面状态的简体中文与英文文案。 Simplified Chinese and English copy for pages, navigation, and interface states. */
export const messages = {
  'zh-CN': {
    translation: {
      layout: {
        navigation: '主导航',
        skipToContent: '跳到正文',
        language: '语言',
        network: '网络',
      },
      network: {
        localnet: 'Localnet',
        devnet: 'Devnet',
      },
      pages: {
        overview: { title: '资产总览', description: '浏览策略金库、借贷市场与交易活动。' },
        vault: { title: '策略金库', description: '在这里查看金库概况、净值走势和钱包份额。金库数据将在接口联调阶段接入。' },
        lending: { title: '借贷市场', description: '进入借款、出借或清算页面。资金池概况将在接口联调阶段接入。' },
        borrow: { title: '我的借款', description: '抵押资产、债务和仓位健康度将在借贷仓位接口接入后显示。' },
        supply: { title: '我的出借', description: '出借仓位和可提取金额将在借贷仓位接口接入后显示。' },
        liquidations: { title: '清算市场', description: '当可清算仓位接口接入后，这里按健康度展示候选仓位。' },
        strategy: { title: '策略管理', description: '这里将展示金库资金分配、策略操作额度和最近策略交易。' },
        activity: { title: '交易活动', description: '活动列表接入后可以按业务类型筛选、翻页并打开交易回执。' },
        receipt: { title: '交易回执', description: '链接参数已读取。完整回执将在接口联调阶段接入。' },
        notFound: { title: '页面不存在', description: '请返回资产总览，从导航选择要浏览的页面。' },
      },
      overview: {
        section: '业务入口',
        vault: '查看金库概况、资产净值和钱包份额。',
        lending: '浏览资金池、借款和出借仓位。',
        strategy: '查看金库资金的策略分配。',
        activity: '浏览业务事件和交易回执。',
      },
      lending: { navigation: '借贷市场子页面', overview: '市场概况' },
      receipt: { signature: '交易签名', eventIndex: '事件序号', back: '返回交易活动' },
      actions: { backToOverview: '返回资产总览' },
    },
  },
  en: {
    translation: {
      layout: {
        navigation: 'Main navigation',
        skipToContent: 'Skip to content',
        language: 'Language',
        network: 'Network',
      },
      network: {
        localnet: 'Localnet',
        devnet: 'Devnet',
      },
      pages: {
        overview: { title: 'Portfolio overview', description: 'Browse the strategy vault, lending market, and transaction activity.' },
        vault: { title: 'Strategy vault', description: 'Find the vault overview, NAV history, and wallet shares here when the vault API is connected.' },
        lending: { title: 'Lending market', description: 'Open borrowing, supplying, or liquidations. Pool data will appear when the market API is connected.' },
        borrow: { title: 'My borrowing', description: 'Collateral, debt, and position health will appear when the lending position API is connected.' },
        supply: { title: 'My supply', description: 'Your supplied position and withdrawable amount will appear when the lending position API is connected.' },
        liquidations: { title: 'Liquidation market', description: 'Liquidation candidates will be ordered by position health when their API is connected.' },
        strategy: { title: 'Strategy management', description: 'Review vault allocations, operation limits, and recent strategy transactions here.' },
        activity: { title: 'Transaction activity', description: 'Filter and page through events, then open their receipts when the activity API is connected.' },
        receipt: { title: 'Transaction receipt', description: 'The link parameters were read. The full receipt will appear when its API is connected.' },
        notFound: { title: 'Page not found', description: 'Return to the portfolio overview to choose a destination.' },
      },
      overview: {
        section: 'Explore GGBOY',
        vault: 'See vault balances, net asset value, and wallet shares.',
        lending: 'Browse pools, borrowing, and supplied positions.',
        strategy: 'See how the vault allocates its funds.',
        activity: 'Browse business events and transaction receipts.',
      },
      lending: { navigation: 'Lending market pages', overview: 'Market overview' },
      receipt: { signature: 'Transaction signature', eventIndex: 'Event index', back: 'Back to activity' },
      actions: { backToOverview: 'Back to portfolio overview' },
    },
  },
} as const;
