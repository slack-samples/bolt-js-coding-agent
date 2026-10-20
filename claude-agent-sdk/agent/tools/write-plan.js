import { tool } from '@anthropic-ai/claude-agent-sdk';
import { WebAPIPlatformError } from '@slack/web-api';
import { z } from 'zod';

import { toolResult } from '../runtime.js';

const PLAN_VIEW_KEY = 'plan';

/** @param {import('../sessions.js').AgentDeps} deps */
export const writePlan = (deps) =>
  tool(
    'write_plan',
    "Write the task plan to the code channel's Plan tab.\n" +
      '\n' +
      'The plan is a canvas everyone in the channel can read and comment on, but\n' +
      'only you edit. Send the whole plan as markdown each time. Sections you leave\n' +
      'unchanged keep their comments. Call `read_plan` first to see feedback.',
    {
      markdown: z
        .string()
        .describe(
          "The full plan document as markdown, starting with a `#` title. Canvases don't support bullets nested inside a numbered list, so use a heading per step or plain numbered steps.",
        ),
    },
    async ({ markdown }) => {
      const session = deps.session;
      try {
        if (session.planCanvasId) {
          const response = await deps.client.agents.conversations.setCanvasContent({
            channel: deps.channelId,
            canvas_id: session.planCanvasId,
            content: markdown,
          });
          return toolResult(`Updated the plan (${response.sections_changed_count ?? 0} sections changed).`);
        }

        const created = await deps.client.canvases.create({
          title: 'Plan',
          document_content: { type: 'markdown', markdown },
        });
        // Comment access keeps the agent the sole author while users leave feedback.
        await deps.client.agents.conversations.setView({
          channel_id: deps.channelId,
          type: 'canvas',
          view_key: PLAN_VIEW_KEY,
          name: 'Plan',
          canvas_id: created.canvas_id,
          access_level: 'comment',
        });
        session.planCanvasId = /** @type {string} */ (created.canvas_id);
        return toolResult('Created the plan and attached it as the Plan tab.');
      } catch (e) {
        if (!(e instanceof WebAPIPlatformError)) throw e;
        // The detail names the markdown Slack rejected, so the model can fix it and retry.
        const detail = /** @type {any} */ (e.data).detail;
        if (detail) {
          return toolResult(
            `Could not write the plan: ${e.data.error} (${detail}). Fix the markdown and call write_plan again.`,
          );
        }
        return toolResult(`Could not write the plan: ${e.data.error}`);
      }
    },
  );
