const fs = require('node:fs');
const path = require('node:path');

class JsonDb {
  constructor(dataDir, secretBox = null) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.secretBox = secretBox;
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
  }

  #blank() {
    return { version: 2, links: {}, pendingLinks: {}, rustAccounts: {} };
  }

  #load() {
    if (!fs.existsSync(this.file)) return this.#blank();
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { ...this.#blank(), ...parsed, version: 2 };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  createLinkCode(discordId) {
    for (const [code, entry] of Object.entries(this.data.pendingLinks)) {
      if (entry.discordId === discordId) delete this.data.pendingLinks[code];
    }
    let code;
    do code = String(Math.floor(100000 + Math.random() * 900000));
    while (this.data.pendingLinks[code]);
    this.data.pendingLinks[code] = { discordId, expiresAt: Date.now() + 10 * 60 * 1000 };
    this.save();
    return code;
  }

  consumeLinkCode(code, steamId) {
    const entry = this.data.pendingLinks[code];
    if (!entry) return { ok: false, reason: 'invalid' };
    delete this.data.pendingLinks[code];
    if (entry.expiresAt < Date.now()) {
      this.save();
      return { ok: false, reason: 'expired' };
    }
    for (const [existingSteamId, existingDiscordId] of Object.entries(this.data.links)) {
      if (existingDiscordId === entry.discordId) delete this.data.links[existingSteamId];
    }
    this.data.links[String(steamId)] = entry.discordId;
    this.save();
    return { ok: true, discordId: entry.discordId };
  }

  getDiscordIdBySteamId(steamId) { return this.data.links[String(steamId)] || null; }
  getSteamIdByDiscordId(discordId) {
    for (const [steamId, id] of Object.entries(this.data.links)) if (id === discordId) return steamId;
    return null;
  }
  unlinkDiscord(discordId) {
    let removed = false;
    for (const [steamId, id] of Object.entries(this.data.links)) {
      if (id === discordId) { delete this.data.links[steamId]; removed = true; }
    }
    if (removed) this.save();
    return removed;
  }

  upsertRustAccount(account) {
    const existing = this.data.rustAccounts[account.id] || {};
    const stored = { ...existing, ...account, updatedAt: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(account, 'playerToken')) {
      stored.playerTokenSecret = this.secretBox?.encrypt(account.playerToken) ?? Number(account.playerToken);
      delete stored.playerToken;
    }
    this.data.rustAccounts[account.id] = stored;
    this.save();
    return this.getRustAccount(account.id);
  }

  #hydrateAccount(stored) {
    if (!stored) return null;
    const copy = { ...stored };
    const secret = copy.playerTokenSecret ?? copy.playerToken;
    copy.playerToken = this.secretBox ? this.secretBox.decrypt(secret) : Number(secret?.plaintext ?? secret);
    delete copy.playerTokenSecret;
    return copy;
  }

  removeRustAccount(id) {
    if (!this.data.rustAccounts[id]) return false;
    delete this.data.rustAccounts[id];
    this.save();
    return true;
  }
  listRustAccounts() { return Object.values(this.data.rustAccounts).map((a) => this.#hydrateAccount(a)); }
  getRustAccount(id) { return this.#hydrateAccount(this.data.rustAccounts[id]); }
}

module.exports = { JsonDb };
