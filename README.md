# LINE OA Node.js Webhook

Express server that connects to a LINE Official Account through the Messaging API, using the official [`@line/bot-sdk`](https://github.com/line/line-bot-sdk-nodejs). Out of the box, it echoes back any text message it receives.

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
cp .env.example .env   # then fill in LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN
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
| `src/handlers.js` | Event handling; put your bot logic here |
| `src/line.js` | Shared Messaging API client |
| `src/config.js` | Loads and validates environment variables |
| `scripts/push.js` | CLI for sending push messages |
