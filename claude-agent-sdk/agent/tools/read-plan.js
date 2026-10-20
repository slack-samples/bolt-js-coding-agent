import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';

import { toolResult } from '../runtime.js';

/** @param {import('../sessions.js').AgentDeps} deps */
export const readPlan = (deps) =>
  tool(
    'read_plan',
    'Read the Plan tab and any open comments people left on it.\n' +
      '\n' +
      'Call this at the start of each turn once a plan exists, and fold the\n' +
      'feedback into your work and your next `write_plan`.',
    {},
    async () => {
      const canvasId = deps.session.planCanvasId;
      if (!canvasId) return toolResult('No plan yet — call write_plan to create one.');

      let response;
      try {
        response = await deps.client.agents.conversations.getCanvas({
          channel: deps.channelId,
          canvas_id: canvasId,
          include_resolved: false,
        });
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        return toolResult(`Could not read the plan: ${e.data.error}`);
      }

      const parts = [`Plan:\n${response.content ?? ''}`];
      for (const comment of /** @type {any[]} */ (response.comments ?? [])) {
        const replies = (comment.replies ?? [])
          .map((/** @type {any} */ r) => `\n    ↳ <@${r.user_id}>: ${r.text}`)
          .join('');
        parts.push(`- On "${comment.quoted_text ?? ''}", <@${comment.user_id}> said: ${comment.text}${replies}`);
      }
      if (parts.length === 1) parts.push('No open comments.');
      return toolResult(parts.join('\n'));
    },
  );
