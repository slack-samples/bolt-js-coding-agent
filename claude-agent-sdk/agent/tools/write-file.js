import fs from 'node:fs';
import nodePath from 'node:path';

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolResult } from '../runtime.js';
import { resolvePath } from '../workspace.js';

/** @param {import('../sessions.js').AgentDeps} deps */
export const writeFile = (deps) =>
  tool(
    'write_file',
    'Create a file in the cloned repository, or replace one with new content.\n' +
      '\n' +
      'Use it for new files or full rewrites. To change part of an existing file,\n' +
      "use `edit_file`. Files under `.git` can't be written.",
    {
      path: z.string().describe("The file's path relative to the repository root, such as `src/app.py`."),
      content: z.string().describe('The complete new contents of the file.'),
    },
    async ({ path, content }) => {
      const session = deps.session;
      if (!session.workdir) return toolResult('No working directory yet — call clone_repo first.');
      const target = resolvePath(session.workdir, path, { writing: true });
      if (target === null) return toolResult(`Can't write ${path}: it's outside the repository or inside \`.git\`.`);

      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      const lines = content.split(/\r\n|\r|\n/);
      if (lines.at(-1) === '') lines.pop();
      return toolResult(`Wrote ${path} (${lines.length} lines).`);
    },
  );
