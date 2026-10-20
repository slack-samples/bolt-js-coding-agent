/**
 * A stand-in model that returns scripted responses, so tests can drive real agent runs.
 *
 * The SDK runs the Claude Code CLI, which calls the Anthropic Messages API at
 * `ANTHROPIC_BASE_URL`. `FakeModel` serves that API on localhost and answers
 * each call from a script, so the real SDK and CLI run without calling Anthropic.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The prefix the CLI gives the agent's tools, from its MCP server's name.
const TOOL_PREFIX = 'mcp__coding-agent__';

let ids = 0;

/**
 * A response that calls the tool `name` with `args`.
 * @param {string} name
 * @param {Record<string, any>} args
 */
export function call(name, args) {
  return { type: 'tool_use', id: `toolu_${ids++}`, name: TOOL_PREFIX + name, input: args };
}

/**
 * A response that ends the turn with `text`.
 * @param {string} text
 */
export function say(text) {
  return { type: 'text', text };
}

/**
 * The stream of events the Messages API sends for a response of one block.
 * @param {any} block
 * @param {string} model
 */
function events(block, model) {
  const toolUse = block.type === 'tool_use';
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${ids++}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: toolUse ? { ...block, input: {} } : say('') },
    {
      type: 'content_block_delta',
      index: 0,
      delta: toolUse
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
}

/**
 * Answers each model call with `script(callNumber)`, counting from 1.
 *
 * Once started, pass `env` as a run's environment so the CLI calls this model.
 * The CLI keeps its sessions in a temp directory, not `~/.claude`.
 */
export class FakeModel {
  /** @param {(callNumber: number) => any} script */
  constructor(script) {
    this.script = script;
    /**
     * The messages sent with each scripted call.
     * @type {any[][]}
     */
    this.inputs = [];
    /** @type {Record<string, string>} */
    this.env = {};
    this.server = http.createServer((request, response) => this.answer(request, response));
    this.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
  }

  /**
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse} response
   */
  async answer(request, response) {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map((/** @type {any} */ tool) => tool.name);
    let block;
    if (tools.some((/** @type {string} */ name) => name.startsWith(TOOL_PREFIX))) {
      this.inputs.push(body.messages);
      block = this.script(this.inputs.length);
    } else {
      // A call the CLI makes for itself, like titling the session.
      block = say('ok');
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events(block, body.model ?? '')) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (this.server.address());
    // Drop any provider or CLI settings from the environment running the tests,
    // like Bedrock, so the CLI only ever reaches this model.
    this.env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry) => entry[1] !== undefined && !entry[0].startsWith('ANTHROPIC_') && !entry[0].startsWith('CLAUDE_'),
        ),
      ),
      ANTHROPIC_API_KEY: 'test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CONFIG_DIR: this.configDir,
    };
  }

  async close() {
    await new Promise((resolve) => this.server.close(() => resolve(undefined)));
    fs.rmSync(this.configDir, { recursive: true, force: true });
  }
}
