// Posts to the owner's Facebook Page through the Facebook Graph API. No AI involved.
// Facebook does not allow apps to post to personal profiles, only to Pages.
import { config } from './config.js';

const graphUrl = (path) => `https://graph.facebook.com/${config.facebook.graphVersion}${path}`;
// Facebook's limit for a post's text.
const MAX_MESSAGE_LENGTH = 63206;

export class FacebookNotConfigured extends Error {}
export class FacebookTokenInvalid extends Error {}

export function isFacebookConfigured() {
  return Boolean(config.facebook.pageId && config.facebook.pageAccessToken);
}

async function graphCall(method, path, { params = {}, form } = {}) {
  if (!isFacebookConfigured()) throw new FacebookNotConfigured();

  const url = new URL(graphUrl(path));
  let body;
  if (form) {
    form.append('access_token', config.facebook.pageAccessToken);
    body = form;
  } else if (method === 'GET') {
    for (const [key, value] of Object.entries({ ...params, access_token: config.facebook.pageAccessToken })) {
      url.searchParams.set(key, value);
    }
  } else {
    body = new URLSearchParams({ ...params, access_token: config.facebook.pageAccessToken });
  }

  const res = await fetch(url, { method, body });
  const result = await res.json();
  if (!res.ok || result.error) {
    // 190 = the access token is invalid or expired (e.g. password change, app removed).
    if (result.error?.code === 190) throw new FacebookTokenInvalid(result.error.message);
    throw new Error(`Facebook ${res.status}: ${result.error?.message ?? res.statusText}`);
  }
  return result;
}

export function getPageInfo() {
  return graphCall('GET', `/${config.facebook.pageId}`, { params: { fields: 'name,link' } });
}

const postUrl = (id) => `https://www.facebook.com/${id}`;

// Parses "/fb" text. The first web address (if any) is attached as a link preview.
export function parseFacebookPost(text) {
  const message = text.trim();
  if (!message) return { error: 'empty' };
  if (message.length > MAX_MESSAGE_LENGTH) return { error: 'too-long' };
  const link = /https?:\/\/\S+/i.exec(message)?.[0];
  return link ? { message, link } : { message };
}

// Text post (with an optional link preview). Returns the post's URL.
export async function postText({ message, link }) {
  const result = await graphCall('POST', `/${config.facebook.pageId}/feed`, { params: link ? { message, link } : { message } });
  return postUrl(result.id);
}

// Photo post. `image` is a Claude-style image block from vision.js (base64 data or a URL).
export async function postPhoto({ image, caption }) {
  const form = new FormData();
  if (image.source.type === 'base64') {
    const bytes = Buffer.from(image.source.data, 'base64');
    form.append('source', new Blob([bytes], { type: image.source.media_type }), 'photo');
  } else {
    form.append('url', image.source.url);
  }
  if (caption) form.append('caption', caption);

  const result = await graphCall('POST', `/${config.facebook.pageId}/photos`, { form });
  return postUrl(result.post_id ?? result.id);
}
