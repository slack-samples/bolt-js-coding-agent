import fs from 'node:fs';
import nodePath from 'node:path';

import { tool } from '@openai/agents';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';
import { resolvePath } from '../workspace.js';

export const writeFile = tool({
  name: 'write_file',
  description:
    'Create a file in the cloned repository, or replace one with new content.\n' +
    '\n' +
    'Use it for new files or full rewrites. To change part of an existing file,\n' +
    "use `edit_file`. Files under `.git` can't be written.",
  parameters: z.object({
    path: z.string().describe("The file's path relative to the repository root, such as `src/app.py`."),
    content: z.string().describe('The complete new contents of the file.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ path, content }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    const session = deps.session;
    if (!session.workdir) return 'No working directory yet — call clone_repo first.';
    const target = resolvePath(session.workdir, path, { writing: true });
    if (target === null) return `Can't write ${path}: it's outside the repository or inside \`.git\`.`;

    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const lines = content.split(/\r\n|\r|\n/);
    if (lines.at(-1) === '') lines.pop();
    return `Wrote ${path} (${lines.length} lines).`;
  },
});
