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

function tokenFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const preferred = ['authToken','authtoken','token','rustToken','rust_token','access_token'];
  const entries = Object.entries(payload);
  for (const wanted of preferred) {
    const hit = entries.find(([k]) => k.toLowerCase() === wanted.toLowerCase());
    if (hit && typeof hit[1] === 'string' && hit[1].trim().length >= 20) return hit[1].trim();
  }
  for (const [, value] of entries) {
    if (typeof value === 'string' && value.trim().length >= 40 && !value.includes('://')) return value.trim();
  }
  return '';
}

class WebPanel {
  constructor({ config, db, discord, rustManager, pairingManager }) {
    this.config = config; this.db = db; this.discord = discord; this.rustManager = rustManager; this.pairing = pairingManager;
    this.app = express(); this.sessions = new Map(); this.oauthStates = new Map();
  }

  start() {
    if (!this.config.webEnabled) {
      console.log('[Web] disabled (set BASE_URL, DISCORD_CLIENT_SECRET and SESSION_SECRET to enable)');
      return null;
    }
    this.app.use(express.urlencoded({ extended: false }));
    this.app.use(express.json({ limit: '64kb' }));
    this.app.get('/health', (_, res) => res.json({ ok: true }));
    this.app.get('/', (req, res) => this.#home(req, res));
    this.app.get('/auth/discord', (req, res) => this.#login(req, res));
    this.app.get('/auth/discord/callback', (req, res) => this.#callback(req, res));
    this.app.post('/logout', (req, res) => this.#logout(req, res));

    this.app.get('/rustplus/connect', (req, res) => this.#rustConnect(req, res));
    this.app.get('/rustplus/callback', (req, res) => this.#rustCallbackPage(req, res));
    this.app.post('/rustplus/callback', (req, res) => this.#rustCallbackPost(req, res));
    this.app.post('/rustplus/complete', (req, res) => this.#rustComplete(req, res));
    this.app.post('/rustplus/pair/start', (req, res) => this.#pairStart(req, res));
    this.app.get('/rustplus/pair/status', (req, res) => this.#pairStatus(req, res));
    this.app.post('/rustplus/unlink', (req, res) => this.#rustUnlink(req, res));

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

  #layout(title, body, user = null, script = '') {
    return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
    :root{color-scheme:dark}body{margin:0;background:#0e1116;color:#e8edf2;font:15px system-ui,Segoe UI,sans-serif}.wrap{max-width:1000px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.card{background:#171c23;border:1px solid #2a323d;border-radius:14px;padding:18px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.muted{color:#9ca9b8}.ok{color:#69d58c}.warn{color:#f0c86a}.bad{color:#ff7777}.pill{display:inline-block;padding:4px 9px;border-radius:999px;background:#252d38;margin:2px}input{width:100%;box-sizing:border-box;background:#0e1319;color:#fff;border:1px solid #394454;border-radius:8px;padding:10px;margin:5px 0 12px}button,.btn{background:#5865f2;color:#fff;border:0;border-radius:8px;padding:10px 14px;text-decoration:none;cursor:pointer;display:inline-block}.secondary{background:#343d49}.danger{background:#aa3d48}code{background:#0d1218;padding:2px 5px;border-radius:5px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.steps{display:grid;gap:8px;margin:12px 0}.step{padding:10px 12px;border-radius:9px;background:#10151b;border:1px solid #29323e}details{margin-top:14px}h1,h2,h3{margin:.3em 0}</style></head><body><div class="wrap"><div class="top"><h1>Rust Helper</h1>${user ? `<div class="row"><span>${esc(user.username)}</span><form method="post" action="/logout"><button>Wyloguj</button></form></div>` : ''}</div>${body}</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
  }

  async #home(req, res) {
    const session = this.#session(req);
    if (!session) return res.send(this.#layout('Rust Helper', `<div class="card"><h2>Panel Rust Helper</h2><p class="muted">Zaloguj się przez Discord, aby zarządzać swoim Rust+.</p><a class="btn" href="/auth/discord">Zaloguj przez Discord</a></div>`));
    const user = session.user;
    const hasRole = await this.discord.hasAccessRole(user.id);
    const isAdmin = this.discord.isAdmin(user.id);
    const steamId = this.db.getSteamIdByDiscordId(user.id);
    const rustAuthLinked = this.db.hasRustAuth(user.id);
    const pairState = this.pairing.pairingState(user.id);
    const statuses = this.rustManager.listStatus();
    const visible = isAdmin ? statuses : statuses.filter((a) => a.ownerDiscordId === user.id || String(a.playerId) === String(steamId || ''));
    const teams = this.rustManager.listTeams();

    const accountsHtml = visible.length ? visible.map((a) => `<div class="card"><div class="row"><strong>${esc(a.name)}</strong><span class="pill ${a.connected?'ok':'bad'}">${a.connected?'CONNECTED':'OFFLINE'}</span><span class="pill">${esc(a.senderRole)}</span></div><div class="muted">${esc(a.ip)}:${esc(a.port)} · Steam ${esc(a.playerId)} · ${a.teamId ? esc(a.teamId) : 'team niewykryty'}</div><form method="post" action="/account/remove" onsubmit="return confirm('Usunąć konto?')"><input type="hidden" name="id" value="${esc(a.id)}"><button class="danger">Usuń</button></form></div>`).join('') : '<div class="card muted">Brak kont Rust+.</div>';
    const teamHtml = teams.length ? teams.map((t) => `<div class="card"><strong>${esc(t.id)}</strong> · ${esc(t.serverKey)}<div>ACTIVE: <code>${esc(t.activeAccountId || '-')}</code></div><div class="muted">Konta: ${t.accountIds.map(esc).join(', ')} · członkowie teamu: ${t.memberSteamIds.length}</div></div>`).join('') : '<div class="card muted">Brak wykrytych teamów.</div>';

    let pairingCard = '';
    if (!hasRole) {
      pairingCard = `<div class="card bad">Nie masz wymaganej roli Discord.</div>`;
    } else if (!rustAuthLinked) {
      pairingCard = `<div class="card"><h2>Połącz Rust+</h2><p>Połącz konto z oficjalną stroną Facepunch. Hasła Steam nie wpisujesz u nas.</p><div class="steps"><div class="step">1. Kliknij <b>Połącz Rust+ przez Steam</b>.</div><div class="step">2. Zaloguj się na stronie Steam / Facepunch.</div><div class="step">3. Po powrocie uruchom nasłuch pairingu i w Rust kliknij <b>Pair with Server</b>.</div></div><a class="btn" href="/rustplus/connect">Połącz Rust+ przez Steam</a></div>`;
    } else {
      const statusText = pairState.phase === 'waiting-server' ? '<span class="warn">Czekam na Pair with Server…</span>' : pairState.phase === 'paired' ? `<span class="ok">Serwer dodany: ${esc(pairState.result?.name || '')}</span>` : pairState.error ? `<span class="bad">${esc(pairState.error)}</span>` : '<span class="ok">Rust+ połączone</span>';
      pairingCard = `<div class="card"><h2>Rust+ Pairing</h2><div id="pair-status">${statusText}</div><p class="muted">Kliknij start, potem wejdź do gry → ESC → Rust+ → Pair with Server. Bot pobierze dane serwera z historii Rust+ i zapisze token automatycznie.</p><div class="row"><form method="post" action="/rustplus/pair/start"><button>Start pairingu</button></form><form method="post" action="/rustplus/unlink" onsubmit="return confirm('Odłączyć Rust+? Zapisane serwery pozostaną, ale nie będzie można automatycznie dodawać nowych.')"><button class="secondary">Odłącz Rust+</button></form></div></div>`;
    }

    const manualForm = hasRole ? `<details class="card"><summary>Tryb awaryjny: dodaj dane ręcznie</summary><p class="muted">Użyj tylko jeśli automatyczny pairing nie zadziała.</p><form method="post" action="/account/add"><input name="name" placeholder="Nazwa, np. Medium III" required><input name="ip" placeholder="IP / hostname" required><input name="port" type="number" min="1" max="65535" placeholder="app.port" required><input name="playerId" placeholder="SteamID64" required><input name="playerToken" placeholder="playerToken" required><button>Dodaj konto ręcznie</button></form></details>` : '';

    const script = pairState.phase === 'waiting-server' ? `
      const statusEl=document.getElementById('pair-status');
      async function poll(){try{const r=await fetch('/rustplus/pair/status',{cache:'no-store'});const s=await r.json();if(s.phase==='paired'){statusEl.innerHTML='<span class="ok">✅ Serwer dodany: '+(s.result?.name||'Rust server')+'</span>';setTimeout(()=>location.reload(),1200);return;}if(s.phase==='expired'){statusEl.innerHTML='<span class="bad">Pairing wygasł. Uruchom ponownie.</span>';return;}if(s.error){statusEl.innerHTML='<span class="warn">Czekam… ('+s.error.replace(/[<>]/g,'')+')</span>';}setTimeout(poll,3000);}catch(e){setTimeout(poll,5000)}}poll();` : '';

    res.send(this.#layout('Rust Helper', `<div class="grid"><div class="card"><h3>Discord</h3><div>${esc(user.username)}</div><div>Rola dostępu: ${hasRole?'<span class="ok">TAK</span>':'<span class="bad">NIE</span>'}</div><div>Steam: ${steamId?`<code>${esc(steamId)}</code>`:'zostanie podpięty po pairingu'}</div><div>Rust+ auth: ${rustAuthLinked?'<span class="ok">POŁĄCZONE</span>':'<span class="muted">brak</span>'}</div></div><div class="card"><h3>Routing teamów</h3><p class="muted">Jeden ACTIVE na team, reszta BACKUP. ACTIVE jest sticky i zmienia się tylko gdy wypada.</p></div></div>${pairingCard}${manualForm}<h2>Moje konta Rust+</h2>${accountsHtml}${isAdmin?`<h2>Teamy</h2>${teamHtml}`:''}`, user, script));
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

  async #rustConnect(req, res) {
    const s = this.#session(req); if (!s) return res.redirect('/auth/discord');
    if (!(await this.discord.hasAccessRole(s.user.id))) return res.status(403).send('Brak wymaganej roli Discord.');
    const { loginUrl } = this.pairing.createLogin(s.user.id);
    res.redirect(loginUrl);
  }

  #rustCallbackPage(req, res) {
    const state = String(req.query.state || '');
    const html = this.#layout('Łączenie Rust+', `<div class="card"><h2>Łączenie Rust+</h2><p id="msg" class="muted">Kończę logowanie z Facepunch…</p><a class="btn" href="/">Wróć do panelu</a></div>`, null, `
      (async()=>{const msg=document.getElementById('msg');const q=Object.fromEntries(new URLSearchParams(location.search));const h=Object.fromEntries(new URLSearchParams(location.hash.replace(/^#/,'')));try{const r=await fetch('/rustplus/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:${JSON.stringify(state)},query:q,hash:h})});const x=await r.json();if(!r.ok)throw new Error(x.error||'Błąd');msg.innerHTML='<span class="ok">✅ Rust+ połączone. Za chwilę wrócisz do panelu.</span>';setTimeout(()=>location.href='/',1200);}catch(e){msg.innerHTML='<span class="bad">'+String(e.message).replace(/[<>]/g,'')+'</span>';}})();`);
    res.send(html);
  }

  #rustCallbackPost(req, res) {
    try {
      const state = String(req.query.state || req.body?.state || '');
      const token = tokenFromPayload({ ...req.query, ...(req.body || {}) });
      this.pairing.completeLogin(state, token);
      res.redirect('/');
    } catch (err) { res.status(400).send(this.#layout('Błąd Rust+', `<div class="card bad">${esc(err.message)}</div><a class="btn" href="/">Wróć</a>`)); }
  }

  #rustComplete(req, res) {
    try {
      const state = String(req.body?.state || '');
      const query = req.body?.query && typeof req.body.query === 'object' ? req.body.query : {};
      const hash = req.body?.hash && typeof req.body.hash === 'object' ? req.body.hash : {};
      const token = tokenFromPayload({ ...query, ...hash, ...(req.body || {}) });
      const discordId = this.pairing.completeLogin(state, token);
      res.json({ ok: true, discordId });
    } catch (err) {
      console.error('[Pairing] Rust+ login callback failed:', err?.message || err);
      res.status(400).json({ ok: false, error: err.message });
    }
  }

  async #pairStart(req, res) {
    try {
      const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
      if (!(await this.discord.hasAccessRole(s.user.id))) return res.status(403).send('Brak wymaganej roli Discord.');
      await this.pairing.startPairing(s.user.id);
      res.redirect('/');
    } catch (err) { res.status(400).send(this.#layout('Błąd pairingu', `<div class="card bad">${esc(err.message)}</div><a class="btn" href="/">Wróć</a>`)); }
  }

  async #pairStatus(req, res) {
    const s = this.#session(req); if (!s) return res.status(401).json({ error: 'Unauthorized' });
    const status = await this.pairing.checkPairing(s.user.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(status);
  }

  #rustUnlink(req, res) {
    const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
    this.pairing.unlink(s.user.id); res.redirect('/');
  }

  async #addAccount(req, res) {
    try {
      const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
      if (!(await this.discord.hasAccessRole(s.user.id))) return res.status(403).send('Brak wymaganej roli Discord.');
      const tokenRaw = String(req.body.playerToken || '').trim(); if (!/^-?\d+$/.test(tokenRaw)) throw new Error('playerToken musi być liczbą.');
      const playerId = String(req.body.playerId || '').trim(); if (!/^\d{16,20}$/.test(playerId)) throw new Error('Nieprawidłowe SteamID64.');
      const id = `web-${s.user.id}-${Date.now().toString(36)}`;
      const account = this.db.upsertRustAccount({ id, name:String(req.body.name||'Rust+').trim(), ip:String(req.body.ip||'').trim(), port:Number(req.body.port), playerId, playerToken:Number(tokenRaw), ownerDiscordId:s.user.id });
      this.db.linkSteamToDiscord(playerId, s.user.id);
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
