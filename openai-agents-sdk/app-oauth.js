import 'dotenv/config';

import { App, FileInstallationStore, LogLevel } from '@slack/bolt';

import { registerListeners } from './listeners/index.js';

const app = new App({
  logLevel: LogLevel.DEBUG,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: [
    'app_mentions:read',
    'assistant:write',
    'canvases:write',
    'channels:history',
    'channels:read',
    'chat:write',
    'code_channels:manage',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'im:write',
    'mpim:history',
  ],
  installationStore: new FileInstallationStore({ baseDir: './data/installations' }),
  installerOptions: {
    stateVerification: true,
  },
  clientOptions: {
    slackApiUrl: process.env.SLACK_API_URL || 'https://slack.com/api/',
  },
});

registerListeners(app);

(async () => {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  await app.start(port);
  app.logger.info(`Coding Agent is running on port ${port}!`);
})();
