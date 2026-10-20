/**
 * The Claude Agent SDK side of the coding agent.
 *
 * Everything that touches the SDK lives here, in `agent/guardrails.js`, and in
 * `agent/tools/`. The turn handling in `agent/turns.js` calls only `runRequest`,
 * which returns the reply text, and `startRun` and `resumeRun`, which return a
 * `RunOutcome`.
 */

import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';

import { answerUnanswered, gateToolCalls } from './guardrails.js';
import { RunOutcome } from './outcome.js';
import { REQUEST_PROMPT, SYSTEM_PROMPT } from './prompts.js';
import {
  archiveChannel,
  cloneRepo,
  createCodeChannel,
  editFile,
  listViews,
  publishDiff,
  publishHtmlView,
  readFile,
  readPlan,
  removeView,
  renameSession,
  runCommand,
  setCommands,
  setContextBar,
  writeFile,
  writePlan,
} from './tools/index.js';

/** @typedef {import('@anthropic-ai/claude-agent-sdk').Options} Options */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKResultMessage} SDKResultMessage */
/** @typedef {import('./sessions.js').AgentDeps} AgentDeps */
/** @typedef {import('./sessions.js').RequestDeps} RequestDeps */

// Model calls allowed per turn. Coding work reads several files before editing,
// so this leaves plenty of room.
export const MAX_TURNS = 50;

// The in-process MCP server that serves the tools. The model sees each one as
// `mcp__coding-agent__<name>`.
const SERVER = 'coding-agent';

// A run that ended by interrupting, which only closing out a dropped pause does.
const INTERRUPTED = ['aborted_streaming', 'aborted_tools'];

// Only the tools each agent is given, and none of the settings, CLAUDE.md
// files, or MCP servers configured on this machine. The prompt quotes Slack
// messages, so `verbatimPrompts` keeps an `@path` in one from reading a local file.
/** @type {Options} */
const ISOLATED = { tools: [], settingSources: [], strictMcpConfig: true, verbatimPrompts: true };

/** The routing agent's options. Each run adds its tools and hooks. */
/** @type {Options} */
export const requestAgent = {
  model: 'claude-haiku-4-5',
  systemPrompt: REQUEST_PROMPT,
  allowedTools: [`mcp__${SERVER}__create_code_channel`],
  ...ISOLATED,
};

/** The coding agent's options. Each run adds its tools, hooks, and the session to resume. */
/** @type {Options} */
export const agent = {
  model: 'claude-sonnet-5-5',
  systemPrompt: SYSTEM_PROMPT,
  maxTurns: MAX_TURNS,
  ...ISOLATED,
};

/** The SDK's entry point, called through this object so tests can stand in for it. */
export const sdk = { query };

/**
 * A run that ended on a deferred `run_command`, picked back up by resuming its session.
 *
 * `history` ends with that run's result, whose `deferred_tool_use` is the
 * command waiting on approval.
 * @typedef {Object} PausedRun
 * @property {SDKResultMessage[]} history
 */

/**
 * The options that serve `tools` to a run.
 * @param {import('@anthropic-ai/claude-agent-sdk').SdkMcpToolDefinition<any>[]} tools
 * @returns {Options}
 */
function serve(tools) {
  return {
    mcpServers: { [SERVER]: createSdkMcpServer({ name: SERVER, tools }) },
    // The SDK registers the server once the CLI starts, but resuming a deferred
    // call looks for its tool before that and finds none. Naming the server on
    // the command line too, as the Python SDK does, makes the tool known in time.
    extraArgs: { 'mcp-config': JSON.stringify({ mcpServers: { [SERVER]: { type: 'sdk', name: SERVER } } }) },
  };
}

/**
 * A `PostToolUse` hook that ends the run once `done()`, since there's nothing left to do.
 * @param {() => boolean} done
 * @returns {import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher[]}
 */
function endOnce(done) {
  return [{ hooks: [async () => (done() ? { continue: false } : {})] }];
}

/**
 * The coding agent's options for a run that continues the session in `history`, if any.
 * @param {AgentDeps} deps
 * @param {SDKResultMessage[]} history
 * @param {{ approval?: { toolUseId: string, approved: boolean }, unanswered?: string }} [decisions]
 * @returns {Options}
 */
function codingOptions(deps, history, { approval, unanswered } = {}) {
  return {
    ...agent,
    ...serve(
      [
        cloneRepo,
        readFile,
        writeFile,
        editFile,
        runCommand,
        publishDiff,
        setContextBar,
        writePlan,
        readPlan,
        publishHtmlView,
        listViews,
        removeView,
        setCommands,
        renameSession,
        archiveChannel,
      ].map((tool) => tool(deps)),
    ),
    hooks: {
      PreToolUse: [{ hooks: [gateToolCalls({ deps, approval, unanswered })] }],
      // End the turn once the channel is archived, since nothing more can be posted.
      PostToolUse: endOnce(() => deps.session.archived),
    },
    canUseTool: answerUnanswered,
    resume: history.at(-1)?.session_id,
  };
}

/**
 * Run the agent once and return its result.
 *
 * Without a prompt, the run resumes the session's deferred command. The CLI
 * reads its input until the result, so the prompt stays open with nothing to send.
 * @param {Options} options
 * @param {string | null} prompt
 * @returns {Promise<SDKResultMessage>}
 */
async function runOnce(options, prompt) {
  /** @type {() => void} */
  let release = () => {};
  const released = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>} */
  const nothing = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await released;
        return { done: true, value: undefined };
      },
    }),
  };
  try {
    for await (const message of sdk.query({ prompt: prompt ?? nothing, options })) {
      if (message.type !== 'result') continue;
      // Closing out a dropped pause ends that old turn first, with its own result.
      if (INTERRUPTED.includes(message.terminal_reason ?? '')) continue;
      return message;
    }
  } finally {
    release();
  }
  throw new Error('The agent stopped without a result.');
}

/**
 * Throw for a run that failed, with the CLI's reasons.
 * @param {SDKResultMessage} result
 */
function raiseIfFailed(result) {
  if (!result.is_error) return;
  const reasons = result.subtype === 'success' ? [result.result] : result.errors;
  throw new Error(reasons.filter(Boolean).join('; ') || result.subtype);
}

/**
 * Turn a run's result into a RunOutcome, detecting a pending approval.
 *
 * The conversation itself lives in the Claude Code session, so `history` is the
 * session's results. The last one says which session to resume, and any command
 * it left waiting.
 * @param {SDKResultMessage[]} history
 * @param {SDKResultMessage} result
 * @returns {RunOutcome}
 */
export function settle(history, result) {
  const next = [...history, result];
  if (result.subtype === 'success' && result.deferred_tool_use) {
    // If this run is stopped or replaced instead of resumed, the next run
    // answers this call as not run, so the session stays valid either way.
    return new RunOutcome({
      paused: /** @type {PausedRun} */ ({ history: next }),
      command: String(result.deferred_tool_use.input.command ?? ''),
      history: next,
    });
  }
  if (result.subtype === 'error_max_turns') {
    return new RunOutcome({
      finalOutput:
        `I used all ${MAX_TURNS} steps I get in one turn before finishing. ` +
        "Send a message and I'll pick up where I left off.",
      history: next,
    });
  }
  raiseIfFailed(result);
  return new RunOutcome({ finalOutput: result.subtype === 'success' ? result.result : null, history: next });
}

/**
 * Reply to a request outside a code channel, or create one for it via the tool.
 * @param {string} prompt
 * @param {RequestDeps} deps
 * @returns {Promise<string | null>}
 */
export async function runRequest(prompt, deps) {
  const result = await runOnce(
    {
      ...requestAgent,
      ...serve([createCodeChannel(deps)]),
      // End the request once a code channel exists, since the work continues there.
      hooks: { PostToolUse: endOnce(() => deps.codeChannelId !== null) },
    },
    prompt,
  );
  raiseIfFailed(result);
  return result.subtype === 'success' ? result.result : null;
}

/**
 * Start an agent turn. May complete, or pause awaiting command approval.
 * @param {SDKResultMessage[]} history
 * @param {string} text
 * @param {AgentDeps} deps
 * @returns {Promise<RunOutcome>}
 */
export async function startRun(history, text, deps) {
  // A paused run that was stopped or replaced left its command waiting.
  const last = history.at(-1);
  const waiting = last?.subtype === 'success' ? last.deferred_tool_use : undefined;
  const result = await runOnce(codingOptions(deps, history, { unanswered: waiting?.id }), text);
  return settle(history, result);
}

/**
 * Resume a paused run with the user's decision on its pending command.
 * @param {PausedRun} paused
 * @param {boolean} approved
 * @param {AgentDeps} deps
 * @returns {Promise<RunOutcome>}
 */
export async function resumeRun(paused, approved, deps) {
  const last = /** @type {import('@anthropic-ai/claude-agent-sdk').SDKResultSuccess} */ (paused.history.at(-1));
  const toolUseId = /** @type {string} */ (last.deferred_tool_use?.id);
  const result = await runOnce(codingOptions(deps, paused.history, { approval: { toolUseId, approved } }), null);
  return settle(paused.history, result);
}
