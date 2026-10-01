import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'patches.json');
const OVERRIDES = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'overrides.json'), 'utf8'));
const INDEX = 'https://www.leagueoflegends.com/en-us/news/tags/patch-notes/';
const WINDOW = 5;

const normalize = s => s.replace(/\s+/g, ' ').trim();

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'lol-strong-champions/1.0 personal patch tracker' } });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

function patchNumberFromText(text) {
  return text.match(/Patch\s+(\d+\.\d+)\s+Notes/i)?.[1] ?? null;
}

function classify(commentary, details, patch, champion) {
  const override = OVERRIDES?.[patch]?.[champion];
  if (override) return override;
  const t = `${commentary} ${details.join(' ')}`.toLowerCase();
  const mixedWords = /adjust|compensat|trade|shift(?:ing)? power|while (?:also )?(?:reducing|nerfing)|but .*buff|buff.*but/;
  const buffWords = /\bbuff(?:s|ed|ing)?\b|give .* (?:some )?(?:power|love|boost)|room for power|help(?:ing)? .* (?:out|up)|tuning .* up|tap(?:ping)? up|increase .* power/;
  const nerfWords = /\bnerf(?:s|ed|ing)?\b|tap(?:ping)? down|pull(?:ing)? .* power|reduce .* power|too strong|overperform/;
  if (mixedWords.test(t)) return 'review';
  if (buffWords.test(t) && !nerfWords.test(t)) return 'buff';
  if (nerfWords.test(t) && !buffWords.test(t)) return 'nerf';
  return 'review';
}

function summaryFrom(commentary, classification) {
  if (!commentary) return `Automatically extracted ${classification} candidate; review recommended.`;
  const first = normalize(commentary).split(/(?<=[.!?])\s+/)[0];
  return first.length <= 210 ? first : `${first.slice(0, 207)}…`;
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
      reason: summaryFrom(commentary, classification),
      riotStatement: commentary ? `Riot's intent: ${summaryFrom(commentary, classification)}` : 'No concise commentary was extracted automatically.',
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
const oldByPatch = new Map(existing.patches.map(p => [p.patch, p]));
const discovered = await discover();
const patches = [];

for (const [patch, sourceUrl] of discovered) {
  const old = oldByPatch.get(patch);
  if (old) { patches.push(old); continue; }
  console.log(`New patch ${patch}: ${sourceUrl}`);
  const html = await fetchHtml(sourceUrl);
  const $ = cheerio.load(html);
  const date = $('time').first().attr('datetime')?.slice(0,10) || new Date().toISOString().slice(0,10);
  const changes = parsePatch(html, sourceUrl, patch);
  patches.push({ patch, date, sourceUrl, changes });
}

const output = { updatedAt: new Date().toISOString(), windowSize: WINDOW, patches };
await fs.writeFile(DATA, JSON.stringify(output, null, 2) + '\n');
const review = patches.flatMap(p => p.changes.filter(c => c.needsReview).map(c => `${p.patch} ${c.champion}`));
console.log(`Saved ${patches.length} patches to data/patches.json`);
if (review.length) console.log(`Needs review: ${review.join(', ')}`);
