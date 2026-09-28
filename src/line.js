import { messagingApi } from '@line/bot-sdk';
import { config } from './config.js';

export const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});
