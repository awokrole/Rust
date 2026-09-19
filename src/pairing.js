const crypto = require('node:crypto');

const COMPANION_BASE = 'https://companion-rust.facepunch.com';

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !['{','[','"'].includes(trimmed[0])) return value;
  try { return JSON.parse(trimmed); } catch (_) { return value; }
}

function collectObjects(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
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
    const playerId = getCaseInsensitive(obj, ['playerId', 'steamId', 'steamID64']);
    const playerToken = getCaseInsensitive(obj, ['playerToken', 'token']);
    const type = String(getCaseInsensitive(obj, ['type']) || '').toLowerCase();
    if (ip && port && playerId && playerToken != null && (type === '' || type === 'server')) {
      const tokenText = String(playerToken).trim();
      if (!/^-?\d+$/.test(tokenText)) continue;
      return {
        ip: String(ip).trim(),
        port: Number(port),
        playerId: String(playerId).trim(),
        playerToken: Number(tokenText),
        serverId: String(getCaseInsensitive(obj, ['id', 'serverId']) || ''),
        name: String(getCaseInsensitive(obj, ['name', 'serverName']) || getCaseInsensitive(event, ['body', 'title']) || 'Rust server').trim()
      };
    }
  }
  return null;
}

function eventId(event) {
  const direct = getCaseInsensitive(event, ['id', 'notificationId', 'notificationID']);
  if (direct != null) return String(direct);
  return crypto.createHash('sha1').update(JSON.stringify(event)).digest('hex');
}

function historyEvents(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['notifications', 'history', 'events', 'data', 'items']) {
    const value = getCaseInsensitive(payload, [key]);
    if (Array.isArray(value)) return value;
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) return parsed;
  }
  const arrays = Object.values(payload).filter(Array.isArray);
  return arrays[0] || [];
}

class PairingManager {
  constructor({ db, rustManager, baseUrl }) {
    this.db = db;
    this.rustManager = rustManager;
    this.baseUrl = baseUrl;
    this.sessions = new Map();
  }

  createLogin(discordId) {
    const state = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(state, { discordId: String(discordId), expiresAt: Date.now() + 15 * 60_000, phase: 'steam-login' });
    const returnUrl = `${this.baseUrl}/rustplus/callback?state=${encodeURIComponent(state)}`;
    const loginUrl = `${COMPANION_BASE}/login?returnUrl=${encodeURIComponent(returnUrl)}`;
    return { state, loginUrl };
  }

  consumeLoginState(state, discordId = null) {
    const entry = this.sessions.get(String(state));
    if (!entry || entry.expiresAt < Date.now()) { this.sessions.delete(String(state)); return null; }
    if (discordId && entry.discordId !== String(discordId)) return null;
    return entry;
  }

  completeLogin(state, authToken, meta = {}) {
    const entry = this.consumeLoginState(state);
    if (!entry) throw new Error('Sesja logowania Rust+ wygasła. Zacznij ponownie.');
    const token = String(authToken || '').trim();
    if (token.length < 20) throw new Error('Facepunch nie zwrócił prawidłowego tokenu Rust+.');
    this.db.setRustAuth(entry.discordId, token, { source: 'facepunch-web', ...meta });
    entry.phase = 'linked';
    entry.expiresAt = Date.now() + 10 * 60_000;
    return entry.discordId;
  }

  async #readHistory(authToken) {
    const attempts = [
      { body: JSON.stringify(String(authToken)), contentType: 'application/json' },
      { body: String(authToken), contentType: 'application/json' },
      { body: JSON.stringify({ authToken: String(authToken) }), contentType: 'application/json' }
    ];
    let lastError;
    for (const attempt of attempts) {
      try {
        const res = await fetch(`${COMPANION_BASE}/api/history/read`, {
          method: 'POST',
          headers: { 'Content-Type': attempt.contentType, 'Accept': 'application/json' },
          body: attempt.body,
          signal: AbortSignal.timeout(10000)
        });
        const text = await res.text();
        if (!res.ok) { lastError = new Error(`Rust+ history HTTP ${res.status}: ${text.slice(0, 180)}`); continue; }
        try { return JSON.parse(text); } catch (_) { throw new Error('Rust+ history zwróciło nieprawidłowy JSON.'); }
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error('Nie udało się pobrać historii Rust+.');
  }

  async startPairing(discordId) {
    const auth = this.db.getRustAuth(discordId);
    if (!auth?.authToken) throw new Error('Najpierw połącz konto Rust+ przez Steam.');
    const history = await this.#readHistory(auth.authToken);
    const baseline = new Set(historyEvents(history).map(eventId));
    const key = `pair:${discordId}`;
    this.sessions.set(key, {
      discordId: String(discordId),
      phase: 'waiting-server',
      expiresAt: Date.now() + 10 * 60_000,
      startedAt: Date.now(),
      baseline
    });
    return { ok: true, expiresAt: this.sessions.get(key).expiresAt };
  }

  pairingState(discordId) {
    const s = this.sessions.get(`pair:${discordId}`);
    if (!s) return { phase: this.db.hasRustAuth(discordId) ? 'ready' : 'not-linked' };
    if (s.expiresAt < Date.now()) { this.sessions.delete(`pair:${discordId}`); return { phase: 'expired' }; }
    return { phase: s.phase, expiresAt: s.expiresAt, result: s.result || null, error: s.error || null };
  }

  async checkPairing(discordId) {
    const key = `pair:${discordId}`;
    const s = this.sessions.get(key);
    if (!s || s.expiresAt < Date.now()) return this.pairingState(discordId);
    if (s.phase === 'paired' || s.phase === 'error') return this.pairingState(discordId);
    if (s.inFlight) return this.pairingState(discordId);
    s.inFlight = true;
    try {
      const auth = this.db.getRustAuth(discordId);
      const history = await this.#readHistory(auth.authToken);
      const events = historyEvents(history);
      for (const evt of events) {
        const id = eventId(evt);
        if (s.baseline.has(id)) continue;
        const pair = normalizePairingEvent(evt);
        if (!pair) continue;
        const accountHash = crypto.createHash('sha1').update(`${pair.playerId}|${pair.ip}|${pair.port}`).digest('hex').slice(0, 12);
        const account = this.db.upsertRustAccount({
          id: `web-${discordId}-${accountHash}`,
          name: pair.name || 'Rust server',
          ip: pair.ip,
          port: pair.port,
          playerId: pair.playerId,
          playerToken: pair.playerToken,
          ownerDiscordId: String(discordId),
          serverPairId: pair.serverId || undefined
        });
        this.db.linkSteamToDiscord(pair.playerId, discordId);
        this.rustManager.start(account);
        s.phase = 'paired';
        s.result = { accountId: account.id, name: account.name, ip: account.ip, port: account.port, playerId: account.playerId };
        s.expiresAt = Date.now() + 5 * 60_000;
        return this.pairingState(discordId);
      }
      for (const evt of events) s.baseline.add(eventId(evt));
      return this.pairingState(discordId);
    } catch (err) {
      console.error('[Pairing] history check failed:', err?.message || err);
      s.error = String(err?.message || err);
      return this.pairingState(discordId);
    } finally { s.inFlight = false; }
  }

  unlink(discordId) {
    this.db.removeRustAuth(discordId);
    this.sessions.delete(`pair:${discordId}`);
  }
}

module.exports = { PairingManager, normalizePairingEvent, historyEvents };
