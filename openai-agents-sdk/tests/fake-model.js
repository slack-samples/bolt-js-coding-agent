/**
 * A stand-in model that returns scripted responses, so tests can drive real agent runs.
 */

import { Usage } from '@openai/agents';

let ids = 0;

/**
 * A response that calls the tool `name` with `args`.
 * @param {string} name
 * @param {Record<string, any>} args
 */
export function call(name, args) {
  return {
    type: 'function_call',
    id: `fc_${ids++}`,
    callId: `call_${ids++}`,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

/**
 * A response that ends the turn with `text`.
 * @param {string} text
 */
export function say(text) {
  return {
    type: 'message',
    id: `msg_${ids++}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

/** Answers each model call with `script(callNumber)`, counting from 1. */
export class FakeModel {
  /** @param {(callNumber: number) => any} script */
  constructor(script) {
    this.script = script;
    /** @type {any[]} */
    this.inputs = [];
  }

  /** @param {import('@openai/agents').ModelRequest} request */
  async getResponse(request) {
    this.inputs.push(request.input);
    const output = this.script(this.inputs.length);
    return { usage: new Usage(), output: [output], responseId: undefined };
  }

  /** @returns {AsyncIterable<any>} */
  getStreamedResponse() {
    throw new Error('Not implemented');
  }
}
