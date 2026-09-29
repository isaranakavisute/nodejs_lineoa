import 'dotenv/config';

const required = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'ANTHROPIC_API_KEY'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0 && process.env.NODE_ENV !== 'test') {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    channelSecret: process.env.LINE_CHANNEL_SECRET ?? '',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.CLAUDE_MODEL || 'claude-opus-5',
  },
  // Where persistent data (news subscribers) is saved.
  dataDir: process.env.DATA_DIR || 'data',
  news: {
    // The daily push is off unless NEWS_SCHEDULE_ENABLED=true. /news on demand always works.
    scheduleEnabled: process.env.NEWS_SCHEDULE_ENABLED === 'true',
    time: process.env.NEWS_TIME || '07:00',
    timezone: process.env.NEWS_TIMEZONE || 'Asia/Bangkok',
    defaultLanguage: process.env.NEWS_LANGUAGE || 'English',
    storyCount: Number(process.env.NEWS_STORY_COUNT) || 5,
  },
  calendar: {
    // From your app registration in the Microsoft Entra admin center.
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    // 'consumers' = personal Microsoft accounts (Hotmail, Outlook.com, Live).
    tenant: process.env.MICROSOFT_TENANT || 'consumers',
    // Your own LINE user ID: alerts go only here, and only this user can use /calendar.
    alertTo: process.env.CALENDAR_ALERT_TO || '',
    leadMinutes: Number(process.env.CALENDAR_ALERT_MINUTES) || 60,
    timezone: process.env.CALENDAR_TIMEZONE || 'Asia/Bangkok',
  },
  facebook: {
    // The Facebook Page the owner can post to from LINE (/fb). See README "Posting to Facebook".
    pageId: process.env.FACEBOOK_PAGE_ID || '',
    pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
    // Only needed once, to turn a short-lived token into a long-lived Page token (npm run facebook-token).
    appId: process.env.FACEBOOK_APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v23.0',
  },
  translation: {
    // Messages are translated into the target language; text already in it goes to the secondary.
    defaultTarget: process.env.DEFAULT_TARGET_LANGUAGE || 'English',
    defaultSecondary: process.env.DEFAULT_SECONDARY_LANGUAGE || 'Thai',
  },
};
