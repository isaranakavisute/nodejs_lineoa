import { client } from './line.js';

// Handles a single webhook event. Extend this with your own bot logic.
export async function handleEvent(event) {
  switch (event.type) {
    case 'message':
      return handleMessage(event);
    case 'follow':
      return reply(event.replyToken, 'Thanks for adding me as a friend!');
    case 'unfollow':
      console.log(`Unfollowed by ${event.source.userId}`);
      return null;
    case 'postback':
      return reply(event.replyToken, `Postback received: ${event.postback.data}`);
    default:
      console.log(`Unhandled event type: ${event.type}`);
      return null;
  }
}

async function handleMessage(event) {
  const { message, replyToken } = event;

  if (message.type !== 'text') {
    return reply(replyToken, `Received a ${message.type} message.`);
  }

  // Echo the text back.
  return reply(replyToken, message.text);
}

function reply(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}
