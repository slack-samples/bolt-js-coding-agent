# AGENTS.md

Guidance for coding agents working in this directory. Refer to the root `../AGENTS.md` for repository-wide structure and commands.

## Slack plugin

To install the Slack plugin for your coding agent, follow [Claude Code, Codex, Cursor, and Other Coding Agents](./README.md#claude-code-codex-cursor-and-other-coding-agents) in the README.

## Claude Agent SDK specifics

**Agents (`agent/agent.js`)** are two sets of `query()` options with pinned models: a routing `requestAgent` (`claude-haiku-4-5`) whose only tool is `create_code_channel`, and the coding `agent` (`claude-sonnet-5-5`) with every other tool. Tools are `tool()` definitions with zod arguments, one per file under `agent/tools/`. Each file exports a function of the run's deps (`AgentDeps` or `RequestDeps`, both in `agent/sessions.js`) that returns the tool, since the SDK calls a tool with only its arguments. Each run serves its tools with `createSdkMcpServer()`, so the model sees each as `mcp__coding-agent__<name>`. Optional arguments are `.optional()`, and the model leaves them out. Both agents set `tools: []`, `settingSources: []`, and `strictMcpConfig: true`, so they get none of Claude Code's built-in tools and none of the settings, `CLAUDE.md` files, or MCP servers on the machine. `verbatimPrompts: true` keeps an `@path` in a Slack message from reading a local file.

**Runs** call the SDK's `query()` once per run from Bolt listeners, which runs the Claude Code CLI bundled with the SDK. Coding turns allow `MAX_TURNS` model calls, and a turn that uses them all (`error_max_turns`) ends with a message, keeping its history. A `PostToolUse` hook returns `continue: false` to end the run early once there's nothing left to do: after `create_code_channel` succeeds for the routing agent, and after `archive_channel` for the coding agent. A result with `is_error` throws, so the turn posts a warning. Every run also names its MCP server in `--mcp-config`: the SDK registers the server only once the CLI starts, and resuming a deferred call looks for its tool before that.

**Turns** go through `agent/turns.js`, which doesn't import the SDK. A turn that throws posts a warning and moves the session back to `active`, keeping the history from the last finished turn. Model-written replies use `markdown_text`, since the model writes standard markdown.

**Tool errors.** A tool that throws reaches the model as an error result with the error's message, which the SDK's MCP server does for every tool. A Slack API error a tool expects, a `WebAPIPlatformError`, is returned to the model as the tool's result.

**Stopping** sets `session.stopped`, and so does archiving the channel from Slack. The `PreToolUse` hook from `gateToolCalls` (`agent/guardrails.js`) then denies every tool call and tells the model to wrap up, and the turn posts nothing when it finishes.

**Conversation history** lives in the Claude Code session transcript. `session.history` is the list of each run's result message, and the next run resumes from the last one's `session_id`.

**Command approvals.** The `PreToolUse` hook wraps `commandNeedsApproval()` from `agent/approvals.js` and returns `defer` for a `run_command` that needs approval, which ends the run with `deferred_tool_use` on its result. A paused run is a `PausedRun` (its history, ending with that result), parked in `pendingStore` with the ts of its Approve/Deny message, so a click only resumes the run its buttons were posted for. `resumeRun` resumes the session with a prompt that sends nothing: the CLI asks the hook about the waiting call again, and the hook answers with the decision. A newer message in the channel retires a pending approval, so a late click can't resume an older run over it. The next run then finds the waiting call on the last result, and the hook hands it to `answerUnanswered`, the `canUseTool` callback, which denies it as not run and interrupts that old turn, so no model call is spent on it before the new message.

## Testing

Tests use Node's test runner (`node --test`) and fake the Slack client with `fakeClient()` from `tests/helpers.js`, which mirrors the real client's methods. Listener tests stand in for the agent's runs with `t.mock.method(runs, 'startRun', ...)`, and `tests/agent/agent.test.js` stands in for the SDK with `t.mock.method(sdk, 'query', ...)`. `tests/invoke.js` calls a tool through its MCP server, the way a run does. `tests/agent/runs.test.js` runs the real agents and the bundled CLI against `tests/fake-model.js`, a local stand-in for the Anthropic Messages API that returns scripted tool calls and replies, passed to each run through the `env` option, so the SDK seams are tested without calling Anthropic.
