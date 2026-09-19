const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const BASE = 'https://wiki.rustclash.com';
const INDEX_URL = `${BASE}/group=itemlist`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RECIPE_TTL_MS = 12 * 60 * 60 * 1000;

const ALIASES = {
  rocket: 'rocket',
  rockets: 'rocket',
  c4: 'timed-explosive-charge',
  explo: 'explosive-5-56-rifle-ammo',
  exploammo: 'explosive-5-56-rifle-ammo',
  explosiveammo: 'explosive-5-56-rifle-ammo',
  gp: 'gun-powder',
  gunpowder: 'gun-powder',
  satchel: 'satchel-charge',
  ak: 'assault-rifle',
  hqm: 'high-quality-metal',
  lgf: 'low-grade-fuel'
};

function normalizeText(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function slugFromHref(href) {
  const m = String(href || '').match(/\/item\/([^?#/]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}
function parseNumber(v) {
  const s = String(v || '').replace(/,/g, '').replace(/\s/g, '');
  const m = s.match(/(?:×|x)?(-?\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
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
    this.cachePath = path.join(dataDir, 'rustclash-cache.json');
    this.items = [];
    this.recipes = {};
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
      this.recipes = data.recipes && typeof data.recipes === 'object' ? data.recipes : {};
      this.lastIndexRefresh = Number(data.lastIndexRefresh || 0);
    } catch (err) {
      console.warn('[RustClash] cache load failed:', err?.message || err);
    }
  }

  #saveCache() {
    try {
      const tmp = `${this.cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        lastIndexRefresh: this.lastIndexRefresh,
        items: this.items,
        recipes: this.recipes
      }, null, 2));
      fs.renameSync(tmp, this.cachePath);
    } catch (err) {
      console.warn('[RustClash] cache save failed:', err?.message || err);
    }
  }

  async init() {
    if (!this.items.length || Date.now() - this.lastIndexRefresh > CACHE_TTL_MS) {
      this.refreshIndex().catch(err => console.warn('[RustClash] initial refresh failed:', err?.message || err));
    }
  }

  async #fetch(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'user-agent': 'RustHelperBot/0.7 (+Discord crafting calculator; respectful cache)',
          'accept-language': 'en-US,en;q=0.9'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally { clearTimeout(timer); }
  }

  async refreshIndex(force = false) {
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && this.items.length && Date.now() - this.lastIndexRefresh < CACHE_TTL_MS) return this.items;
    this.refreshPromise = (async () => {
      const html = await this.#fetch(INDEX_URL);
      const $ = cheerio.load(html);
      const seen = new Set();
      const items = [];
      $('a[href*="/item/"]').each((_, el) => {
        const href = $(el).attr('href');
        const slug = slugFromHref(href);
        if (!slug || seen.has(slug)) return;
        let name = $(el).text().replace(/\s+/g, ' ').trim();
        if (!name) name = $(el).find('img').attr('alt') || '';
        name = name.replace(/^Image:\s*/i, '').trim();
        if (!name || /^×?\d/.test(name)) return;
        seen.add(slug);
        items.push({ name, slug, url: `${BASE}/item/${slug}` });
      });
      if (items.length < 100) throw new Error(`Index parse returned only ${items.length} items`);
      items.sort((a,b) => a.name.localeCompare(b.name));
      this.items = items;
      this.lastIndexRefresh = Date.now();
      this.#saveCache();
      console.log(`[RustClash] item index refreshed: ${items.length} items`);
      return items;
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  searchItems(query, limit = 25) {
    const q = normalizeText(query);
    const list = this.items.length ? this.items : Object.entries(ALIASES).map(([name, slug]) => ({ name, slug, url:`${BASE}/item/${slug}` }));
    if (!q) return list.slice(0, limit);
    return list.map(item => {
      const n = normalizeText(item.name), s = normalizeText(item.slug);
      let score = 10000;
      if (n === q || s === q) score = 0;
      else if (n.startsWith(q) || s.startsWith(q)) score = 10 + Math.min(n.length, s.length) - q.length;
      else if (n.includes(q) || s.includes(q)) score = 40 + Math.min(n.indexOf(q) < 0 ? 99 : n.indexOf(q), s.indexOf(q) < 0 ? 99 : s.indexOf(q));
      else score = 100 + Math.min(levenshtein(q, n), levenshtein(q, s));
      return { item, score };
    }).sort((a,b)=>a.score-b.score || a.item.name.localeCompare(b.item.name)).slice(0,limit).map(x=>x.item);
  }

  async resolveItem(query) {
    if (!this.items.length) {
      try { await this.refreshIndex(); } catch (_) {}
    }
    const raw = String(query || '').trim();
    const q = normalizeText(raw);
    const aliasSlug = ALIASES[q.replace(/\s+/g,'')] || ALIASES[q];
    if (aliasSlug) {
      const found = this.items.find(x => x.slug === aliasSlug);
      return found || { name: raw || aliasSlug, slug: aliasSlug, url: `${BASE}/item/${aliasSlug}` };
    }
    const exact = this.items.find(x => normalizeText(x.name) === q || normalizeText(x.slug) === q);
    if (exact) return exact;
    return this.searchItems(raw, 1)[0] || null;
  }

  async getRecipe(item) {
    const slug = typeof item === 'string' ? item : item.slug;
    const cached = this.recipes[slug];
    if (cached && Date.now() - Number(cached.fetchedAt || 0) < RECIPE_TTL_MS) return cached;
    const url = `${BASE}/item/${slug}`;
    const html = await this.#fetch(url);
    const $ = cheerio.load(html);
    const pageName = $('h1').first().text().replace(/\s+/g,' ').trim() || (typeof item === 'object' ? item.name : slug);

    let recipe = null;
    $('table').each((_, table) => {
      if (recipe) return;
      const firstRow = $(table).find('tr').first();
      const headers = firstRow.find('th,td').map((__, c)=>$(c).text().replace(/\s+/g,' ').trim()).get();
      const ingredientsIdx = headers.findIndex(h => /ingredients/i.test(h));
      const blueprintIdx = headers.findIndex(h => /blueprint/i.test(h));
      if (ingredientsIdx < 0 || blueprintIdx < 0) return;
      const rows = $(table).find('tr').slice(1).toArray();
      if (!rows.length) return;
      const row = rows[0];
      const cells = $(row).find('td').toArray();
      if (cells.length <= ingredientsIdx) return;

      const outCell = cells[blueprintIdx] || cells[0];
      const outText = $(outCell).text().replace(/\s+/g,' ').trim();
      const outMatches = [...outText.matchAll(/×\s*([\d,.]+)/g)];
      const outputQty = outMatches.length ? Number(outMatches[outMatches.length - 1][1].replace(/,/g,'')) : 1;
      const ingCell = cells[ingredientsIdx];
      const ingredients = [];
      const seenPairs = new Set();
      $(ingCell).find('a[href*="/item/"]').each((__, a) => {
        const href = $(a).attr('href');
        const ingSlug = slugFromHref(href);
        if (!ingSlug) return;
        const txt = $(a).text().replace(/\s+/g,' ').trim();
        let qty = parseNumber(txt);
        if (!qty) {
          const next = ($(a).next().text() || $(a).parent().text() || '').replace(/\s+/g,' ').trim();
          qty = parseNumber(next);
        }
        if (!qty || qty <= 0) return;
        const key = `${ingSlug}:${qty}`;
        if (seenPairs.has(key)) return;
        seenPairs.add(key);
        const known = this.items.find(x=>x.slug===ingSlug);
        let name = known?.name || $(a).find('img').attr('alt') || ingSlug.replace(/-/g,' ');
        name = name.replace(/^Image:\s*/i,'').trim();
        ingredients.push({ slug: ingSlug, name, qty });
      });
      if (ingredients.length) recipe = { name: pageName, slug, outputQty: outputQty > 0 ? outputQty : 1, ingredients };
    });

    const value = {
      fetchedAt: Date.now(),
      name: pageName,
      slug,
      url,
      craftable: Boolean(recipe),
      outputQty: recipe?.outputQty || 1,
      ingredients: recipe?.ingredients || []
    };
    this.recipes[slug] = value;
    this.#saveCache();
    return value;
  }

  async calculate(query, amount) {
    const item = await this.resolveItem(query);
    if (!item) throw new Error(`Nie znaleziono itemu: ${query}`);
    const requested = Math.max(1, Math.floor(Number(amount) || 1));
    const rootRecipe = await this.getRecipe(item);
    if (!rootRecipe.craftable) return { item, requested, rootRecipe, direct: [], totals: new Map(), leaves: new Map(), warnings: ['Brak receptury craftingu na RustClash Wiki.'] };

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
      if (depth > 10) { warnings.push(`Przerwano zbyt głęboką recepturę przy ${recipe.name}.`); return; }
      const batches = Math.ceil(qtyNeeded / Math.max(1, recipe.outputQty || 1));
      for (const ing of recipe.ingredients) {
        const need = ing.qty * batches;
        add(totals, ing.slug, ing.name, need);
        if (stack.has(ing.slug)) { add(leaves, ing.slug, ing.name, need); continue; }
        let child;
        try { child = await this.getRecipe(ing.slug); }
        catch (err) { warnings.push(`Nie udało się pobrać receptury ${ing.name}.`); add(leaves, ing.slug, ing.name, need); continue; }
        if (!child.craftable || !child.ingredients.length) { add(leaves, ing.slug, child.name || ing.name, need); continue; }
        stack.add(ing.slug);
        await walk(child, need, depth + 1);
        stack.delete(ing.slug);
      }
    };

    stack.add(item.slug);
    await walk(rootRecipe, requested, 0);
    stack.delete(item.slug);

    const toRows = (map) => [...map.entries()].map(([slug, qty]) => ({ slug, name: names.get(slug) || this.items.find(x=>x.slug===slug)?.name || slug, qty }));
    return { item, requested, rootRecipe, direct, totals: toRows(totals), leaves: toRows(leaves), warnings };
  }

  #scaledIngredients(recipe, qtyNeeded) {
    const batches = Math.ceil(qtyNeeded / Math.max(1, recipe.outputQty || 1));
    return recipe.ingredients.map(i => ({ ...i, qty: i.qty * batches }));
  }

  formatCalculation(calc) {
    if (!calc.rootRecipe.craftable) {
      return `❌ **${calc.item.name}** nie ma wykrytej receptury craftingu na RustClash Wiki.\n<${calc.item.url}>`;
    }
    const priority = ['sulfur','gun-powder','charcoal','metal-fragments','low-grade-fuel','metal-pipe','high-quality-metal','scrap','cloth','animal-fat','wood','stones'];
    const rank = (slug) => { const i = priority.indexOf(slug); return i < 0 ? 999 : i; };
    const totals = [...calc.totals].sort((a,b)=>rank(a.slug)-rank(b.slug) || b.qty-a.qty || a.name.localeCompare(b.name));
    const leaves = [...calc.leaves].sort((a,b)=>rank(a.slug)-rank(b.slug) || b.qty-a.qty || a.name.localeCompare(b.name));
    const fmtRows = (rows, max=14) => rows.slice(0,max).map(r=>`• **${r.name}**: ${formatNumber(r.qty)}`).join('\n') || '—';
    const direct = calc.direct.map(r=>`• ${r.name}: ${formatNumber(r.qty)}`).join('\n') || '—';
    let out = [
      `🧮 **${calc.item.name} ×${formatNumber(calc.requested)}**`,
      '',
      '**Łączne zużycie (wliczając półprodukty):**',
      fmtRows(totals),
      '',
      '**Bezpośredni craft:**',
      direct,
      '',
      '**Surowce końcowe:**',
      fmtRows(leaves, 12),
      '',
      `Źródło: RustClash Wiki — <${calc.item.url}>`
    ].join('\n');
    if (calc.warnings?.length) out += `\n⚠️ ${calc.warnings.slice(0,2).join(' ')}`;
    return out.slice(0, 1950);
  }
}

module.exports = { RustClashService };
