//! Tauri command facade.
//!
//! Commands remain re-exported at `commands::command_name`, so the invoke
//! registry and frontend command strings stay stable while implementations are
//! grouped by domain.

mod account_workspace;
mod agent;
mod channels;
mod device_sync;
mod maintenance;
mod observability;
mod projects;
mod proxy;
mod scrape;
mod usage;

pub(super) use account_workspace::*;
pub(super) use agent::*;
pub(super) use channels::*;
pub(super) use device_sync::*;
pub(super) use maintenance::*;
pub(super) use observability::*;
pub(super) use projects::*;
pub(super) use proxy::*;
pub(super) use scrape::*;
pub(super) use usage::*;
