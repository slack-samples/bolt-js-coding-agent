import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * Call a tool the way a run does: through its MCP server, with its arguments
 * checked against its schema, and an error it throws sent back as the result.
 * @param {(deps: any) => import('@anthropic-ai/claude-agent-sdk').SdkMcpToolDefinition<any>} tool
 * @param {any} deps
 * @param {Record<string, any>} [args]
 * @returns {Promise<string>} The text the model gets back.
 */
export async function invoke(tool, deps, args = {}) {
  const definition = tool(deps);
  const server = createSdkMcpServer({ name: 'coding-agent', tools: [definition] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'tests', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: definition.name, arguments: args });
    const content = /** @type {{ type: string, text?: string }[]} */ (result.content);
    return content.map((block) => block.text ?? '').join('\n');
  } finally {
    await client.close();
  }
}
