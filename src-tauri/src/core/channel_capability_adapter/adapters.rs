use super::ChannelCapabilityAdapter;

mod custom;
mod deepseek;
mod kimi;
mod longcat;
mod openrouter;
mod qwen;
mod zhipu;

pub(super) static ADAPTERS: &[ChannelCapabilityAdapter] = &[
    longcat::ADAPTER,
    deepseek::ADAPTER,
    kimi::ADAPTER,
    qwen::ADAPTER,
    custom::ADAPTER,
    zhipu::ADAPTER,
    openrouter::ADAPTER,
];
