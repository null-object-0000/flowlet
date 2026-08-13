use super::AgentSessionAdapter;

mod claude_code;
mod codex;
mod deepseek_harness;
mod opencode;
mod pi;

static CLAUDE_CODE: claude_code::ClaudeCodeSessionAdapter = claude_code::ClaudeCodeSessionAdapter;
static OPENCODE: opencode::OpenCodeSessionAdapter = opencode::OpenCodeSessionAdapter;
static PI: pi::PiSessionAdapter = pi::PiSessionAdapter;
static CODEX: codex::CodexSessionAdapter = codex::CodexSessionAdapter;
static DEEPSEEK_HARNESS: deepseek_harness::DeepSeekHarnessSessionAdapter =
    deepseek_harness::DeepSeekHarnessSessionAdapter;

pub(super) static ADAPTERS: [&'static dyn AgentSessionAdapter; 5] =
    [&CLAUDE_CODE, &OPENCODE, &PI, &CODEX, &DEEPSEEK_HARNESS];
