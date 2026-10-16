# AGENTS.md

Guidance for coding agents working in this directory. Refer to the root `../AGENTS.md` for repository-wide structure and commands.

## OpenAI Agents SDK specifics

**Agents (`agent/agent.js`)** are two `Agent`s with pinned models: a routing `requestAgent` (`gpt-6-luna`) whose only tool is `create_code_channel`, and the coding `agent` (`gpt-6.1-sol`) with every other tool. Tools are `tool()` definitions with zod parameters, one per file under `agent/tools/`, that read the run context (`AgentDeps` or `RequestDeps`, both in `agent/sessions.js`) for the Slack client and session. Optional arguments are `.nullable()`, since the SDK's strict schemas require every field. Both agents set `modelSettings: { truncation: 'auto' }`, so a long session drops its oldest conversation instead of outgrowing the context window.

**Runs** use `await run()` from Bolt listeners. Coding turns allow `MAX_TURNS` model calls, and a turn that uses them all ends with a message through the SDK's `maxTurns` error handler, so its history is kept. Each agent's `toolUseBehavior` ends the run early once there's nothing left to do: after `create_code_channel` succeeds for the routing agent, and after `archive_channel` for the coding agent.

**Turns** go through `agent/turns.js`, which doesn't import the SDK. A turn that throws posts a warning and moves the session back to `active`, keeping the history from the last finished turn. Model-written replies use `markdown_text`, since the model writes standard markdown.

**Tool errors.** Every tool sets `toolFailed` from `agent/guardrails.js` as its `errorFunction`, so a tool that throws tells the model what went wrong instead of the SDK's fixed message. A Slack API error a tool expects, a `WebAPIPlatformError`, is returned to the model as the tool's result.

**Stopping** sets `session.stopped`, and so does archiving the channel from Slack. Every code channel tool lists the `sessionStopped` tool input guardrail (`agent/guardrails.js`), which skips the call and tells the model to wrap up, and the turn posts nothing when it finishes.

**Conversation history** comes from `result.history` and is stored on the `CodeChannelSession` (`agent/sessions.js`), keyed by code channel. Follow-up turns pass `[...session.history, { role: 'user', content: text }]`.

**Command approvals.** `runCommandNeedsApproval` in `agent/guardrails.js` wraps `commandNeedsApproval()` from `agent/approvals.js` in the SDK's `needsApproval` hook for `run_command`. A paused run is a `PausedRun` (the `RunState` and its `RunToolApprovalItem`), parked in `pendingStore` with the ts of its Approve/Deny message, so a click only resumes the run its buttons were posted for. A newer message in the channel retires a pending approval, so a late click can't resume an older run over it.

## Testing

Tests use Node's test runner (`node --test`) and fake the Slack client with `fakeClient()` from `tests/helpers.js`, which mirrors the real client's methods. Listener tests stand in for the agent's runs with `t.mock.method(runs, 'startRun', ...)`. `tests/agent/runs.test.js` runs the real agents against `tests/fake-model.js`, a `Model` that returns scripted tool calls and replies, so the SDK seams are tested without calling OpenAI.
