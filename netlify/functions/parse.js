const dec = s => String(s || '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, ' ').trim();

const dur = iso => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(iso || '');
  if (!m) return '';
  const mins = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  if (!mins) return '';
  return mins >= 60 ? Math.floor(mins / 60) + ' hr' + (mins % 60 ? ' ' + (mins % 60) + ' min' : '') : mins + ' min';
};

const steps = ins => {
  if (!ins) return [];
  if (typeof ins === 'string') return ins.split(/\n+/).map(dec).filter(Boolean);
  return [].concat(ins).flatMap(i =>
    typeof i === 'string' ? [dec(i)] :
    i.itemListElement ? steps(i.itemListElement) :
    i.text ? [dec(i.text)] : i.name ? [dec(i.name)] : []).filter(Boolean);
};

const stepGroups = ins => {
  const out = []; let loose = [];
  const flush = () => { if (loose.length) out.push({ title: '', items: loose }); loose = []; };
  for (const i of [].concat(ins || [])) {
    if (i && typeof i === 'object' && i.itemListElement) {
      flush();
      out.push({ title: dec(i.name), items: steps(i.itemListElement) });
    } else loose.push(...steps(i));
  }
  flush();
  return out.filter(g => g.items.length);
};

const htmlGroups = (html, expected) => {
  const m = /class=["'][^"']*(wprm-recipe-ingredients-container|tasty-recipes-ingredients|mv-create-ingredients)/i.exec(html);
  if (!m) return null;
  const rest = html.slice(m.index, m.index + 60000);
  const end = rest.search(/wprm-recipe-instructions-container|tasty-recipes-instructions|mv-create-instructions/i);
  const chunk = end > 0 ? rest.slice(0, end) : rest.slice(0, 20000);
  const groups = []; let title = '';
  const re = /<(h[2-5])[^>]*>([\s\S]*?)<\/\1>|<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  let t;
  while ((t = re.exec(chunk))) {
    if (t[1]) { title = dec(t[2]); if (/^ingredients?$/i.test(title)) title = ''; }
    else {
      const items = [...t[3].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => dec(x[1])).filter(Boolean);
      if (items.length) { groups.push({ title, items }); title = ''; }
    }
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total || (expected && (total < expected * 0.7 || total > expected * 1.3))) return null;
  return groups;
};

const findRecipe = n => {
  if (!n || typeof n !== 'object') return null;
  if (Array.isArray(n)) { for (const x of n) { const r = findRecipe(x); if (r) return r; } return null; }
  const t = [].concat(n['@type'] || []);
  if (t.includes('Recipe')) return n;
  return findRecipe(n['@graph']);
};

exports.handler = async event => {
  const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const url = new URL((event.queryStringParameters || {}).url || '');
    if (!/^https?:$/.test(url.protocol)) return json(400, { error: 'Invalid link' });
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(url.hostname)) return json(400, { error: 'Invalid link' });

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeBookBot/1.0)', 'Accept': 'text/html' },
      redirect: 'follow'
    });
    if (!res.ok) return json(502, { error: 'Could not open that page (' + res.status + ')' });
    const html = await res.text();

    let recipe = null;
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) && !recipe) {
      try { recipe = findRecipe(JSON.parse(m[1].trim())); } catch (e) {}
    }
    if (!recipe) return json(404, { error: "Couldn't find a recipe on that page." });

    const flat = [].concat(recipe.recipeIngredient || []).map(dec).filter(Boolean);
    const yieldVal = [].concat(recipe.recipeYield || [])[0];
    return json(200, {
      title: dec(recipe.name) || 'Untitled recipe',
      servings: dec(yieldVal),
      time: dur(recipe.totalTime) || dur(recipe.cookTime) || dur(recipe.prepTime),
      ingredientGroups: htmlGroups(html, flat.length) || [{ title: '', items: flat }],
      methodGroups: stepGroups(recipe.recipeInstructions),
      source: url.href
    });
  } catch (e) {
    return json(500, { error: 'Something went wrong reading that link.' });
  }
};
