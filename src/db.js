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

  #blank() { return { version: 4, links: {}, pendingLinks: {}, rustAccounts: {}, rustAuth: {}, manualTeams: {} }; }

  #load() {
    if (!fs.existsSync(this.file)) return this.#blank();
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { ...this.#blank(), ...parsed, version: 4, rustAuth: parsed.rustAuth || {}, manualTeams: parsed.manualTeams || {} };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  createLinkCode(discordId) {
    for (const [code, entry] of Object.entries(this.data.pendingLinks)) if (entry.discordId === discordId) delete this.data.pendingLinks[code];
    let code;
    do code = String(Math.floor(100000 + Math.random() * 900000)); while (this.data.pendingLinks[code]);
    this.data.pendingLinks[code] = { discordId, expiresAt: Date.now() + 10 * 60 * 1000 };
    this.save();
    return code;
  }

  consumeLinkCode(code, steamId) {
    const entry = this.data.pendingLinks[code];
    if (!entry) return { ok: false, reason: 'invalid' };
    delete this.data.pendingLinks[code];
    if (entry.expiresAt < Date.now()) { this.save(); return { ok: false, reason: 'expired' }; }
    this.linkSteamToDiscord(steamId, entry.discordId, false);
    this.save();
    return { ok: true, discordId: entry.discordId };
  }

  linkSteamToDiscord(steamId, discordId, save = true) {
    for (const [existingSteamId, existingDiscordId] of Object.entries(this.data.links)) {
      if (existingDiscordId === String(discordId)) delete this.data.links[existingSteamId];
    }
    this.data.links[String(steamId)] = String(discordId);
    if (save) this.save();
  }

  getDiscordIdBySteamId(steamId) { return this.data.links[String(steamId)] || null; }
  getSteamIdByDiscordId(discordId) {
    for (const [steamId, id] of Object.entries(this.data.links)) if (id === String(discordId)) return steamId;
    return null;
  }
  unlinkDiscord(discordId) {
    let removed = false;
    for (const [steamId, id] of Object.entries(this.data.links)) if (id === String(discordId)) { delete this.data.links[steamId]; removed = true; }
    if (removed) this.save();
    return removed;
  }

  setRustAuth(discordId, authToken, meta = {}) {
    const id = String(discordId);
    this.data.rustAuth[id] = {
      ...this.data.rustAuth[id], ...meta,
      authTokenSecret: this.secretBox?.encryptText(authToken) ?? { plaintextText: String(authToken) },
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.getRustAuth(id);
  }

  getRustAuth(discordId) {
    const stored = this.data.rustAuth[String(discordId)];
    if (!stored) return null;
    return { ...stored, authToken: this.secretBox ? this.secretBox.decryptText(stored.authTokenSecret) : String(stored.authTokenSecret?.plaintextText || ''), authTokenSecret: undefined };
  }

  hasRustAuth(discordId) { return Boolean(this.data.rustAuth[String(discordId)]); }
  removeRustAuth(discordId) { const ok = delete this.data.rustAuth[String(discordId)]; if (ok) this.save(); return ok; }

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
    copy.playerToken = this.secretBox ? this.secretBox.decrypt(secret) : String(secret?.plaintextText ?? secret?.plaintext ?? secret);
    delete copy.playerTokenSecret;
    return copy;
  }

  removeRustAccount(id) {
    if (!this.data.rustAccounts[id]) return false;
    delete this.data.rustAccounts[id];
    for (const team of Object.values(this.data.manualTeams)) {
      team.accountIds = (team.accountIds || []).filter((x) => x !== id);
      if (team.activeAccountId === id) team.activeAccountId = null;
    }
    this.save();
    return true;
  }
  listRustAccounts() { return Object.values(this.data.rustAccounts).map((a) => this.#hydrateAccount(a)); }
  getRustAccount(id) { return this.#hydrateAccount(this.data.rustAccounts[id]); }

  createManualTeam({ name, ownerDiscordId }) {
    const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.data.manualTeams[id] = {
      id,
      name: String(name || 'Manual Team').trim().slice(0, 80) || 'Manual Team',
      ownerDiscordId: String(ownerDiscordId || ''),
      accountIds: [],
      activeAccountId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.save();
    return { ...this.data.manualTeams[id] };
  }

  listManualTeams() { return Object.values(this.data.manualTeams).map((t) => ({ ...t, accountIds: [...(t.accountIds || [])] })); }
  getManualTeam(id) { const t = this.data.manualTeams[id]; return t ? { ...t, accountIds: [...(t.accountIds || [])] } : null; }
  getManualTeamForAccount(accountId) {
    for (const t of Object.values(this.data.manualTeams)) if ((t.accountIds || []).includes(accountId)) return { ...t, accountIds: [...t.accountIds] };
    return null;
  }

  assignAccountToManualTeam(teamId, accountId) {
    const team = this.data.manualTeams[teamId];
    if (!team) throw new Error('Nie znaleziono teamu.');
    if (!this.data.rustAccounts[accountId]) throw new Error('Nie znaleziono konta Rust+.');
    for (const t of Object.values(this.data.manualTeams)) {
      t.accountIds = (t.accountIds || []).filter((x) => x !== accountId);
      if (t.activeAccountId === accountId) t.activeAccountId = null;
    }
    if (!team.accountIds.includes(accountId)) team.accountIds.push(accountId);
    team.updatedAt = new Date().toISOString();
    this.save();
    return this.getManualTeam(teamId);
  }

  unassignAccountFromManualTeam(accountId) {
    let changed = false;
    for (const t of Object.values(this.data.manualTeams)) {
      const before = (t.accountIds || []).length;
      t.accountIds = (t.accountIds || []).filter((x) => x !== accountId);
      if (t.accountIds.length !== before) { changed = true; t.updatedAt = new Date().toISOString(); }
      if (t.activeAccountId === accountId) { t.activeAccountId = null; changed = true; }
    }
    if (changed) this.save();
    return changed;
  }

  setManualTeamActive(teamId, accountId) {
    const team = this.data.manualTeams[teamId];
    if (!team) return false;
    if (accountId && !(team.accountIds || []).includes(accountId)) return false;
    if (team.activeAccountId === (accountId || null)) return true;
    team.activeAccountId = accountId || null;
    team.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  removeManualTeam(teamId) {
    if (!this.data.manualTeams[teamId]) return false;
    delete this.data.manualTeams[teamId];
    this.save();
    return true;
  }
}

module.exports = { JsonDb };
