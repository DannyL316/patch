import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'patches.json');
const OVERRIDES = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'overrides.json'), 'utf8'));
const INDEX = 'https://www.leagueoflegends.com/en-us/news/tags/patch-notes/';
const WINDOW = 5;

const normalize = s => String(s ?? '').replace(/\s+/g, ' ').trim();

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'lol-strong-champions/1.1 personal patch tracker' } });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

function patchNumberFromText(text) {
  return text.match(/Patch\s+(\d+\.\d+)\s+Notes/i)?.[1] ?? null;
}

function numbers(text) {
  return [...text.matchAll(/(?<![A-Za-z])-?\d*\.?\d+/g)].map(m => Number(m[0])).filter(Number.isFinite);
}

function detailDirection(detail) {
  if (!detail.includes('⇒')) return 'neutral';
  const [labelPart, rest = ''] = detail.split(/:(.*)/s);
  const [before = '', after = ''] = rest.split('⇒');
  const label = normalize(labelPart).toLowerCase();
  const oldNums = numbers(before);
  const newNums = numbers(after);
  if (!oldNums.length || !newNums.length) return 'neutral';

  // Only compare clean, monotonic numeric edits. Mixed formulas stay neutral and
  // are resolved by Riot's stated intent / overrides instead of guessing.
  let direction = 0;
  if (oldNums.length === newNums.length) {
    const deltas = oldNums.map((n, i) => newNums[i] - n);
    if (deltas.every(d => d >= 0) && deltas.some(d => d > 0)) direction = 1;
    else if (deltas.every(d => d <= 0) && deltas.some(d => d < 0)) direction = -1;
  } else {
    const oldMin = Math.min(...oldNums), oldMax = Math.max(...oldNums);
    const newMin = Math.min(...newNums), newMax = Math.max(...newNums);
    if (newMin >= oldMin && newMax > oldMax) direction = 1;
    else if (newMax <= oldMax && newMin < oldMin) direction = -1;
  }
  if (!direction) return 'neutral';

  const lowerIsBetter = /(cooldown|mana cost|energy cost|health cost|resource cost|cost$|damage taken|cast time|delay|lockout|recharge time)/i.test(label);
  const higherIsWorse = /(self damage|damage received)/i.test(label);
  const higherIsBetter = !lowerIsBetter && !higherIsWorse;

  const isBuff = higherIsBetter ? direction > 0 : direction < 0;
  return isBuff ? 'buff' : 'nerf';
}

function intentDirection(commentary) {
  const text = normalize(commentary);
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const last = (sentences.at(-1) || text).toLowerCase();

  // Prefer the forward-looking action in Riot's final sentence. This avoids
  // mistakes such as Smolder 26.20, where historical text mentions a prior
  // "nerf" but the current patch is plainly strengthening him.
  const buffIntent = /\b(buff|buffing|buffs|buffed)\b|\bcompensat(?:e|es|ed|ing|ion)\b|\binject(?:ing)? (?:a bit |some )?more power\b|\bmore power into\b|\bencourag(?:e|es|ed|ing)\b|\bhelp(?:ing)?\b.*\b(?:out|up|viability)\b|\bbring(?:ing)? .* closer in power\b|\bmake up for (?:the )?lost power\b|\broom for (?:a bit |some )?more power\b|\bstrengthen(?:ing)?\b/;
  const nerfIntent = /\bnerf(?:s|ed|ing)?\b|\bpull(?:ing)? back\b|\btap(?:ping)? down\b|\btrim(?:ming)?\b|\breduc(?:e|es|ed|ing)\b.*\bpower\b|\bhurt(?:ing)?\b|\btoo (?:strong|reliable|dominant)\b/;
  const adjustmentIntent = /\badjust(?:ment|ments|ing|ed)?\b|\bshift(?:ing)? power\b|\bnormalize\b/;

  const hasBuff = buffIntent.test(last);
  const hasNerf = nerfIntent.test(last);
  if (hasBuff && !hasNerf) return 'buff';
  if (hasNerf && !hasBuff) return 'nerf';
  if (adjustmentIntent.test(last) && !hasBuff && !hasNerf) return 'adjustment';

  // If the last sentence is inconclusive, look at the whole statement but give
  // explicit "we're giving ... a buff/nerf" language priority.
  const all = text.toLowerCase();
  if (/we(?:'re| are) (?:giving|following up with).*\bbuff\b|\bcompensation\b/.test(all)) return 'buff';
  if (/we(?:'re| are) (?:giving|following up with).*\bnerf\b/.test(all)) return 'nerf';
  return null;
}

function classify(commentary, details, patch, champion) {
  const override = OVERRIDES?.[patch]?.[champion];
  if (override) return override;

  const evidence = details.map(detailDirection);
  const buffs = evidence.filter(x => x === 'buff').length;
  const nerfs = evidence.filter(x => x === 'nerf').length;
  const intent = intentDirection(commentary);

  // Clean numeric direction is strongest evidence.
  if (buffs > 0 && nerfs === 0) return 'buff';
  if (nerfs > 0 && buffs === 0) return 'nerf';

  // Mixed patches can still be a genuine net buff/nerf when Riot explicitly
  // says so and the numeric evidence points the same way overall.
  if (buffs && nerfs) {
    if (intent === 'buff' && buffs > nerfs) return 'buff';
    if (intent === 'nerf' && nerfs > buffs) return 'nerf';
    return 'adjustment';
  }

  if (intent === 'buff' || intent === 'nerf') return intent;
  if (intent === 'adjustment') return 'adjustment';
  return 'review';
}

function cleanLabel(label) {
  return normalize(label)
    .replace(/^image\s*/i, '')
    .replace(/\bbonus\s+magic\s+damage\b/i, 'bonus magic damage')
    .replace(/\bself heal\b/i, 'self-healing')
    .replace(/\bbase healing\b/i, 'base healing')
    .replace(/\bper level\b/i, 'growth');
}

function reasonFrom(details, classification) {
  const directional = [];
  for (const detail of details) {
    const [rawLabel = ''] = detail.split(':');
    const dir = detailDirection(detail);
    if (dir === 'neutral') continue;
    const label = cleanLabel(rawLabel);
    const verb = dir === 'buff' ? 'improved' : 'reduced';
    directional.push(`${label} ${verb}`);
  }

  if (!directional.length) {
    if (classification === 'buff') return 'Riot increased this champion’s direct Summoner’s Rift power.';
    if (classification === 'nerf') return 'Riot reduced this champion’s direct Summoner’s Rift power.';
    if (classification === 'adjustment') return 'This patch shifts power between parts of the champion’s kit rather than being a clean one-direction change.';
    return 'The automatic parser could not determine a safe overall direction for this change.';
  }

  const shown = directional.slice(0, 3);
  const extra = directional.length > shown.length ? `, plus ${directional.length - shown.length} other change${directional.length - shown.length === 1 ? '' : 's'}` : '';
  return `Key changes: ${shown.join('; ')}${extra}.`;
}

function riotIntentSummary(commentary, champion, classification) {
  const t = normalize(commentary).toLowerCase();
  if (!t) return `Riot did not include a concise champion-level rationale that the parser could summarize.`;

  let focus = '';
  if (/crit/.test(t)) focus = ' with a focus on crit builds';
  else if (/jungle/.test(t)) focus = ' with a focus on jungle performance';
  else if (/bot lane|bot/.test(t)) focus = ' with bot-lane performance in mind';
  else if (/top lane|top/.test(t)) focus = ' with top-lane performance in mind';
  else if (/mid lane|\bmid\b/.test(t)) focus = ' with mid-lane performance in mind';
  else if (/late game/.test(t)) focus = ' in the late game';
  else if (/early (?:game|lane|laning)/.test(t)) focus = ' in the early game';
  else if (/pro[- ]?play|coordinated play|worlds/.test(t)) focus = ' around high-level and pro play';

  if (classification === 'buff') {
    if (/compensat|offset|lost .*power|weak|lagging|underperform/.test(t)) return `Riot says ${champion} has lost or lacks power and is being strengthened${focus}.`;
    return `Riot's stated goal is to strengthen ${champion}${focus}.`;
  }
  if (classification === 'nerf') {
    if (/too (?:strong|reliable|dominant)|premier|overperform|output too much/.test(t)) return `Riot says ${champion} is too strong or reliable and is being toned down${focus}.`;
    return `Riot's stated goal is to reduce ${champion}'s power${focus}.`;
  }
  if (classification === 'adjustment') return `Riot is redistributing ${champion}'s power${focus} rather than making a clean one-direction change.`;
  return `Riot provided context for ${champion}, but the automatic classifier still considers the overall direction ambiguous.`;
}

function parsePatch(html, url, patch) {
  const $ = cheerio.load(html);
  const article = $('article').first().length ? $('article').first() : $('body');
  const headings = article.find('h2,h3,h4').toArray();
  const championsH2Index = headings.findIndex(el => $(el).is('h2') && normalize($(el).text()).toLowerCase() === 'champions');
  if (championsH2Index < 0) return [];

  const changes = [];
  for (let i = championsH2Index + 1; i < headings.length; i++) {
    const h = headings[i];
    if ($(h).is('h2')) break; // stops before Items / Systems / Classic / ARAM
    if (!$(h).is('h3')) continue;
    const champion = normalize($(h).text());
    if (!champion || champion.length > 40) continue;

    let commentary = '';
    const details = [];
    let node = $(h).next();
    while (node.length && !node.is('h2,h3')) {
      if (!commentary && node.is('p,blockquote')) commentary = normalize(node.text());
      if (node.is('ul')) node.find('li').each((_, li) => details.push(normalize($(li).text())));
      node = node.next();
    }

    const classification = classify(commentary, details, patch, champion);
    changes.push({
      champion,
      classification,
      reason: reasonFrom(details, classification),
      riotStatement: riotIntentSummary(commentary, champion, classification),
      details: details.slice(0, 8),
      needsReview: classification === 'review'
    });
  }
  return changes;
}

async function discover() {
  const html = await fetchHtml(INDEX);
  const $ = cheerio.load(html);
  const found = new Map();
  $('a[href*="league-of-legends-patch-"]').each((_, a) => {
    const text = normalize($(a).text());
    const patch = patchNumberFromText(text) || $(a).attr('href')?.match(/patch-(\d+-\d+)-notes/)?.[1]?.replace('-', '.');
    if (!patch || found.has(patch)) return;
    const href = new URL($(a).attr('href'), INDEX).href;
    found.set(patch, href);
  });
  return [...found.entries()].sort((a,b) => {
    const [am,an]=a[0].split('.').map(Number), [bm,bn]=b[0].split('.').map(Number);
    return bm-am || bn-an;
  }).slice(0, WINDOW);
}

const existing = JSON.parse(await fs.readFile(DATA, 'utf8'));
const discovered = await discover();
const patches = [];

// Re-parse all five patches each run. This is intentional: parser improvements
// and new overrides should fix already-discovered patches instead of being stuck
// with whatever classification was first generated.
for (const [patch, sourceUrl] of discovered) {
  console.log(`Parsing patch ${patch}: ${sourceUrl}`);
  const html = await fetchHtml(sourceUrl);
  const $ = cheerio.load(html);
  const date = $('time').first().attr('datetime')?.slice(0,10) || new Date().toISOString().slice(0,10);
  const changes = parsePatch(html, sourceUrl, patch);
  patches.push({ patch, date, sourceUrl, changes });
}

const semanticOld = JSON.stringify({ windowSize: existing.windowSize, patches: existing.patches });
const semanticNew = JSON.stringify({ windowSize: WINDOW, patches });
const changed = semanticOld !== semanticNew;
const output = {
  updatedAt: changed ? new Date().toISOString() : existing.updatedAt,
  windowSize: WINDOW,
  patches
};

await fs.writeFile(DATA, JSON.stringify(output, null, 2) + '\n');
const review = patches.flatMap(p => p.changes.filter(c => c.needsReview).map(c => `${p.patch} ${c.champion}`));
console.log(`${changed ? 'Updated' : 'Checked'} ${patches.length} patches in data/patches.json`);
if (review.length) console.log(`Needs review: ${review.join(', ')}`);
else console.log('No champion changes need manual review.');
