const config = require('./config');
const { SecretBox } = require('./crypto');
const { JsonDb } = require('./db');
const { DiscordManager } = require('./discord');
const { RustManager } = require('./rust');
const { PairingManager } = require('./pairing');
const { PairingApi } = require('./api');

async function main() {
  const secretBox = new SecretBox(config.encryptionKey);
  if (!secretBox.enabled) console.warn('[Security] ENCRYPTION_KEY missing: Rust+ tokens are not encrypted at rest.');

  const db = new JsonDb(config.dataDir, secretBox);
  const discord = new DiscordManager({ config, db });
  const rust = new RustManager({
    db,
    discord,
    prefix: config.prefix,
    chatPollMs: config.teamChatPollMs,
    teamInfoPollMs: config.teamInfoPollMs,
    eventPollMs: config.eventPollMs,
    eventAlertsEnabled: config.eventAlertsEnabled
  });
  const pairing = new PairingManager({
    db,
    rustManager: rust,
    baseUrl: config.baseUrl,
    onPaired: async (discordId, result) => discord.notifyPairingComplete(discordId, result)
  });
  discord.setRustManager(rust);
  discord.setPairingManager(pairing);

  await discord.start();
  rust.startAll();
  const api = new PairingApi({ config, pairingManager: pairing });
  api.start();

  const shutdown = () => {
    console.log('Shutting down...');
    api.stop();
    for (const account of db.listRustAccounts()) rust.stop(account.id);
    discord.client.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
