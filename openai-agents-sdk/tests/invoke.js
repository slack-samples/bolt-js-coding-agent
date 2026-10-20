import { RunContext, setTracingDisabled } from '@openai/agents';

// Tests never reach OpenAI, so there are no traces to send.
setTracingDisabled(true);

/**
 * Call a tool the way a run does, with `deps` as its context.
 * @param {any} tool
 * @param {any} deps
 * @param {Record<string, any>} [args]
 * @returns {Promise<any>}
 */
export async function invoke(tool, deps, args = {}) {
  return await tool.invoke(new RunContext(deps), JSON.stringify(args));
}
