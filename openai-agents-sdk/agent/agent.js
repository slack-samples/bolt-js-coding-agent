/**
 * The OpenAI Agents SDK side of the coding agent.
 *
 * Everything that touches the SDK lives here, in `agent/guardrails.js`, and in
 * `agent/tools/`. The turn handling in `agent/turns.js` calls only `runRequest`,
 * which returns the reply text, and `startRun` and `resumeRun`, which return a
 * `RunOutcome`.
 */

import { Agent, run } from '@openai/agents';

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

/** @typedef {import('./sessions.js').AgentDeps} AgentDeps */
/** @typedef {import('./sessions.js').RequestDeps} RequestDeps */

// Model calls allowed per turn. Coding work reads several files before editing,
// so this is well above the SDK's default of 10.
export const MAX_TURNS = 50;

// Drop the oldest conversation when a long session outgrows the model's
// context window, rather than failing every turn after that.
/** @type {import('@openai/agents').ModelSettings} */
const MODEL_SETTINGS = { truncation: 'auto' };

/**
 * The SDK's handle on a run paused for approval, passed back to `resumeRun`.
 * @typedef {Object} PausedRun
 * @property {import('@openai/agents').RunState<any, any>} state
 * @property {import('@openai/agents').RunToolApprovalItem} item
 */

export const requestAgent = new Agent({
  name: 'Coding Agent',
  instructions: REQUEST_PROMPT,
  tools: [createCodeChannel],
  // End the request once a code channel exists, since the work continues there.
  toolUseBehavior: (context) => {
    const deps = /** @type {RequestDeps} */ (context.context);
    return deps.codeChannelId !== null
      ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: '' }
      : { isFinalOutput: false, isInterrupted: undefined };
  },
  model: 'gpt-6-luna',
  modelSettings: MODEL_SETTINGS,
});

export const agent = new Agent({
  name: 'Coding Agent',
  instructions: SYSTEM_PROMPT,
  tools: [
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
  ],
  // End the turn once the channel is archived, since nothing more can be posted.
  toolUseBehavior: (context) => {
    const deps = /** @type {AgentDeps} */ (context.context);
    return deps.session.archived
      ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: '' }
      : { isFinalOutput: false, isInterrupted: undefined };
  },
  model: 'gpt-6.1-sol',
  modelSettings: MODEL_SETTINGS,
});

/**
 * Turn a run result into a RunOutcome, detecting a pending approval.
 * @param {import('@openai/agents').RunResult<any, any>} result
 * @returns {RunOutcome}
 */
export function settle(result) {
  const history = [...result.history];
  const interruptions = result.interruptions;
  if (interruptions.length > 0) {
    // The history ends with calls still waiting on approval. Give each one
    // an output so the history stays valid if the run is stopped or replaced
    // instead of resumed. A resumed run replaces this history with its own.
    for (const item of interruptions) {
      const call = /** @type {import('@openai/agents').protocol.FunctionCallItem} */ (item.rawItem);
      history.push({
        type: 'function_call_result',
        name: call.name,
        callId: call.callId,
        status: 'completed',
        output: "Not run. The user didn't approve this command.",
      });
    }
    // One command at a time keeps the sample's approval UX simple.
    const item = interruptions[0];
    // The SDK gives the tool call's arguments as a JSON string.
    const args = JSON.parse(item.arguments || '{}');
    return new RunOutcome({
      paused: /** @type {PausedRun} */ ({ state: result.state, item }),
      command: args.command ?? '',
      history,
    });
  }
  return new RunOutcome({ finalOutput: result.finalOutput ?? null, history });
}

/**
 * End a turn that used every model call with a message, keeping its history.
 * @returns {import('@openai/agents').RunErrorHandlerResult<any>}
 */
export function outOfTurns() {
  return {
    finalOutput:
      `I used all ${MAX_TURNS} steps I get in one turn before finishing. ` +
      "Send a message and I'll pick up where I left off.",
    includeInHistory: true,
  };
}

/**
 * Reply to a request outside a code channel, or create one for it via the tool.
 * @param {string} prompt
 * @param {RequestDeps} deps
 * @returns {Promise<string | null>}
 */
export async function runRequest(prompt, deps) {
  const result = await run(requestAgent, prompt, { context: deps });
  return result.finalOutput ?? null;
}

/**
 * Start an agent turn. May complete, or pause awaiting command approval.
 * @param {any[]} history
 * @param {string} text
 * @param {AgentDeps} deps
 * @returns {Promise<RunOutcome>}
 */
export async function startRun(history, text, deps) {
  const result = await run(agent, [...history, { role: 'user', content: text }], {
    context: deps,
    maxTurns: MAX_TURNS,
    errorHandlers: { maxTurns: outOfTurns },
  });
  return settle(result);
}

/**
 * Resume a paused run with the user's decision on its pending command.
 * @param {PausedRun} paused
 * @param {boolean} approved
 * @param {AgentDeps} _deps - The run's deps travel with its state.
 * @returns {Promise<RunOutcome>}
 */
export async function resumeRun(paused, approved, _deps) {
  if (approved) {
    paused.state.approve(paused.item);
  } else {
    paused.state.reject(paused.item, { message: 'The user denied running this command.' });
  }
  // The paused state carries the run's context, turn count, and MAX_TURNS with it.
  const result = await run(agent, paused.state, { errorHandlers: { maxTurns: outOfTurns } });
  return settle(result);
}
