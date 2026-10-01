const state = { data: null, threshold: 2, sort: 'buffs', patch: null, patchFilter: 'all' };
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function load() {
  const [data, config] = await Promise.all([
    fetch('./data/patches.json').then(r => r.json()),
    fetch('./data/config.json').then(r => r.json())
  ]);
  state.data = data;
  state.threshold = config.defaultBuffThreshold ?? 2;
  $('#threshold').value = state.threshold;
  state.patch = data.patches[0]?.patch;
  renderMeta();
  bind();
  route();
}

function renderMeta() {
  const patches = state.data.patches;
  $('#window-label').textContent = `${patches.at(-1).patch} → ${patches[0].patch}`;
  const dt = new Date(state.data.updatedAt);
  $('#updated-label').textContent = `Data updated ${dt.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}`;
}

function bind() {
  $('#threshold').addEventListener('input', e => { state.threshold = Number(e.target.value); renderStrong(); });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; renderStrong(); });
  window.addEventListener('hashchange', route);
}

function route() {
  const route = (location.hash.replace('#','') || 'strong').split('/')[0];
  const valid = ['strong','patches','about'].includes(route) ? route : 'strong';
  $$('.view').forEach(x => x.classList.add('hidden'));
  $(`#${valid}-view`).classList.remove('hidden');
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === valid));
  if (valid === 'strong') renderStrong();
  if (valid === 'patches') renderPatches();
}

function championTimeline() {
  const map = new Map();
  for (const patch of state.data.patches) {
    for (const change of patch.changes) {
      if (!map.has(change.champion)) map.set(change.champion, []);
      map.get(change.champion).push({ ...change, patch: patch.patch, date: patch.date, sourceUrl: patch.sourceUrl });
    }
  }
  return map;
}

function renderStrong() {
  $('#threshold-output').textContent = `${state.threshold} / ${state.data.windowSize}`;
  const timelines = championTimeline();
  let rows = [...timelines.entries()].map(([champion, changes]) => {
    const buffs = changes.filter(c => c.classification === 'buff');
    return { champion, changes, buffs, latestBuff: buffs.sort((a,b)=>b.date.localeCompare(a.date))[0] };
  }).filter(x => x.buffs.length >= state.threshold);

  if (state.sort === 'name') rows.sort((a,b)=>a.champion.localeCompare(b.champion));
  else if (state.sort === 'recent') rows.sort((a,b)=>(b.latestBuff?.date||'').localeCompare(a.latestBuff?.date||'') || b.buffs.length-a.buffs.length);
  else rows.sort((a,b)=>b.buffs.length-a.buffs.length || (b.latestBuff?.date||'').localeCompare(a.latestBuff?.date||'') || a.champion.localeCompare(b.champion));

  $('#result-summary').textContent = `${rows.length} champion${rows.length===1?'':'s'} with at least ${state.threshold} buffed patch${state.threshold===1?'':'es'} in the current window.`;
  const grid = $('#strong-grid'); grid.innerHTML = '';
  if (!rows.length) {
    grid.innerHTML = `<div class="empty">No champions meet this threshold in the current five-patch window.</div>`;
    return;
  }
  for (const row of rows) {
    const card = document.createElement('article'); card.className = 'champion-card';
    const perPatch = state.data.patches.slice().reverse().map(p => row.changes.find(c => c.patch===p.patch));
    card.innerHTML = `
      <div class="champion-card-top"><div><h3>${escapeHtml(row.champion)}</h3><span class="muted">Direct SR balance changes</span></div><div class="score">${row.buffs.length} / ${state.data.windowSize} buffs</div></div>
      <div class="patch-strip">${state.data.patches.slice().reverse().map((p,i)=>{
        const c = perPatch[i]; const cls = c?.classification || '';
        const symbol = cls==='buff'?'↑':cls==='nerf'?'↓':cls==='adjustment'?'↔':'—';
        return `<div class="patch-dot ${cls}" title="${p.patch}: ${cls||'no direct change'}"><strong>${symbol}</strong><br>${p.patch}</div>`;
      }).join('')}</div>
      <p class="latest-reason"><strong>Latest buff (${row.latestBuff.patch}):</strong> ${escapeHtml(row.latestBuff.reason)}</p>`;
    card.addEventListener('click', () => { location.hash = 'patches'; state.patch = row.latestBuff.patch; setTimeout(renderPatches,0); });
    grid.append(card);
  }
}

function renderPatches() {
  const tabs = $('#patch-tabs'); tabs.innerHTML = '';
  for (const patch of state.data.patches) {
    const btn = document.createElement('button'); btn.className = `patch-tab ${patch.patch===state.patch?'active':''}`; btn.role='tab'; btn.textContent = `Patch ${patch.patch}`;
    btn.addEventListener('click', ()=>{ state.patch=patch.patch; state.patchFilter='all'; renderPatches(); });
    tabs.append(btn);
  }
  const patch = state.data.patches.find(p => p.patch === state.patch) || state.data.patches[0];
  const content = $('#patch-content'); content.innerHTML = `
    <div class="patch-header"><div><h2>Patch ${patch.patch}</h2><div class="muted">${new Date(patch.date+'T00:00:00').toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'})} · ${patch.changes.length} direct champion changes</div></div><a class="source-link" href="${patch.sourceUrl}" target="_blank" rel="noreferrer">Open Riot notes ↗</a></div>
    <div class="filters">${['all','buff','nerf','adjustment'].map(f=>`<button class="filter-button ${state.patchFilter===f?'active':''}" data-filter="${f}">${f[0].toUpperCase()+f.slice(1)}</button>`).join('')}</div>
    <div class="change-list"></div>`;
  content.querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click',()=>{state.patchFilter=btn.dataset.filter; renderPatches();}));
  const list = content.querySelector('.change-list');
  const changes = patch.changes.filter(c => state.patchFilter==='all' || c.classification===state.patchFilter);
  if (!changes.length) { list.innerHTML = `<div class="empty">No ${state.patchFilter} changes in this patch.</div>`; return; }
  for (const change of changes) list.append(renderChange(change));
}

function renderChange(change) {
  const node = $('#change-template').content.firstElementChild.cloneNode(true);
  node.querySelector('h3').textContent = change.champion;
  const pill = node.querySelector('.pill'); pill.textContent = change.classification; pill.classList.add(change.classification);
  node.querySelector('.reason').textContent = change.reason;
  node.querySelector('.riot-statement').textContent = change.riotStatement;
  const ul = node.querySelector('.details-list');
  for (const detail of change.details || []) { const li = document.createElement('li'); li.textContent = detail; ul.append(li); }
  return node;
}

function escapeHtml(s='') { return s.replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

load().catch(err => { console.error(err); document.body.innerHTML = `<main class="shell"><div class="empty">Could not load patch data. Run this project from a local web server (for example <code>npm run dev</code>), not directly from a file URL.</div></main>`; });
