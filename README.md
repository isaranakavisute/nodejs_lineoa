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

The morning news is written by Claude from live web searches; each story links to its source. It is generated once per language each day and pushed to every subscribed chat (1:1 or group). Subscribers are saved in `data/news-subscribers.json` (a Docker volume in production), so they survive restarts. Change the schedule with `NEWS_TIME`, `NEWS_TIMEZONE`, `NEWS_LANGUAGE` and `NEWS_STORY_COUNT`.

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
| `src/line.js` | Shared Messaging API client |
| `src/config.js` | Loads and validates environment variables |
| `scripts/push.js` | CLI for sending push messages |
| `scripts/translate.js` | CLI for testing translations |
| `scripts/news.js` | CLI for previewing or sending the news digest |
| `scripts/check.js` | Verifies LINE credentials and webhook settings |
