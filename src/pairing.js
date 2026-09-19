const crypto = require('node:crypto');

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try { return JSON.parse(trimmed); } catch (_) { return value; }
}

function collectObjects(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;
  const parsed = parseMaybeJson(value);
  if (parsed !== value) return collectObjects(parsed, out, depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    out.push(value);
    for (const v of Object.values(value)) collectObjects(v, out, depth + 1);
  }
  return out;
}

function getCaseInsensitive(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [k, v] of Object.entries(obj)) if (wanted.has(k.toLowerCase())) return v;
  return undefined;
}

function normalizePairingEvent(event) {
  for (const obj of collectObjects(event)) {
    const ip = getCaseInsensitive(obj, ['ip', 'host', 'hostname']);
    const port = getCaseInsensitive(obj, ['port', 'appPort', 'app.port']);
    const playerId = getCaseInsensitive(obj, ['playerId', 'steamId', 'steamID64', 'playerid']);
    const playerToken = getCaseInsensitive(obj, ['playerToken', 'playertoken']);
    const type = String(getCaseInsensitive(obj, ['type']) || '').toLowerCase();
    if (!ip || !port || !playerId || playerToken == null) continue;
    if (type && type !== 'server') continue;
    const tokenText = String(playerToken).trim();
    const steamText = String(playerId).trim();
    if (!/^-?\d+$/.test(tokenText) || !/^\d{16,20}$/.test(steamText)) continue;
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) continue;
    return {
      ip: String(ip).trim(),
      port: portNum,
      playerId: steamText,
      playerToken: tokenText,
      serverId: String(getCaseInsensitive(obj, ['id', 'serverId']) || ''),
      name: String(getCaseInsensitive(obj, ['name', 'serverName']) || getCaseInsensitive(event, ['body', 'title']) || 'Rust server').trim()
    };
  }
  return null;
}


function normalizeEntityPairingEvent(event) {
  for (const obj of collectObjects(event)) {
    const entityId = getCaseInsensitive(obj, ['entityId', 'entityID', 'entity']);
    const entityType = getCaseInsensitive(obj, ['entityType', 'entity_type']);
    const entityName = getCaseInsensitive(obj, ['entityName', 'entity_name', 'name']);
    const type = String(getCaseInsensitive(obj, ['type']) || '').toLowerCase();
    if (entityId == null) continue;
    const entityText = String(entityId).trim();
    if (!/^\d+$/.test(entityText)) continue;
    const entityNum = Number(entityText);
    if (!Number.isSafeInteger(entityNum) || entityNum <= 0) continue;
    if (type && type !== 'entity') continue;
    const typeNum = Number(entityType || 0) || 0;
    return {
      entityId: entityText,
      entityType: typeNum,
      entityName: String(entityName || (typeNum === 1 ? 'Smart Switch' : 'Smart Device')).trim().slice(0, 120),
      serverName: String(getCaseInsensitive(obj, ['server_name', 'serverName']) || '').trim(),
      ip: String(getCaseInsensitive(obj, ['ip', 'host', 'hostname']) || '').trim(),
      port: Number(getCaseInsensitive(obj, ['port', 'appPort', 'app.port']) || 0) || 0
    };
  }
  return null;
}

class PairingManager {
  constructor({ db, rustManager, baseUrl, onPaired = null, onDevicePaired = null }) {
    this.db = db;
    this.rustManager = rustManager;
    this.baseUrl = baseUrl;
    this.onPaired = onPaired;
    this.onDevicePaired = onDevicePaired;
    this.tickets = new Map();
    this.deviceTickets = new Map();
  }

  createTicket(discordId) {
    const code = crypto.randomBytes(9).toString('base64url').toUpperCase();
    const expiresAt = Date.now() + 15 * 60_000;
    for (const [existingCode, ticket] of this.tickets) {
      if (ticket.discordId === String(discordId)) this.tickets.delete(existingCode);
    }
    this.tickets.set(code, { discordId: String(discordId), expiresAt, phase: 'waiting', result: null });
    return { code, expiresAt, uploadUrl: `${this.baseUrl}/api/pairing/${encodeURIComponent(code)}/complete` };
  }

  getTicketForDiscord(discordId) {
    for (const [code, ticket] of this.tickets) {
      if (ticket.discordId !== String(discordId)) continue;
      if (ticket.expiresAt < Date.now()) { this.tickets.delete(code); continue; }
      return { code, ...ticket, uploadUrl: `${this.baseUrl}/api/pairing/${encodeURIComponent(code)}/complete` };
    }
    return null;
  }

  status(discordId) {
    const ticket = this.getTicketForDiscord(discordId);
    if (!ticket) return { phase: 'idle' };
    return { phase: ticket.phase, code: ticket.code, expiresAt: ticket.expiresAt, result: ticket.result || null };
  }

  cancel(discordId) {
    for (const [code, ticket] of this.tickets) if (ticket.discordId === String(discordId)) this.tickets.delete(code);
  }

  completeTicket(code, payload) {
    const ticket = this.tickets.get(String(code).toUpperCase());
    if (!ticket || ticket.expiresAt < Date.now()) {
      this.tickets.delete(String(code).toUpperCase());
      throw new Error('Kod pairingu jest nieprawidłowy albo wygasł.');
    }
    if (ticket.phase === 'paired') return ticket.result;

    const pair = normalizePairingEvent(payload);
    if (!pair) throw new Error('Nie znalazłem kompletu danych pairingu: ip, port, playerId i playerToken.');

    const accountHash = crypto.createHash('sha1').update(`${pair.playerId}|${pair.ip}|${pair.port}`).digest('hex').slice(0, 12);
    const account = this.db.upsertRustAccount({
      id: `web-${ticket.discordId}-${accountHash}`,
      name: pair.name || 'Rust server',
      ip: pair.ip,
      port: pair.port,
      playerId: pair.playerId,
      playerToken: pair.playerToken,
      ownerDiscordId: ticket.discordId,
      serverPairId: pair.serverId || undefined
    });
    this.db.linkSteamToDiscord(pair.playerId, ticket.discordId);
    this.rustManager.start(account);
    ticket.phase = 'paired';
    ticket.result = { accountId: account.id, name: account.name, ip: account.ip, port: account.port, playerId: account.playerId };
    ticket.expiresAt = Date.now() + 5 * 60_000;
    if (this.onPaired) Promise.resolve(this.onPaired(ticket.discordId, ticket.result)).catch((err) => console.error('[Pairing] notify failed:', err?.message || err));
    return ticket.result;
  }

  createDeviceTicket(discordId, { name = '', groupId = null } = {}) {
    const code = `DEV-${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
    const expiresAt = Date.now() + 15 * 60_000;
    for (const [existingCode, ticket] of this.deviceTickets) {
      if (ticket.discordId === String(discordId)) this.deviceTickets.delete(existingCode);
    }
    this.deviceTickets.set(code, { discordId: String(discordId), expiresAt, phase: 'waiting', result: null, name: String(name || '').trim(), groupId: groupId || null });
    return { code, expiresAt, uploadUrl: `${this.baseUrl}/api/device-pairing/${encodeURIComponent(code)}/complete` };
  }

  deviceStatus(discordId) {
    for (const [code, ticket] of this.deviceTickets) {
      if (ticket.discordId !== String(discordId)) continue;
      if (ticket.expiresAt < Date.now()) { this.deviceTickets.delete(code); continue; }
      return { phase: ticket.phase, code, expiresAt: ticket.expiresAt, result: ticket.result || null };
    }
    return { phase: 'idle' };
  }

  async completeDeviceTicket(code, payload) {
    const key = String(code || '').toUpperCase();
    const ticket = this.deviceTickets.get(key);
    if (!ticket || ticket.expiresAt < Date.now()) {
      this.deviceTickets.delete(key);
      throw new Error('Kod urządzenia jest nieprawidłowy albo wygasł.');
    }
    if (ticket.phase === 'paired') return ticket.result;

    const entity = normalizeEntityPairingEvent(payload);
    if (!entity) throw new Error('Nie znalazłem danych parowania urządzenia (entityId/entityType).');
    if (entity.entityType && entity.entityType !== 1) {
      throw new Error(`To urządzenie nie jest Smart Switchem (entityType=${entity.entityType}).`);
    }

    const accounts = this.db.listRustAccounts().filter((a) => a.ownerDiscordId === ticket.discordId);
    if (!accounts.length) throw new Error('Najpierw połącz konto Rust+ komendą /pair.');

    let account = null;
    if (entity.ip && entity.port) {
      account = accounts.find((a) => String(a.ip) === entity.ip && Number(a.port) === Number(entity.port)) || null;
    }
    if (!account) {
      for (const candidate of accounts) {
        try {
          await this.rustManager.getSmartDeviceInfo(candidate.id, entity.entityId);
          account = candidate;
          break;
        } catch (_) {}
      }
    }
    if (!account && accounts.length === 1) account = accounts[0];
    if (!account) throw new Error('Nie udało się ustalić, do którego konta Rust+ należy ten Smart Switch.');

    let groupId = ticket.groupId || null;
    if (groupId) {
      const group = this.db.getSmartGroup(groupId);
      if (!group || group.ownerDiscordId !== ticket.discordId || group.accountId !== account.id) groupId = null;
    }

    const device = this.db.addSmartDevice({
      name: ticket.name || entity.entityName || `Smart Switch ${entity.entityId}`,
      ownerDiscordId: ticket.discordId,
      accountId: account.id,
      entityId: entity.entityId,
      groupId
    });
    let state = null;
    try { state = (await this.rustManager.getSmartDeviceInfo(account.id, entity.entityId)).value; } catch (_) {}

    ticket.phase = 'paired';
    ticket.result = { deviceId: device.id, name: device.name, entityId: device.entityId, accountId: device.accountId, groupId: device.groupId, state };
    ticket.expiresAt = Date.now() + 5 * 60_000;
    if (this.onDevicePaired) Promise.resolve(this.onDevicePaired(ticket.discordId, ticket.result)).catch((err) => console.error('[Pairing] device notify failed:', err?.message || err));
    return ticket.result;
  }
}

module.exports = { PairingManager, normalizePairingEvent, normalizeEntityPairingEvent };
