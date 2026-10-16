import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

const Command = z.object({
  name: z.string().describe('The command name without a leading slash, such as `run-tests`. 1–31 characters.'),
  description: z.string().describe('What the command does, shown in the composer typeahead.'),
  argument_hint: z.string().nullable().describe("A hint for the command's arguments, such as `[title]`."),
});

export const setCommands = tool({
  name: 'set_commands',
  description:
    'Register the slash commands people can use in this code channel.\n' +
    '\n' +
    "Offer shortcuts for things you'll do often in this task, like `run-tests`,\n" +
    "`summarize`, or `wrap-up`. When someone runs one, you'll receive it as a\n" +
    'message like `/run-tests <text>`. The list replaces your current set; send an\n' +
    'empty list to clear it. Register commands once early and only update them when\n' +
    'the useful set changes.',
  parameters: z.object({
    commands: z.array(Command).describe('The full set of commands to offer.'),
  }),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async ({ commands }, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    try {
      const response = await deps.client.agents.conversations.setCommands({
        channel_id: deps.channelId,
        // Leave out the hint when the model sent none.
        commands: commands.map(({ argument_hint, ...command }) =>
          argument_hint === null ? command : { ...command, argument_hint },
        ),
      });
      return `Registered ${response.command_count ?? commands.length} commands.`;
    } catch (e) {
      if (!(e instanceof WebAPIPlatformError)) throw e;
      return `Could not register commands: ${e.data.error}`;
    }
  },
});
