import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { App, FileInstallationStore, LogLevel } from '@slack/bolt';

import { registerListeners } from './listeners/index.js';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf-8'));
const botScopes = manifest.oauth_config.scopes.bot;

const app = new App({
  logLevel: LogLevel.DEBUG,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: botScopes,
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
