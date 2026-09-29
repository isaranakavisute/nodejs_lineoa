// Turns a short-lived Facebook user token (from the Graph API Explorer) into a long-lived
// Page access token for FACEBOOK_PAGE_ACCESS_TOKEN.
// Usage: npm run facebook-token -- <short-lived user token>
// Needs FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env.
import { config } from '../src/config.js';

const { appId, appSecret, graphVersion, pageId } = config.facebook;
const shortToken = process.argv[2];
const graph = (path, params) => {
  const url = new URL(`https://graph.facebook.com/${graphVersion}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url).then(async (res) => {
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body;
  });
};

if (!appId || !appSecret) {
  console.error('Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env first (Meta app → App settings → Basic).');
  process.exit(1);
}
if (!shortToken) {
  console.error('Usage: npm run facebook-token -- <token from the Graph API Explorer>');
  process.exit(1);
}

try {
  // 1. Short-lived user token (about 1 hour) → long-lived user token (about 60 days).
  const { access_token: longUserToken } = await graph('/oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken,
  });

  // 2. Page tokens obtained with a long-lived user token don't expire.
  const { data: pages } = await graph('/me/accounts', { fields: 'id,name,tasks,access_token', access_token: longUserToken });
  if (!pages.length) {
    console.error('No Pages found. In the Graph API Explorer, make sure you selected your Page and granted pages_show_list and pages_manage_posts.');
    process.exit(1);
  }

  const chosen = pages.find((p) => p.id === pageId) ?? (pages.length === 1 ? pages[0] : null);
  if (!chosen) {
    console.log('Your Pages:');
    for (const p of pages) console.log(`  ${p.id}  ${p.name}`);
    console.error('\nSet FACEBOOK_PAGE_ID in .env to one of the IDs above and run this again.');
    process.exit(1);
  }

  const canPost = (chosen.tasks ?? []).some((t) => t === 'CREATE_CONTENT' || t === 'MANAGE');
  const { data: info } = await graph('/debug_token', { input_token: chosen.access_token, access_token: `${appId}|${appSecret}` });
  const expires = info.expires_at ? new Date(info.expires_at * 1000).toISOString() : 'never';
  const scopes = info.scopes ?? [];

  console.log(`\nPage: ${chosen.name} (${chosen.id})`);
  console.log(`Can post: ${canPost ? 'yes' : 'NO (you need to be an admin or editor of this Page)'}`);
  console.log(`Permissions: ${scopes.join(', ')}`);
  console.log(`Token expires: ${expires}`);
  if (!scopes.includes('pages_manage_posts')) {
    console.log('\n⚠️  pages_manage_posts is missing. Add it in the Graph API Explorer, generate a new token, and run this again.');
  }
  console.log('\nAdd these lines to .env (keep the token secret):\n');
  console.log(`FACEBOOK_PAGE_ID=${chosen.id}`);
  console.log(`FACEBOOK_PAGE_ACCESS_TOKEN=${chosen.access_token}`);
} catch (err) {
  console.error(`Facebook error: ${err.message}`);
  process.exit(1);
}
