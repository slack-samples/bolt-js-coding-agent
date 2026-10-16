import { tool } from '@openai/agents';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { sessionStopped, toolFailed } from '../guardrails.js';

export const readPlan = tool({
  name: 'read_plan',
  description:
    'Read the Plan tab and any open comments people left on it.\n' +
    '\n' +
    'Call this at the start of each turn once a plan exists, and fold the\n' +
    'feedback into your work and your next `write_plan`.',
  parameters: z.object({}),
  inputGuardrails: [sessionStopped],
  errorFunction: toolFailed,
  execute: async (_input, context) => {
    const deps = /** @type {import('../sessions.js').AgentDeps} */ (context?.context);
    const canvasId = deps.session.planCanvasId;
    if (!canvasId) return 'No plan yet — call write_plan to create one.';

    let response;
    try {
      response = await deps.client.agents.conversations.getCanvas({
        channel: deps.channelId,
        canvas_id: canvasId,
        include_resolved: false,
      });
    } catch (e) {
      if (!(e instanceof WebAPIPlatformError)) throw e;
      return `Could not read the plan: ${e.data.error}`;
    }

    const parts = [`Plan:\n${response.content ?? ''}`];
    for (const comment of /** @type {any[]} */ (response.comments ?? [])) {
      const replies = (comment.replies ?? [])
        .map((/** @type {any} */ r) => `\n    ↳ <@${r.user_id}>: ${r.text}`)
        .join('');
      parts.push(`- On "${comment.quoted_text ?? ''}", <@${comment.user_id}> said: ${comment.text}${replies}`);
    }
    if (parts.length === 1) parts.push('No open comments.');
    return parts.join('\n');
  },
});
