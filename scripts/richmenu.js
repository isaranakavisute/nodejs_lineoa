// Creates the owner's Rich Menu (the button panel at the bottom of the LINE chat) and links it
// to the owner only (CALENDAR_ALERT_TO). Other users don't see it.
// Usage: npm run richmenu               upload assets/richmenu-owner.png and link it
//        npm run richmenu -- --render   first re-draw the PNG from the HTML with Google Chrome
//        npm run richmenu -- --remove   remove the menu
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { client, blobClient } from '../src/line.js';

const MENU_NAME = 'Owner menu';
const WIDTH = 2500;
const HEIGHT = 1686;
const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const htmlFile = path.join(assets, 'richmenu-owner.html');
const pngFile = path.join(assets, 'richmenu-owner.png');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Same order as the tiles in richmenu-owner.html (left to right, top to bottom).
const TILES = [
  { label: '📬 Inbox', data: 'cmd=%2Finbox' },
  { label: '✉️ Email', data: 'flow=email' },
  { label: '📅 Calendar', data: 'menu=calendar' },
  { label: '📘 Facebook', data: 'menu=facebook' },
  { label: '💬 Chat / Translate', data: 'menu=modes' },
  { label: '❓ Help', data: 'menu=help' },
];

const AREAS = TILES.map((tile, i) => {
  const col = i % 3;
  const row = Math.floor(i / 3);
  const x = Math.round((WIDTH / 3) * col);
  const y = Math.round((HEIGHT / 2) * row);
  return {
    bounds: { x, y, width: Math.round((WIDTH / 3) * (col + 1)) - x, height: Math.round((HEIGHT / 2) * (row + 1)) - y },
    action: { type: 'postback', label: tile.label, data: tile.data, displayText: tile.label },
  };
});

async function removeExisting() {
  const { richmenus } = await client.getRichMenuList();
  for (const menu of richmenus.filter((m) => m.name === MENU_NAME)) {
    await client.deleteRichMenu(menu.richMenuId);
    console.log(`Removed old menu ${menu.richMenuId}`);
  }
}

// Draws the PNG from the HTML with headless Chrome. Chrome sometimes keeps running after writing
// the screenshot, so wait for the file and then stop Chrome ourselves.
async function render() {
  if (!fs.existsSync(CHROME)) throw new Error('Google Chrome is needed to render the menu image.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'richmenu-chrome-'));
  const before = fs.existsSync(pngFile) ? fs.statSync(pngFile).mtimeMs : 0;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`, `--screenshot=${pngFile}`, `file://${htmlFile}`,
  ], { stdio: 'ignore' });
  try {
    for (let waited = 0; ; waited += 500) {
      if (fs.existsSync(pngFile) && fs.statSync(pngFile).mtimeMs > before && fs.statSync(pngFile).size > 0) break;
      if (waited > 60000) throw new Error('Chrome did not produce the menu image within 60 seconds.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the write finish
  } finally {
    chrome.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(`Rendered ${path.relative(process.cwd(), pngFile)} (${Math.round(fs.statSync(pngFile).size / 1024)} KB)`);
}

const owner = config.calendar.alertTo;
if (!owner) {
  console.error('Set CALENDAR_ALERT_TO (your LINE user ID) in .env first.');
  process.exit(1);
}

try {
  if (process.argv.includes('--remove')) {
    await client.unlinkRichMenuIdFromUser(owner).catch(() => {});
    await removeExisting();
    console.log('✅ Menu removed.');
    process.exit(0);
  }

  if (process.argv.includes('--render') || !fs.existsSync(pngFile)) await render();
  const png = fs.readFileSync(pngFile);
  if (png.length > 1024 * 1024) throw new Error('The menu image must be under 1 MB.');

  const request = { size: { width: WIDTH, height: HEIGHT }, selected: true, name: MENU_NAME, chatBarText: 'Menu · เมนู', areas: AREAS };
  await client.validateRichMenuObject(request);
  await removeExisting();
  const { richMenuId } = await client.createRichMenu(request);
  await blobClient.setRichMenuImage(richMenuId, new Blob([png], { type: 'image/png' }));
  await client.linkRichMenuIdToUser(owner, richMenuId);
  console.log(`✅ Menu ${richMenuId} created and linked to your LINE account only.`);
  console.log('Open the chat with your OA; the menu appears at the bottom (tap "Menu · เมนู" if it is collapsed).');
} catch (err) {
  console.error('Rich menu setup failed:', err.status ?? '', err.body ?? err.message);
  process.exit(1);
}
