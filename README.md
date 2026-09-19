# Rust Helper v0.4

Discord + Rust+ helper bot for Railway. It supports multiple Rust+ accounts, automatic team grouping, one sticky ACTIVE sender per team with BACKUP failover, in-game commands, event alerts and a web panel.

## v0.4: web-assisted Rust+ pairing

The web panel now has a **Połącz Rust+ przez Steam** flow:

1. User signs in to Rust Helper with Discord.
2. User clicks **Połącz Rust+ przez Steam**.
3. Browser is redirected to the official Facepunch Rust+ login (`companion-rust.facepunch.com`). Steam credentials are entered only on Steam/Facepunch pages.
4. After Facepunch returns the Rust+ auth token to the configured `returnUrl`, Rust Helper stores it encrypted.
5. User clicks **Start pairingu**, enters Rust and uses **ESC → Rust+ → Pair with Server**.
6. Rust Helper polls the Rust Companion history endpoint and imports a new server pairing automatically (`ip`, `app.port`, `playerId`, `playerToken`).
7. The account is connected immediately and is included in ACTIVE/BACKUP routing.

### Important beta note

The Facepunch Rust+ web login was designed primarily for the companion app. The normal-browser `returnUrl` flow has existed in Rust+ pairing tools, but Facepunch can change this behavior. For that reason the manual pairing form remains available under **Tryb awaryjny**. No Steam password is ever collected by Rust Helper.

## In-game commands

- `!help`
- `!time`
- `!cargo`
- `!heli`
- `!chinook`
- `!crate`
- `!events`
- `!team`
- `!online`
- `!status`
- `!server`
- `!ping`
- `!link CODE`

## Team routing

For every detected Rust team on a server:

- one connected account is `ACTIVE`,
- other connected accounts are `BACKUP`,
- ACTIVE is sticky,
- when ACTIVE leaves/disconnects, another account takes over,
- a returning old primary stays BACKUP until the current ACTIVE fails.

Different teams and servers are routed independently.

## Railway variables

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_GUILD_ID=
DISCORD_ACCESS_ROLE_ID=
ADMIN_DISCORD_IDS=

SESSION_SECRET=
ENCRYPTION_KEY=
BASE_URL=https://your-service.up.railway.app
PORT=3000
DATA_DIR=./data

RUST_COMMAND_PREFIX=!
TEAM_CHAT_POLL_MS=2500
TEAM_INFO_POLL_MS=10000
EVENT_POLL_MS=15000
EVENT_ALERTS_ENABLED=true
DISCORD_ALERT_CHANNEL_ID=
```

Discord OAuth redirect URI:

```text
https://your-service.up.railway.app/auth/discord/callback
```

Mount a Railway Volume at:

```text
/app/data
```

## Local start

```bash
npm install
npm run check
npm start
```

## Security

- Do not commit `.env` or `data/`.
- Keep `ENCRYPTION_KEY` stable after tokens are stored.
- Rust+ auth tokens and server `playerToken`s are encrypted with AES-256-GCM when `ENCRYPTION_KEY` is configured.
- Steam passwords are never submitted to this application.
