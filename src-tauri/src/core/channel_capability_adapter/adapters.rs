use super::ChannelCapabilityAdapter;

mod custom;
mod deepseek;
mod kimi;
mod longcat;
mod openai_api;
mod openrouter;
mod qwen;
mod vibetoken;
mod zhipu;

pub(super) static ADAPTERS: &[ChannelCapabilityAdapter] = &[
    openai_api::ADAPTER,
    longcat::ADAPTER,
    deepseek::ADAPTER,
    kimi::ADAPTER,
    qwen::ADAPTER,
    custom::ADAPTER,
    zhipu::ADAPTER,
    openrouter::ADAPTER,
    vibetoken::ADAPTER,
];
