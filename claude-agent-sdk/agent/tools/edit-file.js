import fs from 'node:fs';

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { resolvePath } from '../workspace.js';
import { toolResult } from './tool-result.js';

/** @param {import('../sessions.js').AgentDeps} deps */
export const editFile = (deps) =>
  tool(
    'edit_file',
    'Replace one exact piece of text in a file in the cloned repository.\n' +
      '\n' +
      '`old_text` must appear exactly once in the file, including its whitespace\n' +
      'and indentation, so include enough surrounding lines to make it unique. Read\n' +
      "the file with `read_file` first. Files under `.git` can't be edited.",
    {
      path: z.string().describe("The file's path relative to the repository root, such as `src/app.py`."),
      old_text: z.string().describe('The exact text to replace.'),
      new_text: z.string().describe('The text to put in its place.'),
    },
    async ({ path, old_text, new_text }) => {
      const session = deps.session;
      if (!session.workdir) return toolResult('No working directory yet — call clone_repo first.');
      const target = resolvePath(session.workdir, path, { writing: true });
      if (target === null) return toolResult(`Can't edit ${path}: it's outside the repository or inside \`.git\`.`);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile())
        return toolResult(`No file at ${path}. Create it with write_file.`);

      const content = fs.readFileSync(target, 'utf-8');
      const count = content.split(old_text).length - 1;
      if (count === 0) return toolResult(`Didn't find old_text in ${path}. Read the file and copy the text exactly.`);
      if (count > 1) return toolResult(`old_text appears ${count} times in ${path}. Include more surrounding lines.`);
      // A function replacement keeps `$` patterns in new_text as plain text.
      fs.writeFileSync(
        target,
        content.replace(old_text, () => new_text),
      );
      return toolResult(`Edited ${path}.`);
    },
  );
