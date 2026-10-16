/**
 * A tool's reply to the model.
 * @param {string} text
 * @returns {import('@modelcontextprotocol/sdk/types.js').CallToolResult}
 */
export function toolResult(text) {
  return { content: [{ type: 'text', text }] };
}
