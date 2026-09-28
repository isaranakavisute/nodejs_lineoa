import { messagingApi } from '@line/bot-sdk';
import { config } from './config.js';

export const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

// Used to download images, video, audio, and files that users send.
export const blobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.line.channelAccessToken,
});
