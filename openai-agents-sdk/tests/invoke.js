import { RunContext } from '@openai/agents';

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
