const fs = require('node:fs');
const path = require('node:path');

// Railway/Cloudflare potrafi zwracac 403 dla bezposredniego scrapingu RustClash.
// Ten modul korzysta z publicznego Rust Items API, ktore wyciaga dane craftingu
// bezposrednio z aktualnych plikow gry Rust.
const API_BASE = 'https://rust-api.tafu.casa';
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const ITEM_TTL_MS = 12 * 60 * 60 * 1000;

const ALIASES = {
  rocket: 'ammo.rocket.basic',
  rockets: 'ammo.rocket.basic',
  c4: 'explosive.timed',
  explo: 'ammo.rifle.explosive',
  exploammo: 'ammo.rifle.explosive',
  explosiveammo: 'ammo.rifle.explosive',
  gp: 'gunpowder',
  gunpowder: 'gunpowder',
  satchel: 'explosive.satchel',
  ak: 'rifle.ak',
  hqm: 'metal.refined',
  lgf: 'lowgradefuel',
  sulfur: 'sulfur',
  charcoal: 'charcoal',
  metalfrags: 'metal.fragments',
  metalfragments: 'metal.fragments',
  explosives: 'explosives',
  pipe: 'metalpipe',
  metalpipe: 'metalpipe'
};

function normalizeText(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : Math.round(n * 100) / 100;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rounded);
}
function levenshtein(a, b) {
  a = normalizeText(a); b = normalizeText(b);
  const dp = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) dp[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1)
      );
    }
  }
  return dp[b.length][a.length];
}

class RustClashService {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.cachePath = path.join(dataDir, 'rust-items-api-cache.json');
    this.items = [];
    this.itemDetails = {};
    this.lastIndexRefresh = 0;
    this.refreshPromise = null;
    fs.mkdirSync(dataDir, { recursive: true });
    this.#loadCache();
  }

  #loadCache() {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      this.items = Array.isArray(data.items) ? data.items : [];
      this.itemDetails = data.itemDetails && typeof data.itemDetails === 'object' ? data.itemDetails : {};
      this.lastIndexRefresh = Number(data.lastIndexRefresh || 0);
    } catch (err) {
      console.warn('[ItemsAPI] cache load failed:', err?.message || err);
    }
  }

  #saveCache() {
    try {
      const tmp = `${this.cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: 2,
        lastIndexRefresh: this.lastIndexRefresh,
        items: this.items,
        itemDetails: this.itemDetails
      }, null, 2));
      fs.renameSync(tmp, this.cachePath);
    } catch (err) {
      console.warn('[ItemsAPI] cache save failed:', err?.message || err);
    }
  }

  async init() {
    if (!this.items.length || Date.now() - this.lastIndexRefresh > INDEX_TTL_MS) {
      this.refreshIndex().catch(err => console.warn('[ItemsAPI] initial refresh failed:', err?.message || err));
    }
  }

  async #fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'user-agent': 'RustHelperBot/0.7.1 (+Discord crafting calculator)',
          'accept': 'application/json'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshIndex(force = false) {
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && this.items.length && Date.now() - this.lastIndexRefresh < INDEX_TTL_MS) return this.items;
    this.refreshPromise = (async () => {
      const all = [];
      let offset = 0;
      const limit = 500;
      let total = Infinity;
      while (offset < total) {
        const data = await this.#fetchJson(`${API_BASE}/api/items?limit=${limit}&offset=${offset}`);
        const rows = Array.isArray(data?.items) ? data.items : [];
        total = Number(data?.total ?? rows.length);
        for (const it of rows) {
          if (!it?.shortname || !it?.displayName) continue;
          all.push({
            name: it.displayName,
            slug: it.shortname,
            shortname: it.shortname,
            category: it.categoryName || '',
            url: `${API_BASE}/api/items/${encodeURIComponent(it.shortname)}`
          });
        }
        if (!rows.length) break;
        offset += rows.length;
        if (rows.length < limit) break;
      }
      if (all.length < 100) throw new Error(`Items API zwrocilo tylko ${all.length} itemow`);
      all.sort((a,b) => a.name.localeCompare(b.name));
      this.items = all;
      this.lastIndexRefresh = Date.now();
      this.#saveCache();
      console.log(`[ItemsAPI] item index refreshed: ${all.length} items`);
      return all;
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  searchItems(query, limit = 25) {
    const q = normalizeText(query);
    const list = this.items.length ? this.items : Object.entries(ALIASES).map(([name, slug]) => ({ name, slug, shortname: slug, url: `${API_BASE}/api/items/${encodeURIComponent(slug)}` }));
    if (!q) return list.slice(0, limit);
    return list.map(item => {
      const n = normalizeText(item.name), s = normalizeText(item.slug);
      let score = 10000;
      if (n === q || s === q) score = 0;
      else if (n.startsWith(q) || s.startsWith(q)) score = 10 + Math.min(n.length, s.length) - q.length;
      else if (n.includes(q) || s.includes(q)) score = 40 + Math.min(n.indexOf(q) < 0 ? 99 : n.indexOf(q), s.indexOf(q) < 0 ? 99 : s.indexOf(q));
      else score = 100 + Math.min(levenshtein(q, n), levenshtein(q, s));
      return { item, score };
    }).sort((a,b) => a.score-b.score || a.item.name.localeCompare(b.item.name)).slice(0,limit).map(x=>x.item);
  }

  async resolveItem(query) {
    if (!this.items.length) {
      try { await this.refreshIndex(); } catch (_) {}
    }
    const raw = String(query || '').trim();
    const q = normalizeText(raw);
    const aliasKey = q.replace(/\s+/g, '');
    const aliasShort = ALIASES[aliasKey] || ALIASES[q];
    if (aliasShort) {
      return this.items.find(x => x.slug === aliasShort) || {
        name: raw || aliasShort,
        slug: aliasShort,
        shortname: aliasShort,
        url: `${API_BASE}/api/items/${encodeURIComponent(aliasShort)}`
      };
    }
    const exact = this.items.find(x => normalizeText(x.name) === q || normalizeText(x.slug) === q);
    if (exact) return exact;
    return this.searchItems(raw, 1)[0] || null;
  }

  async getRecipe(item) {
    const shortname = typeof item === 'string' ? item : item.slug;
    const cached = this.itemDetails[shortname];
    if (cached && Date.now() - Number(cached.fetchedAt || 0) < ITEM_TTL_MS) return cached;

    const data = await this.#fetchJson(`${API_BASE}/api/items/${encodeURIComponent(shortname)}`);
    const ingredients = Array.isArray(data?.ingredients) ? data.ingredients.map(x => ({
      slug: x?.itemDef?.shortname,
      name: x?.itemDef?.displayName || x?.itemDef?.shortname || 'Unknown',
      qty: Number(x?.amount || 0)
    })).filter(x => x.slug && x.qty > 0) : [];

    const value = {
      fetchedAt: Date.now(),
      name: data?.displayName || (typeof item === 'object' ? item.name : shortname),
      slug: data?.shortname || shortname,
      url: `${API_BASE}/api/items/${encodeURIComponent(data?.shortname || shortname)}`,
      craftable: ingredients.length > 0,
      outputQty: Math.max(1, Number(data?.amountToCreate || 1)),
      ingredients,
      workbench: Number(data?.workbenchLevelRequired ?? -1),
      craftTime: Number(data?.craftTime || 0)
    };
    this.itemDetails[shortname] = value;
    this.#saveCache();
    return value;
  }

  async calculate(query, amount) {
    const item = await this.resolveItem(query);
    if (!item) throw new Error(`Nie znaleziono itemu: ${query}`);
    const requested = Math.max(1, Math.floor(Number(amount) || 1));
    const rootRecipe = await this.getRecipe(item);
    if (!rootRecipe.craftable) {
      return { item, requested, rootRecipe, direct: [], totals: [], leaves: [], warnings: ['Ten item nie ma receptury craftingu w danych gry.'] };
    }

    const totals = new Map();
    const leaves = new Map();
    const names = new Map();
    const warnings = [];
    const direct = this.#scaledIngredients(rootRecipe, requested);
    const stack = new Set();

    const add = (map, slug, name, qty) => {
      names.set(slug, name);
      map.set(slug, (map.get(slug) || 0) + qty);
    };

    const walk = async (recipe, qtyNeeded, depth = 0) => {
      if (depth > 12) { warnings.push(`Przerwano zbyt gleboka recepture przy ${recipe.name}.`); return; }
      const batches = Math.ceil(qtyNeeded / Math.max(1, recipe.outputQty || 1));
      for (const ing of recipe.ingredients) {
        const need = ing.qty * batches;
        add(totals, ing.slug, ing.name, need);
        if (stack.has(ing.slug)) { add(leaves, ing.slug, ing.name, need); continue; }
        let child;
        try { child = await this.getRecipe(ing.slug); }
        catch (err) { warnings.push(`Nie udalo sie pobrac receptury ${ing.name}.`); add(leaves, ing.slug, ing.name, need); continue; }
        if (!child.craftable || !child.ingredients.length) { add(leaves, ing.slug, child.name || ing.name, need); continue; }
        stack.add(ing.slug);
        await walk(child, need, depth + 1);
        stack.delete(ing.slug);
      }
    };

    stack.add(item.slug);
    await walk(rootRecipe, requested, 0);
    stack.delete(item.slug);

    const toRows = (map) => [...map.entries()].map(([slug, qty]) => ({
      slug,
      name: names.get(slug) || this.items.find(x=>x.slug===slug)?.name || slug,
      qty
    }));
    return { item, requested, rootRecipe, direct, totals: toRows(totals), leaves: toRows(leaves), warnings };
  }

  #scaledIngredients(recipe, qtyNeeded) {
    const batches = Math.ceil(qtyNeeded / Math.max(1, recipe.outputQty || 1));
    return recipe.ingredients.map(i => ({ ...i, qty: i.qty * batches }));
  }

  formatCalculation(calc) {
    if (!calc.rootRecipe.craftable) {
      return `❌ **${calc.item.name}** nie ma receptury craftingu w aktualnych danych gry.`;
    }
    const priority = [
      'sulfur','gunpowder','charcoal','metal.fragments','lowgradefuel','metalpipe',
      'metal.refined','scrap','cloth','fat.animal','wood','stones'
    ];
    const rank = (slug) => { const i = priority.indexOf(slug); return i < 0 ? 999 : i; };
    const totals = [...calc.totals].sort((a,b)=>rank(a.slug)-rank(b.slug) || b.qty-a.qty || a.name.localeCompare(b.name));
    const leaves = [...calc.leaves].sort((a,b)=>rank(a.slug)-rank(b.slug) || b.qty-a.qty || a.name.localeCompare(b.name));
    const fmtRows = (rows, max=16) => rows.slice(0,max).map(r=>`• **${r.name}**: ${formatNumber(r.qty)}`).join('\n') || '—';
    const direct = calc.direct.map(r=>`• ${r.name}: ${formatNumber(r.qty)}`).join('\n') || '—';
    const wb = Number.isFinite(calc.rootRecipe.workbench) && calc.rootRecipe.workbench >= 0 ? `Workbench: **${calc.rootRecipe.workbench}**` : null;
    let out = [
      `🧮 **${calc.item.name} ×${formatNumber(calc.requested)}**`,
      wb,
      '',
      '**Łączne zużycie (wliczając półprodukty):**',
      fmtRows(totals),
      '',
      '**Bezpośredni craft:**',
      direct,
      '',
      '**Surowce końcowe / komponenty:**',
      fmtRows(leaves, 14),
      '',
      'Źródło danych: Rust Items API (dane wyciągnięte z plików gry Rust)'
    ].filter(x => x !== null).join('\n');
    if (calc.warnings?.length) out += `\n⚠️ ${calc.warnings.slice(0,2).join(' ')}`;
    return out.slice(0, 1950);
  }
}

module.exports = { RustClashService };
