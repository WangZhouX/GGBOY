//! 金库指令的账户约束、处理逻辑和事件。
//! Account constraints, handlers, and events for vault instructions.

pub(crate) mod deposit;
pub(crate) mod initialize;
pub(crate) mod ping;
pub(crate) mod redeem;
pub(crate) mod strategy;
pub(crate) mod strategy_lending;

// 转发指令类型、事件和 Anchor 生成的账户绑定。
// Re-export instruction types, events, and Anchor-generated account bindings.
pub use deposit::*;
pub use initialize::*;
pub use ping::*;
pub use redeem::*;
pub use strategy::*;
pub use strategy_lending::*;
