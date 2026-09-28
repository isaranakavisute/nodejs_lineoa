// Microsoft sign-in (OAuth device code flow) and Microsoft Graph requests for a personal
// Outlook.com / Hotmail account. Only a refresh token is stored; never a password.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Requested at sign-in: calendar write access for /meet, Mail.Send for /email, Mail.Read for /inbox.
// Keep Mail.Read (not Mail.ReadWrite): without write access, the bot cannot mark emails as read.
const SIGN_IN_SCOPES = 'offline_access Calendars.ReadWrite Mail.Send Mail.Read';
// Sign-ins made before /meet existed only granted read access.
const LEGACY_SCOPES = 'offline_access Calendars.Read';
const tokenFile = path.join(config.dataDir, 'microsoft-token.json');
const authority = () => `https://login.microsoftonline.com/${config.calendar.tenant}/oauth2/v2.0`;

export class NotSignedIn extends Error {
  constructor() {
    super('Not signed in to Microsoft. Run: npm run microsoft-login');
  }
}

// The saved sign-in doesn't include a permission this action needs (it predates the feature).
export class NoWriteAccess extends Error {
  constructor() {
    super('Permission not granted. Run: npm run microsoft-login');
  }
}

let accessToken = null; // { token, expiresAt }

// { refreshToken, scope } or null
function loadSavedTokens() {
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Microsoft may issue a new refresh token on every refresh; always keep the latest.
  // Remember which permissions were granted, so refreshes ask for the same ones.
  const scope = tokens.scope ? `offline_access ${tokens.scope}` : loadSavedTokens()?.scope;
  fs.writeFileSync(`${tokenFile}.tmp`, JSON.stringify({ refreshToken: tokens.refresh_token, scope }), { mode: 0o600 });
  fs.renameSync(`${tokenFile}.tmp`, tokenFile);
  accessToken = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
}

export function isSignedIn() {
  return Boolean(loadSavedTokens()?.refreshToken);
}

async function tokenRequest(params) {
  const res = await fetch(`${authority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.calendar.clientId, ...params }),
  });
  return { ok: res.ok, body: await res.json() };
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessToken.expiresAt) return accessToken.token;

  const saved = loadSavedTokens();
  if (!saved?.refreshToken) throw new NotSignedIn();

  const { ok, body } = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: saved.refreshToken,
    scope: saved.scope || LEGACY_SCOPES,
  });
  if (!ok) {
    // invalid_grant means the sign-in was revoked or expired (e.g. password change): sign in again.
    if (body.error === 'invalid_grant') throw new NotSignedIn();
    throw new Error(`Microsoft token refresh failed: ${body.error_description ?? body.error}`);
  }
  saveTokens(body);
  return accessToken.token;
}

export async function graphRequest(method, pathAndQuery, { body, headers = {} } = {}) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Some writes (e.g. sendMail: 202, delete: 204) return no body.
  const text = await res.text();
  const result = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // 403 on a write means this sign-in only granted read access.
    if (res.status === 403 && method !== 'GET') throw new NoWriteAccess();
    throw new Error(`Microsoft Graph ${res.status}: ${result?.error?.message ?? res.statusText}`);
  }
  return result;
}

export async function graphGet(pathAndQuery, headers = {}) {
  return graphRequest('GET', pathAndQuery, { headers });
}

// e.g. hasPermission('Mail.Send')
export function hasPermission(name) {
  return (loadSavedTokens()?.scope ?? '').split(/\s+/).some((s) => s.toLowerCase().endsWith(name.toLowerCase()));
}

// One-time interactive sign-in. Calls showCode with instructions for the user, then waits.
export async function signInWithDeviceCode(showCode) {
  const res = await fetch(`${authority()}/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.calendar.clientId, scope: SIGN_IN_SCOPES }),
  });
  const device = await res.json();
  if (!res.ok) throw new Error(`Could not start Microsoft sign-in: ${device.error_description ?? device.error}`);
  showCode(device.message);

  let interval = device.interval * 1000;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const { ok, body } = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
    });
    if (ok) {
      saveTokens(body);
      return;
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error(`Microsoft sign-in failed: ${body.error_description ?? body.error}`);
  }
  throw new Error('Microsoft sign-in timed out. Please run it again.');
}
