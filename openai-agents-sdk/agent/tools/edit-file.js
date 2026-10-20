import fs from 'node:fs';

import { tool } from '@openai/agents';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';
import { resolvePath } from '../workspace.js';

export const editFile = tool({
  name: 'edit_file',
  description:
    'Replace one exact piece of text in a file in the cloned repository.\n' +
    '\n' +
    '`old_text` must appear exactly once in the file, including its whitespace\n' +
    'and indentation, so include enough surrounding lines to make it unique. Read\n' +
    "the file with `read_file` first. Files under `.git` can't be edited.",
  parameters: z.object({
    path: z.string().describe("The file's path relative to the repository root, such as `src/app.py`."),
    old_text: z.string().describe('The exact text to replace.'),
    new_text: z.string().describe('The text to put in its place.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ path, old_text, new_text }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    const session = deps.session;
    if (!session.workdir) return 'No working directory yet — call clone_repo first.';
    const target = resolvePath(session.workdir, path, { writing: true });
    if (target === null) return `Can't edit ${path}: it's outside the repository or inside \`.git\`.`;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile())
      return `No file at ${path}. Create it with write_file.`;

    const content = fs.readFileSync(target, 'utf-8');
    const count = content.split(old_text).length - 1;
    if (count === 0) return `Didn't find old_text in ${path}. Read the file and copy the text exactly.`;
    if (count > 1) return `old_text appears ${count} times in ${path}. Include more surrounding lines.`;
    // A function replacement keeps `$` patterns in new_text as plain text.
    fs.writeFileSync(
      target,
      content.replace(old_text, () => new_text),
    );
    return `Edited ${path}.`;
  },
});
