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

  #blank() { return { version: 6, links: {}, pendingLinks: {}, rustAccounts: {}, rustAuth: {}, manualTeams: {}, smartDevices: {}, smartGroups: {}, deltaRaids: [] }; }

  #load() {
    if (!fs.existsSync(this.file)) return this.#blank();
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { ...this.#blank(), ...parsed, version: 6, rustAuth: parsed.rustAuth || {}, manualTeams: parsed.manualTeams || {}, smartDevices: parsed.smartDevices || {}, smartGroups: parsed.smartGroups || {}, deltaRaids: Array.isArray(parsed.deltaRaids) ? parsed.deltaRaids : [] };
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
    for (const [deviceId, device] of Object.entries(this.data.smartDevices)) {
      if (device.accountId === id) delete this.data.smartDevices[deviceId];
    }
    for (const [groupId, group] of Object.entries(this.data.smartGroups)) {
      group.deviceIds = (group.deviceIds || []).filter((deviceId) => this.data.smartDevices[deviceId]);
      if (group.accountId === id || group.deviceIds.length === 0) delete this.data.smartGroups[groupId];
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


  createSmartGroup({ name, ownerDiscordId, accountId }) {
    if (!this.data.rustAccounts[accountId]) throw new Error('Nie znaleziono konta Rust+.');
    const id = `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.data.smartGroups[id] = {
      id,
      name: String(name || 'Smart Group').trim().slice(0, 80) || 'Smart Group',
      ownerDiscordId: String(ownerDiscordId || ''),
      accountId: String(accountId),
      deviceIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.getSmartGroup(id);
  }

  listSmartGroups() {
    return Object.values(this.data.smartGroups).map((g) => ({ ...g, deviceIds: [...(g.deviceIds || [])] }));
  }
  getSmartGroup(id) {
    const g = this.data.smartGroups[String(id)];
    return g ? { ...g, deviceIds: [...(g.deviceIds || [])] } : null;
  }
  removeSmartGroup(id) {
    const group = this.data.smartGroups[String(id)];
    if (!group) return false;
    for (const deviceId of group.deviceIds || []) {
      const d = this.data.smartDevices[deviceId];
      if (d) d.groupId = null;
    }
    delete this.data.smartGroups[String(id)];
    this.save();
    return true;
  }

  addSmartDevice({ name, ownerDiscordId, accountId, entityId, groupId = null }) {
    if (!this.data.rustAccounts[accountId]) throw new Error('Nie znaleziono konta Rust+.');
    const entity = String(entityId || '').trim();
    if (!/^\d+$/.test(entity)) throw new Error('Entity ID musi być liczbą.');
    const entityNumber = Number(entity);
    if (!Number.isSafeInteger(entityNumber) || entityNumber <= 0) throw new Error('Nieprawidłowe Entity ID.');
    if (groupId) {
      const group = this.data.smartGroups[groupId];
      if (!group) throw new Error('Nie znaleziono grupy.');
      if (group.accountId !== String(accountId)) throw new Error('Grupa używa innego konta Rust+.');
    }
    for (const d of Object.values(this.data.smartDevices)) {
      if (d.accountId === String(accountId) && d.entityId === entity) throw new Error('To urządzenie jest już dodane do tego konta Rust+.');
    }
    const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.data.smartDevices[id] = {
      id,
      name: String(name || `Smart Switch ${entity}`).trim().slice(0, 80) || `Smart Switch ${entity}`,
      ownerDiscordId: String(ownerDiscordId || ''),
      accountId: String(accountId),
      entityId: entity,
      groupId: groupId || null,
      type: 'smart-switch',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (groupId) {
      const group = this.data.smartGroups[groupId];
      if (!group.deviceIds.includes(id)) group.deviceIds.push(id);
      group.updatedAt = new Date().toISOString();
    }
    this.save();
    return this.getSmartDevice(id);
  }

  listSmartDevices() { return Object.values(this.data.smartDevices).map((d) => ({ ...d })); }
  getSmartDevice(id) { const d = this.data.smartDevices[String(id)]; return d ? { ...d } : null; }
  removeSmartDevice(id) {
    const device = this.data.smartDevices[String(id)];
    if (!device) return false;
    if (device.groupId && this.data.smartGroups[device.groupId]) {
      const group = this.data.smartGroups[device.groupId];
      group.deviceIds = (group.deviceIds || []).filter((x) => x !== String(id));
      group.updatedAt = new Date().toISOString();
    }
    delete this.data.smartDevices[String(id)];
    this.save();
    return true;
  }

  assignSmartDeviceToGroup(deviceId, groupId) {
    const device = this.data.smartDevices[String(deviceId)];
    const group = this.data.smartGroups[String(groupId)];
    if (!device || !group) throw new Error('Nie znaleziono urządzenia lub grupy.');
    if (device.accountId !== group.accountId) throw new Error('Urządzenie i grupa muszą używać tego samego konta Rust+.');
    if (device.groupId && this.data.smartGroups[device.groupId]) {
      const old = this.data.smartGroups[device.groupId];
      old.deviceIds = (old.deviceIds || []).filter((x) => x !== device.id);
      old.updatedAt = new Date().toISOString();
    }
    device.groupId = group.id;
    device.updatedAt = new Date().toISOString();
    if (!group.deviceIds.includes(device.id)) group.deviceIds.push(device.id);
    group.updatedAt = new Date().toISOString();
    this.save();
    return this.getSmartDevice(device.id);
  }

  unassignSmartDevice(deviceId) {
    const device = this.data.smartDevices[String(deviceId)];
    if (!device) return false;
    if (device.groupId && this.data.smartGroups[device.groupId]) {
      const group = this.data.smartGroups[device.groupId];
      group.deviceIds = (group.deviceIds || []).filter((x) => x !== device.id);
      group.updatedAt = new Date().toISOString();
    }
    device.groupId = null;
    device.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  removeManualTeam(teamId) {
    if (!this.data.manualTeams[teamId]) return false;
    delete this.data.manualTeams[teamId];
    this.save();
    return true;
  }

  addDeltaRaid({ guildId, userId, result, amount, entryCost = null, carryOutValue = null, matchCost = null, mapName = null, kills = null, note = null }) {
    const id = `df-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const raid = {
      id,
      guildId: String(guildId),
      userId: String(userId),
      result: result === 'win' ? 'win' : 'loss',
      amount: Number(amount),
      entryCost: entryCost == null ? null : Number(entryCost),
      carryOutValue: carryOutValue == null ? null : Number(carryOutValue),
      matchCost: matchCost == null ? null : Number(matchCost),
      mapName: mapName ? String(mapName).trim().slice(0, 80) : null,
      kills: kills == null ? null : Number(kills),
      note: note ? String(note).trim().slice(0, 200) : null,
      createdAt: new Date().toISOString()
    };
    if (!Number.isSafeInteger(raid.amount)) throw new Error('Nieprawidłowa kwota.');
    for (const v of [raid.entryCost, raid.carryOutValue, raid.matchCost]) {
      if (v != null && (!Number.isSafeInteger(v) || v < 0)) throw new Error('Nieprawidłowe dane ekonomiczne raidu.');
    }
    this.data.deltaRaids.push(raid);
    this.save();
    return { ...raid };
  }

  listDeltaRaids(guildId, userId, limit = 10) {
    const gid = String(guildId), uid = String(userId);
    return this.data.deltaRaids
      .filter(r => r.guildId === gid && r.userId === uid)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 10)))
      .map(r => ({ ...r }));
  }

  getDeltaStats(guildId, userId) {
    const rows = this.listDeltaRaids(guildId, userId, 1000000);
    const wins = rows.filter(r => r.result === 'win').length;
    const losses = rows.filter(r => r.result === 'loss').length;
    const amounts = rows.map(r => Number(r.amount) || 0);
    return {
      total: rows.length,
      wins,
      losses,
      netTotal: amounts.reduce((a, b) => a + b, 0),
      profitTotal: amounts.filter(x => x > 0).reduce((a, b) => a + b, 0),
      lossTotal: amounts.filter(x => x < 0).reduce((a, b) => a + b, 0),
      bestRaid: amounts.length ? Math.max(...amounts) : 0,
      worstRaid: amounts.length ? Math.min(...amounts) : 0
    };
  }

  removeLastDeltaRaid(guildId, userId) {
    const gid = String(guildId), uid = String(userId);
    let idx = -1;
    for (let i = this.data.deltaRaids.length - 1; i >= 0; i--) {
      const r = this.data.deltaRaids[i];
      if (r.guildId === gid && r.userId === uid) { idx = i; break; }
    }
    if (idx < 0) return null;
    const [removed] = this.data.deltaRaids.splice(idx, 1);
    this.save();
    return { ...removed };
  }

  removeDeltaRaid(id, guildId, userId) {
    const idx = this.data.deltaRaids.findIndex(r => r.id === String(id) && r.guildId === String(guildId) && r.userId === String(userId));
    if (idx < 0) return null;
    const [removed] = this.data.deltaRaids.splice(idx, 1);
    this.save();
    return { ...removed };
  }

}

module.exports = { JsonDb };
