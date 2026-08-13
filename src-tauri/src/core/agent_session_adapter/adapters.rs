use super::AgentSessionAdapter;

mod claude_code;
mod codex;
mod opencode;
mod pi;

static CLAUDE_CODE: claude_code::ClaudeCodeSessionAdapter = claude_code::ClaudeCodeSessionAdapter;
static OPENCODE: opencode::OpenCodeSessionAdapter = opencode::OpenCodeSessionAdapter;
static PI: pi::PiSessionAdapter = pi::PiSessionAdapter;
static CODEX: codex::CodexSessionAdapter = codex::CodexSessionAdapter;

pub(super) static ADAPTERS: [&'static dyn AgentSessionAdapter; 4] =
    [&CLAUDE_CODE, &OPENCODE, &PI, &CODEX];
