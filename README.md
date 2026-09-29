# LINE OA Node.js Webhook

Express server that connects to a LINE Official Account through the Messaging API, using the official [`@line/bot-sdk`](https://github.com/line/line-bot-sdk-nodejs). It uses Claude (`@anthropic-ai/sdk`) to chat, translate text into any language, answer questions about photos, and send a morning world news digest.

## Using the bot

Each chat is in one of two modes. 1:1 chats start in **chat mode**; group chats start in **translate mode** so the bot doesn't answer every message people send each other.

| Send | Result |
| --- | --- |
| `/chat` | Chat mode: ask Claude anything. It remembers the last 10 exchanges for up to an hour. Sending `/chat` again starts a new conversation |
| `/translate` | Translate mode: every message is translated |
| `Good morning` (translate mode) | Translated into the chat's target language (default: English; text already in English goes into Thai) |
| `to Japanese: good morning` / `แปลเป็นภาษาจีน สวัสดี` | One-off translation into the named language |
| `/lang Korean` | Switch to translate mode and translate into Korean |
| `/lang` | Show the current setting |
| `/lang reset` | Back to the default |
| A photo, then `What is this?` | Claude answers questions about the photo, in the language you ask in (1:1 chats only) |
| `/done` | Stop asking about the photo and go back to translation |
| `/news on` / `/news on Thai` | Get the top 5 world news stories every morning at 07:00 Bangkok time, in any language |
| `/news off` | Stop the morning news |
| `/news` | Get today's news now |
| `/help` | Show help |

After you send a photo, your text messages are treated as questions about it until you send `/done`, send another photo, or 10 minutes pass without a question. In group chats, photos are ignored so the bot doesn't reply to every shared picture.

The morning news push is **off by default**; set `NEWS_SCHEDULE_ENABLED=true` to turn it on. `/news` works on demand either way. The morning news is written by Claude from live web searches; each story links to its source. It is generated once per language each day and pushed to every subscribed chat (1:1 or group). Subscribers are saved in `data/news-subscribers.json` (a Docker volume in production), so they survive restarts. Change the schedule with `NEWS_TIME`, `NEWS_TIMEZONE`, `NEWS_LANGUAGE` and `NEWS_STORY_COUNT`.

Preview or trigger it by hand:

```sh
npm run news                # preview today's digest in the default language
npm run news -- Thai        # preview in Thai
npm run news -- --send      # push to all subscribers now
```

Each morning push counts toward your LINE plan's monthly message quota (one message per subscriber per day). Replies to user messages are free.

Modes, language settings, chat history, and photo conversations are kept in memory and reset when the server restarts.

## 1. Create the channel

1. Go to the [LINE Official Account Manager](https://manager.line.biz/) and create an Official Account (or open an existing one).
2. Under **Settings → Messaging API**, enable the Messaging API. This creates a channel in the [LINE Developers Console](https://developers.line.biz/console/).
3. In the Developers Console, open the channel:
   - **Basic settings** tab: copy the **Channel secret**.
   - **Messaging API** tab: issue a **Channel access token (long-lived)** and copy it.
4. In LINE Official Account Manager → **Response settings**, turn **Webhooks** on. Turn **Auto-response messages** off if you don't want the default replies alongside your bot's.

## 2. Configure

```sh
npm install
cp .env.example .env   # then fill in LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, ANTHROPIC_API_KEY
```

Get an Anthropic API key at <https://platform.claude.com/settings/keys>. Optional settings: `CLAUDE_MODEL` (default `claude-opus-5`), `DEFAULT_TARGET_LANGUAGE` (default `English`), `DEFAULT_SECONDARY_LANGUAGE` (default `Thai`).

Try translation without LINE:

```sh
npm run translate -- "สวัสดีครับ ยินดีที่ได้รู้จัก"
npm run translate -- "Good morning" Japanese
```

## 3. Run

```sh
npm run dev     # auto-restarts when files change
npm start       # production
npm test        # webhook signature tests
```

## 4. Expose the webhook to LINE

LINE needs a public HTTPS URL. For local development, use a tunnel:

```sh
npx ngrok http 3000
# or: cloudflared tunnel --url http://localhost:3000
```

In the Developers Console → **Messaging API** tab → **Webhook settings**:

- Set **Webhook URL** to `https://<your-tunnel-host>/webhook`
- Click **Verify** (should succeed)
- Turn on **Use webhook**

Scan the channel's QR code to add the bot as a friend, then send it a message.

## Production with Docker

LINE requires the webhook to be **HTTPS with a valid CA-signed certificate** (no self-signed, no plain HTTP). The included `docker-compose.yml` runs the app behind [Caddy](https://caddyserver.com/), which gets and renews a Let's Encrypt certificate automatically.

On a server with Docker installed:

1. Point a domain (e.g. `bot.example.com`) at the server with a DNS A record.
2. Open ports **80** and **443** in the firewall/security group (80 is needed for certificate issuance).
3. Create `.env` with `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `DOMAIN=bot.example.com`.
4. Start it:

   ```sh
   docker compose up -d --build
   docker compose logs -f
   ```

5. In the LINE Developers Console, set the Webhook URL to `https://bot.example.com/webhook` and click **Verify**.

If you already have HTTPS termination (a cloud load balancer, nginx, or a platform like Cloud Run, Render, Fly.io, or Railway), skip Caddy and run only the app image:

```sh
docker build -t lineoa .
docker run -d --restart unless-stopped --env-file .env -p 3000:3000 lineoa
```

Platforms that inject `PORT` are supported automatically.

## Calendar alerts (Outlook.com / Hotmail)

Send `/calendarhelp` (or `/calhelp`) in LINE for a guide to all calendar commands.

The bot can check your Outlook calendar every minute and send you a LINE message 1 hour before each meeting. This does not use Claude. Declined, cancelled and all-day events are skipped, and meetings starting at the same time are combined into one message. Each alert is a push message and counts toward your LINE plan's monthly quota. Send `/calendar` to the bot to see all of today's meetings (finished ones marked ✔️), `/calendar tomorrow` for tomorrow, or `/calendar week` for this week (Monday to Sunday) grouped by day (buttons under the reply switch between them); that's a reply, so it's free. Only the owner (`CALENDAR_ALERT_TO`) can use it.

For testing, the owner can also add meetings from LINE (replies, so free):

| Send | Result |
| --- | --- |
| `/meet in 30 Test` | Adds "Test" starting 30 minutes from now |
| `/meet 14:30 Standup` | Today at 14:30 (tomorrow if that time has passed) |
| `/meet tomorrow 9:00 Review` / `/meet 2026-10-01 10:00 Planning` | A specific day |
| `/meet 14:30 1h Workshop` | With a length (default 30 minutes) |
| `/meet undo` | Deletes the last meeting added from LINE (since the server started) |
| `/meet` | Shows these options |

Adding meetings needs calendar write access (`Calendars.ReadWrite`); the sign-in below asks for it. If you signed in before `/meet` existed, alerts keep working, but run the sign-in again to allow `/meet`.

### 1. Register an app with Microsoft (one time)

1. Go to <https://entra.microsoft.com> (or <https://portal.azure.com>) and sign in with your Hotmail account. If it asks you to create a free Azure account or directory, do that first.
2. **App registrations → New registration**
   - Name: `LINE calendar alerts`
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: leave empty
3. Copy the **Application (client) ID**.
4. **Authentication** → **Allow public client flows** → **Yes** → Save.
5. **API permissions** should include Microsoft Graph `Calendars.ReadWrite`, `Mail.Send` and `Mail.Read` (delegated). Add it if it's missing. There's no client secret to create.

### 2. Configure

Add to `.env`:

```
MICROSOFT_CLIENT_ID=<Application (client) ID>
CALENDAR_ALERT_TO=<your LINE user ID>
```

Your LINE user ID (starts with `U`) is shown as **Your user ID** on the channel's **Basic settings** tab in the LINE Developers Console. Optional: `CALENDAR_ALERT_MINUTES` (default `60`) and `CALENDAR_TIMEZONE` (default `Asia/Bangkok`).

### 3. Sign in (one time)

```sh
npm run microsoft-login                            # local
docker compose exec app npm run microsoft-login    # production
```

It prints a code. Open <https://microsoft.com/devicelogin>, enter the code, sign in, and approve access to your calendar. The script then lists today's meetings to confirm it works. Only a refresh token is saved (in `data/microsoft-token.json`, inside the Docker volume in production); your password is never stored. If you change your Microsoft password or revoke access, run the sign-in again; the server log will say `Calendar alerts paused` when that's needed.

Restart the server after setting the `.env` values. The log shows `Calendar alerts on: 60 min before each meeting`.

## Sending email (Outlook.com / Hotmail)

The owner (`CALENDAR_ALERT_TO`) can send email from their Outlook account through LINE. It uses the same Microsoft sign-in as calendar alerts, with the `Mail.Send` permission, and does not use Claude. Replies only, so no LINE quota is used.

Write the message as three parts on separate lines:

```
/email friend@example.com
Subject line
Message text (can be several lines)
```

The bot shows a preview. Reply `/send` to send it or `/cancel` to discard it; drafts expire after 10 minutes. Several recipients can be separated with commas (up to 10). Sent messages are saved in your Sent folder. If you signed in before email was added, run `npm run microsoft-login` again to approve sending.

## Checking email (Outlook.com / Hotmail)

Send `/emailhelp` (or `/mailhelp`) in LINE for a guide to all email commands. The owner's `/help` also lists their private commands.

The owner can send `/inbox` (or `/mail`) to get today's unread emails from their Outlook **Inbox and Junk Email** folders. It needs the `Mail.Read` permission, doesn't use Claude, and is a reply, so no LINE quota is used. Checking does **not** mark emails as read.

Under the list are buttons to **reply, reply to all or forward**. With several emails, tap an email's number first; you can also type `/inbox 2`, `/reply 2`, `/replyall 2` or `/forward 2`. For a reply, tap a standard response such as *"Your message is well received. I will get back to you."* (the greeting "Dear <sender>," / "Dear all," and "Best Regards, <EMAIL_SIGNATURE>" are added) or type your own. For a forward, type the address, then pick a note (FYI, Please review, Please handle) or type one. You always see a preview, and nothing is sent until you tap ✅ Send. The reply is plain text with the original email quoted underneath, and a copy is saved in Sent Items. This uses only `Mail.Send`, so there's no need to sign in again. Edit the responses in `REPLY_TEMPLATES` and `FORWARD_NOTES` in `src/mailActions.js`.

The reply shows how many unread emails arrived since midnight (`CALENDAR_TIMEZONE`), split by folder, then for each one, newest first (junk marked ⚠️ [Junk]): subject, sender, recipients (To and Cc), the time it was sent, and the first 5 lines of the message. Up to 30 emails are listed; if there are more, the reply says so. If you signed in before this was added, run `npm run microsoft-login` again to approve reading mail.

## Posting to Facebook (Page)

The owner can post to their **Facebook Page** from LINE. Facebook doesn't let apps post to personal profiles, so this only works with a Page. No Claude involved; replies only, so no LINE quota. Send `/fbhelp` in LINE for the command guide.

| Send | Result |
| --- | --- |
| `/fb Your text` | Preview of a text post (a web address in it becomes a link preview) |
| A photo, then `/fbphoto Caption` | Preview of a photo post (caption optional) |
| `/post` | Publishes the previewed post and replies with its link |
| `/cancel` | Discards it (also discards a pending email) |

Nothing is published until you send `/post`; drafts expire after 10 minutes.

### Setup (one time)

1. **Create a Meta app:** <https://developers.facebook.com/apps> → **Create app** → use case **Other** → type **Business**. Leave it in **Development** mode.
2. **Copy the App ID and App secret** (App settings → Basic) into `.env` as `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`.
3. **Get a short-lived token:** open the [Graph API Explorer](https://developers.facebook.com/tools/explorer/), choose your app, click **Get User Access Token**, and tick `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`. Approve access to your Page when Facebook asks, then copy the token.
4. **Turn it into a Page token:**
   ```sh
   npm run facebook-token -- <paste the token>
   ```
   It prints `FACEBOOK_PAGE_ID` and a long-lived `FACEBOOK_PAGE_ACCESS_TOKEN` (expires: never). Put both in `.env` and restart the bot.

The Page token stops working if you change your Facebook password, remove the app, or lose admin rights on the Page; run steps 3–4 again then. Keep the token secret: anyone with it can post to your Page.

**Development mode:** posts made while the app is in Development mode may only be visible to people with a role on the app (you). After your first post, open it in a private browser window while logged out. If it isn't visible, switch the app to **Live** in the Meta dashboard (it asks for a privacy policy URL).

## Owner menu (tap instead of typing)

The owner gets a private **Rich Menu**, a panel of 6 buttons at the bottom of the LINE chat: 📬 Inbox, ✉️ Email, 📅 Calendar, 📘 Facebook, 💬 Chat / Translate and ❓ Help. Other users don't see it. `/menu` shows the same buttons as a message.

Buttons either run a command straight away (Inbox, Today's meetings), open a small set of choices, or start a **step-by-step guide** that asks one question at a time with tap-to-choose answers:

- ✉️ **Email:** recipient → subject → message → preview with **✅ Send / ❌ Cancel**
- 📅 **Add meeting:** when (In 30 min, In 1 hour, Tomorrow 9:00, … or type a time) → length → title → **✅ Add**
- 📘 **Facebook:** text post, or photo post (📷 Camera / 🖼 Gallery → caption) → preview with **✅ Post**
- 🌐 **Translate:** English, Thai, Japanese, Chinese, Korean, or type any language

Every step has **❌ Cancel**. Typing any `/command` abandons a guide in progress. Typed commands keep working as before. Guides end by running the same command you could type, and sending or posting still needs your ✅ tap.

Create or update the menu (run from a Mac with Google Chrome; it talks to LINE directly, so there's no need to run it on the server):

```sh
npm run richmenu                # upload assets/richmenu-owner.png and link it to CALENDAR_ALERT_TO
npm run richmenu -- --render    # re-draw the image from assets/richmenu-owner.html first
npm run richmenu -- --remove    # remove the menu
```

## Push messages

```sh
npm run push -- <userId> "Hello from Node.js"
```

The user ID (`U...`) appears in webhook events (`event.source.userId`) and is also listed as **Your user ID** on the channel's **Basic settings** tab.

## Project layout

| File | Purpose |
| --- | --- |
| `src/index.js` | Starts the HTTP server |
| `src/app.js` | Express app and `/webhook` route with signature verification |
| `src/handlers.js` | Event handling and `/lang`, `/help` commands |
| `src/chat.js` | Claude chat call and prompt |
| `src/translate.js` | Claude translation call and prompt |
| `src/vision.js` | Image download from LINE and Claude image Q&A |
| `src/news.js` | Claude + web search news digest |
| `src/newsScheduler.js` | Daily schedule and push to subscribers |
| `src/store.js` | Saves news subscribers to disk |
| `src/microsoft.js` | Microsoft sign-in and Graph API requests |
| `src/calendar.js` | Reads Outlook calendar events and formats alerts |
| `src/calendarScheduler.js` | Checks the calendar every minute and sends alerts |
| `src/mail.js` | Parses and sends email through Outlook |
| `src/inbox.js` | Lists today's unread emails (Inbox and Junk) |
| `src/mailActions.js` | Reply / reply all / forward with standard responses |
| `src/facebook.js` | Posts text and photos to your Facebook Page |
| `src/menu.js` | Owner menu: button taps, sub-menus and step-by-step guides |
| `src/line.js` | Shared Messaging API client |
| `src/config.js` | Loads and validates environment variables |
| `scripts/push.js` | CLI for sending push messages |
| `scripts/translate.js` | CLI for testing translations |
| `scripts/news.js` | CLI for previewing or sending the news digest |
| `scripts/microsoft-login.js` | One-time Microsoft sign-in for calendar alerts |
| `scripts/facebook-token.js` | Creates the long-lived Facebook Page token |
| `scripts/richmenu.js` | Creates the owner's Rich Menu and links it to them |
| `assets/richmenu-owner.html` / `.png` | The Rich Menu image and its source |
| `scripts/check.js` | Verifies LINE credentials and webhook settings |
