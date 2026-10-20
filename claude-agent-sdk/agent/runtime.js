/**
 * What the tools share during a run: the shape of a tool's reply.
 */

/**
 * A tool's reply to the model.
 * @param {string} text
 * @returns {import('@modelcontextprotocol/sdk/types.js').CallToolResult}
 */
export function toolResult(text) {
  return { content: [{ type: 'text', text }] };
}
