import fs from 'node:fs';

import { tool } from '@openai/agents';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';
import { resolvePath } from '../workspace.js';

// Enough to read most source files whole, without one file crowding the turn.
const MAX_CHARS = 20000;

export const readFile = tool({
  name: 'read_file',
  description:
    'Read a file from the cloned repository.\n' +
    '\n' +
    'Reads the whole file, or the lines from `start_line` to `end_line` for a\n' +
    'large one. Long reads are cut short, so read big files in parts.',
  parameters: z.object({
    path: z.string().describe("The file's path relative to the repository root, such as `src/app.py`."),
    start_line: z
      .number()
      .int()
      .nullable()
      .describe('The first line to read, counting from 1, or omit it to start at the top.'),
    end_line: z.number().int().nullable().describe('The last line to read, or omit it to read to the end.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ path, start_line, end_line }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    const session = deps.session;
    if (!session.workdir) return 'No working directory yet — call clone_repo first.';
    const target = resolvePath(session.workdir, path);
    if (target === null) return `Can't read ${path}: it's outside the repository.`;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return `No file at ${path}.`;

    const lines = fs.readFileSync(target, 'utf-8').split(/\r\n|\r|\n/);
    // A trailing newline ends the last line rather than starting another.
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(start_line || 1, 1);
    const end = end_line === null ? lines.length : Math.min(end_line, lines.length);
    let content = lines.slice(start - 1, end).join('\n');
    if (content.length > MAX_CHARS) {
      content = content.slice(0, MAX_CHARS);
      return (
        `${path} (lines ${start}–${end} of ${lines.length}, cut short at ` +
        `${MAX_CHARS} characters — read the rest with a later start_line):\n${content}`
      );
    }
    return `${path} (lines ${start}–${end} of ${lines.length}):\n${content}`;
  },
});
