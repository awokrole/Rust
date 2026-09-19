const express = require('express');
const crypto = require('node:crypto');

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function hmac(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

class WebPanel {
  constructor({ config, db, discord, rustManager }) {
    this.config = config; this.db = db; this.discord = discord; this.rustManager = rustManager;
    this.app = express(); this.sessions = new Map(); this.oauthStates = new Map();
  }

  start() {
    if (!this.config.webEnabled) {
      console.log('[Web] disabled (set BASE_URL, DISCORD_CLIENT_SECRET and SESSION_SECRET to enable)');
      return null;
    }
    this.app.use(express.urlencoded({ extended: false }));
    this.app.get('/health', (_, res) => res.json({ ok: true }));
    this.app.get('/', (req, res) => this.#home(req, res));
    this.app.get('/auth/discord', (req, res) => this.#login(req, res));
    this.app.get('/auth/discord/callback', (req, res) => this.#callback(req, res));
    this.app.post('/logout', (req, res) => this.#logout(req, res));
    this.app.post('/account/add', (req, res) => this.#addAccount(req, res));
    this.app.post('/account/remove', (req, res) => this.#removeAccount(req, res));
    this.server = this.app.listen(this.config.port, '0.0.0.0', () => console.log(`[Web] listening on :${this.config.port}`));
    return this.server;
  }

  stop() { try { this.server?.close(); } catch (_) {} }

  #session(req) {
    const raw = parseCookies(req).rh_session; if (!raw) return null;
    const [id, sig] = raw.split('.'); if (!id || !sig || hmac(this.config.sessionSecret, id) !== sig) return null;
    const s = this.sessions.get(id); if (!s || s.expiresAt < Date.now()) { this.sessions.delete(id); return null; }
    return s;
  }
  #setSession(res, user) {
    const id = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(id, { user, expiresAt: Date.now() + 7 * 86400_000 });
    const secure = this.config.baseUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `rh_session=${id}.${hmac(this.config.sessionSecret, id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
  }
  #clearSession(res) { res.setHeader('Set-Cookie', 'rh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }

  #layout(title, body, user = null) {
    return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
    :root{color-scheme:dark}body{margin:0;background:#0e1116;color:#e8edf2;font:15px system-ui,Segoe UI,sans-serif}.wrap{max-width:1000px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.card{background:#171c23;border:1px solid #2a323d;border-radius:14px;padding:18px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.muted{color:#9ca9b8}.ok{color:#69d58c}.bad{color:#ff7777}.pill{display:inline-block;padding:4px 9px;border-radius:999px;background:#252d38;margin:2px}input{width:100%;box-sizing:border-box;background:#0e1319;color:#fff;border:1px solid #394454;border-radius:8px;padding:10px;margin:5px 0 12px}button,.btn{background:#5865f2;color:#fff;border:0;border-radius:8px;padding:10px 14px;text-decoration:none;cursor:pointer;display:inline-block}.danger{background:#aa3d48}code{background:#0d1218;padding:2px 5px;border-radius:5px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}h1,h2,h3{margin:.3em 0}</style></head><body><div class="wrap"><div class="top"><h1>Rust Helper</h1>${user ? `<div class="row"><span>${esc(user.username)}</span><form method="post" action="/logout"><button>Wyloguj</button></form></div>` : ''}</div>${body}</div></body></html>`;
  }

  async #home(req, res) {
    const session = this.#session(req);
    if (!session) return res.send(this.#layout('Rust Helper', `<div class="card"><h2>Panel Rust Helper</h2><p class="muted">Zaloguj się przez Discord, aby zarządzać swoim Rust+.</p><a class="btn" href="/auth/discord">Zaloguj przez Discord</a></div>`));
    const user = session.user;
    const hasRole = await this.discord.hasAccessRole(user.id);
    const isAdmin = this.discord.isAdmin(user.id);
    const steamId = this.db.getSteamIdByDiscordId(user.id);
    const statuses = this.rustManager.listStatus();
    const visible = isAdmin ? statuses : statuses.filter((a) => a.ownerDiscordId === user.id || String(a.playerId) === String(steamId || ''));
    const teams = this.rustManager.listTeams();
    const accountsHtml = visible.length ? visible.map((a) => `<div class="card"><div class="row"><strong>${esc(a.name)}</strong><span class="pill ${a.connected?'ok':'bad'}">${a.connected?'CONNECTED':'OFFLINE'}</span><span class="pill">${esc(a.senderRole)}</span></div><div class="muted">${esc(a.ip)}:${esc(a.port)} · Steam ${esc(a.playerId)} · ${a.teamId ? esc(a.teamId) : 'team niewykryty'}</div><form method="post" action="/account/remove" onsubmit="return confirm('Usunąć konto?')"><input type="hidden" name="id" value="${esc(a.id)}"><button class="danger">Usuń</button></form></div>`).join('') : '<div class="card muted">Brak kont Rust+.</div>';
    const teamHtml = teams.length ? teams.map((t) => `<div class="card"><strong>${esc(t.id)}</strong> · ${esc(t.serverKey)}<div>ACTIVE: <code>${esc(t.activeAccountId || '-')}</code></div><div class="muted">Konta: ${t.accountIds.map(esc).join(', ')} · członkowie teamu: ${t.memberSteamIds.length}</div></div>`).join('') : '<div class="card muted">Brak wykrytych teamów.</div>';
    const addForm = hasRole ? `<div class="card"><h2>Dodaj Rust+</h2><p class="muted">Na razie możesz wkleić dane pairingu. Automatyczny pairing przez stronę będzie kolejnym krokiem.</p><form method="post" action="/account/add"><input name="name" placeholder="Nazwa, np. Medium III" required><input name="ip" placeholder="IP / hostname" required><input name="port" type="number" min="1" max="65535" placeholder="app.port" required><input name="playerId" placeholder="SteamID64" required><input name="playerToken" placeholder="playerToken" required><button>Dodaj konto</button></form></div>` : `<div class="card bad">Nie masz wymaganej roli Discord.</div>`;
    res.send(this.#layout('Rust Helper', `<div class="grid"><div class="card"><h3>Discord</h3><div>${esc(user.username)}</div><div>Rola dostępu: ${hasRole?'<span class="ok">TAK</span>':'<span class="bad">NIE</span>'}</div><div>Steam: ${steamId?`<code>${esc(steamId)}</code>`:'niepołączony'}</div></div><div class="card"><h3>Routing teamów</h3><p class="muted">Jeden ACTIVE na team, reszta BACKUP. ACTIVE jest sticky i zmienia się tylko gdy wypada.</p></div></div>${addForm}<h2>Moje konta Rust+</h2>${accountsHtml}${isAdmin?`<h2>Teamy</h2>${teamHtml}`:''}`, user));
  }

  #login(req, res) {
    const state = crypto.randomBytes(18).toString('base64url');
    this.oauthStates.set(state, Date.now() + 10 * 60_000);
    const q = new URLSearchParams({ client_id: this.config.discordClientId, response_type: 'code', redirect_uri: `${this.config.baseUrl}/auth/discord/callback`, scope: 'identify', state });
    res.redirect(`https://discord.com/oauth2/authorize?${q}`);
  }

  async #callback(req, res) {
    try {
      const { code, state } = req.query;
      const expiry = this.oauthStates.get(String(state)); this.oauthStates.delete(String(state));
      if (!code || !expiry || expiry < Date.now()) throw new Error('Nieprawidłowy lub wygasły OAuth state.');
      const body = new URLSearchParams({ client_id: this.config.discordClientId, client_secret: this.config.discordClientSecret, grant_type: 'authorization_code', code: String(code), redirect_uri: `${this.config.baseUrl}/auth/discord/callback` });
      const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
      if (!tokenRes.ok) throw new Error(`Discord token exchange: ${tokenRes.status}`);
      const token = await tokenRes.json();
      const userRes = await fetch('https://discord.com/api/v10/users/@me', { headers:{ Authorization:`Bearer ${token.access_token}` } });
      if (!userRes.ok) throw new Error(`Discord user fetch: ${userRes.status}`);
      const user = await userRes.json();
      this.#setSession(res, { id: user.id, username: user.global_name || user.username, avatar: user.avatar });
      res.redirect('/');
    } catch (err) { console.error('[Web] OAuth error:', err); res.status(400).send(this.#layout('Błąd', `<div class="card bad">${esc(err.message)}</div>`)); }
  }

  #logout(req, res) { const s = this.#session(req); if (s) { for (const [id, entry] of this.sessions) if (entry === s) this.sessions.delete(id); } this.#clearSession(res); res.redirect('/'); }

  async #addAccount(req, res) {
    try {
      const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
      if (!(await this.discord.hasAccessRole(s.user.id))) return res.status(403).send('Brak wymaganej roli Discord.');
      const tokenRaw = String(req.body.playerToken || '').trim(); if (!/^-?\d+$/.test(tokenRaw)) throw new Error('playerToken musi być liczbą.');
      const playerId = String(req.body.playerId || '').trim(); if (!/^\d{16,20}$/.test(playerId)) throw new Error('Nieprawidłowe SteamID64.');
      const id = `web-${s.user.id}-${Date.now().toString(36)}`;
      const account = this.db.upsertRustAccount({ id, name:String(req.body.name||'Rust+').trim(), ip:String(req.body.ip||'').trim(), port:Number(req.body.port), playerId, playerToken:Number(tokenRaw), ownerDiscordId:s.user.id });
      this.rustManager.start(account); res.redirect('/');
    } catch (err) { res.status(400).send(this.#layout('Błąd', `<div class="card bad">${esc(err.message)}</div><a class="btn" href="/">Wróć</a>`)); }
  }

  #removeAccount(req, res) {
    const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
    const id = String(req.body.id || ''); const a = this.db.getRustAccount(id);
    if (!a || (!this.discord.isAdmin(s.user.id) && a.ownerDiscordId !== s.user.id)) return res.status(403).send('Forbidden');
    this.rustManager.stop(id); this.db.removeRustAccount(id); res.redirect('/');
  }
}

module.exports = { WebPanel };
