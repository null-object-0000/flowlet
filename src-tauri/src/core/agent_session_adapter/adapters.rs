use super::AgentSessionAdapter;

mod claude_code;
mod codex;
mod deepseek_harness;
mod hermes;
mod opencode;
mod pi;

static CLAUDE_CODE_VALUE: claude_code::ClaudeCodeSessionAdapter =
    claude_code::ClaudeCodeSessionAdapter;
static OPENCODE_VALUE: opencode::OpenCodeSessionAdapter = opencode::OpenCodeSessionAdapter;
static PI_VALUE: pi::PiSessionAdapter = pi::PiSessionAdapter;
static CODEX_VALUE: codex::CodexSessionAdapter = codex::CodexSessionAdapter;
static DEEPSEEK_HARNESS_VALUE: deepseek_harness::DeepSeekHarnessSessionAdapter =
    deepseek_harness::DeepSeekHarnessSessionAdapter;
static HERMES_VALUE: hermes::HermesSessionAdapter = hermes::HermesSessionAdapter;

pub(crate) static CLAUDE_CODE: &dyn AgentSessionAdapter = &CLAUDE_CODE_VALUE;
pub(crate) static OPENCODE: &dyn AgentSessionAdapter = &OPENCODE_VALUE;
pub(crate) static PI: &dyn AgentSessionAdapter = &PI_VALUE;
pub(crate) static CODEX: &dyn AgentSessionAdapter = &CODEX_VALUE;
pub(crate) static DEEPSEEK_HARNESS: &dyn AgentSessionAdapter = &DEEPSEEK_HARNESS_VALUE;
pub(crate) static HERMES: &dyn AgentSessionAdapter = &HERMES_VALUE;
