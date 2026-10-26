(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api = async (method, url, body) => {
  const r = await fetch(url, {method, headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Error ' + r.status);
  return j;
};
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); };
const fmtDate = iso => new Date(iso).toLocaleDateString('es', {day: 'numeric', month: 'short', year: 'numeric'});
const fmtDT = iso => new Date(iso).toLocaleString('es', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const dayLabel = iso => {
  const d = new Date(iso), t = new Date(); const k = x => x.toDateString();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (k(d) === k(t)) return 'Hoy';
  if (k(d) === k(y)) return 'Ayer';
  return d.toLocaleDateString('es', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'});
};
const num = n => (n || 0).toLocaleString('es');
const snippet = (t, n = 240) => t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
const metrics = m => `<div class="metrics"><span>♥ ${num(m.likes)}</span><span>↻ ${num(m.reposts)}</span>${m.impressions ? `<span>👁 ${num(m.impressions)}</span>` : ''}</div>`;
const sampleBadge = p => p.sample ? '<span class="pill sample">Ejemplo</span>' : '';
const authorLine = p => `<div class="byline"><span class="author">${esc(p.author_name)}</span><span class="handle">@${esc(p.author_username)}</span><span class="meta">· ${fmtDate(p.created_at)}</span></div>`;
const whyHtml = w => w ? `<div class="why"><b>Por qué vale la pena leerlo</b>${w.split('\n').filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('')}</div>` : '';

// ---------- selección y subrayado ----------
let currentPost = null;
function renderMarked(text, hls) {
  const cuts = new Set([0, text.length]);
  hls.forEach(h => { cuts.add(h.start); cuts.add(h.end); });
  const pts = [...cuts].sort((a, b) => a - b);
  let out = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]], seg = esc(text.slice(a, b));
    const ids = hls.filter(h => h.start <= a && h.end >= b).map(h => h.id);
    out += ids.length ? `<mark class="hl" data-ids="${ids.join(',')}">${seg}</mark>` : seg;
  }
  return out;
}
function selectionInfo() {
  const el = $('#ptext'); const sel = getSelection();
  if (!el || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  let start = pre.toString().length, end = start + r.toString().length;
  const t = currentPost.text;
  while (start < end && /\s/.test(t[start])) start++;
  while (end > start && /\s/.test(t[end - 1])) end--;
  return start < end ? {start, end, text: t.slice(start, end)} : null;
}
let selTimer;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => { $('#selbar').hidden = !(currentPost && selectionInfo()); }, 120);
});
async function doHighlight(andNote) {
  const s = selectionInfo(); if (!s) return;
  try {
    const h = await api('POST', '/api/highlights', {post_id: currentPost.id, ...s});
    getSelection().removeAllRanges(); $('#selbar').hidden = true;
    toast('Subrayado guardado');
    await openPost(currentPost.id, {hid: h.id, noAutoRead: true});
    if (andNote) noteDialog({post_id: currentPost.id, highlight_id: h.id});
  } catch (e) { toast(e.message); }
}
$('#btn-hl').onclick = () => doHighlight(false);
$('#btn-hl-note').onclick = () => doHighlight(true);
// evita que tocar los botones borre la selección en móvil
['mousedown', 'touchstart'].forEach(ev => $('#selbar').addEventListener(ev, e => e.preventDefault(), {passive: false}));

// ---------- modales ----------
function modal(html, onMount) {
  const m = $('#modal'); m.innerHTML = `<div class="sheet">${html}</div>`; m.hidden = false;
  m.onclick = e => { if (e.target === m) closeModal(); };
  onMount && onMount(m);
}
const closeModal = () => { $('#modal').hidden = true; $('#modal').innerHTML = ''; };

async function noteDialog({post_id, highlight_id = null, note = null}) {
  const hls = (await api('GET', '/api/highlights')).filter(h => h.post_id === post_id);
  const sel = note ? note.highlight_id : highlight_id;
  modal(`<h3>${note ? 'Editar nota' : 'Nueva nota'}</h3>
    <label>Subrayado asociado (opcional)</label>
    <select id="n-hl" ${note ? 'disabled' : ''}><option value="">— ninguno —</option>${hls.map(h => `<option value="${h.id}" ${h.id === sel ? 'selected' : ''}>${esc(snippet(h.text, 70))}</option>`).join('')}</select>
    ${note && !note.highlight_id && note.highlight_text ? `<p class="small muted">Subrayado original (ya quitado): “${esc(snippet(note.highlight_text, 120))}”</p>` : ''}
    <label>Mi nota</label><textarea id="n-body" placeholder="Qué pienso de esto…">${esc(note?.body || '')}</textarea>
    <label>Por qué lo anoté</label><textarea id="n-why" style="min-height:64px" placeholder="Contexto: para qué me sirve, con qué lo conecto…">${esc(note?.why || '')}</textarea>
    <div class="row between" style="margin-top:16px"><button class="btn" id="n-cancel">Cancelar</button><button class="btn primary" id="n-save">Guardar nota</button></div>`,
  () => {
    $('#n-cancel').onclick = closeModal;
    $('#n-save').onclick = async () => {
      const body = {body: $('#n-body').value, why: $('#n-why').value};
      try {
        if (note) await api('PUT', '/api/notes/' + note.id, body);
        else await api('POST', '/api/notes', {...body, post_id, highlight_id: $('#n-hl').value || null});
        closeModal(); toast('Nota guardada'); route();
      } catch (e) { toast(e.message); }
    };
    $('#n-body').focus();
  });
}

// ---------- vistas ----------
function setTab(t) { document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === t)); }
const chipsHtml = p => (p.themes || []).map(t => `<span class="chip tiny">${esc(t)}</span>`).join('');
const postCard = p => `<article class="card click ${p.read ? 'is-read' : ''}" data-go="${p.id}">
  <div class="row between">${authorLine(p)}<span>${p.read ? '<span class="pill soft">Leído</span>' : '<span class="dot" title="Sin leer"></span>'}${sampleBadge(p)}</span></div>
  <div class="snippet">${esc(snippet(p.text))}</div>
  <div class="chips">${chipsHtml(p)}</div>
  <div class="row between">${metrics(p.metrics || {})}<span class="meta">${p.highlight_count ? `▍${p.highlight_count} subrayado${p.highlight_count > 1 ? 's' : ''} ` : ''}${p.note_count ? `✎ ${p.note_count} nota${p.note_count > 1 ? 's' : ''}` : ''}</span></div>
</article>`;

const flt = {q: '', theme: '', read: 'all'};
const norm = t => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function todayCard(t) {
  const d = t.digest, rec = d?.post, r = t.review;
  const dateTxt = new Date().toLocaleDateString('es', {weekday: 'long', day: 'numeric', month: 'long'});
  return `<section class="card today">
    <div class="row between"><h1 style="margin:0">Hoy</h1><span class="meta cap">${esc(dateTxt)}</span></div>
    <div class="stats">
      <button class="stat" id="st-unread"><b>${t.unread}</b><span>sin leer de ${t.total}</span></button>
      <a class="stat" href="#/repaso"><b>${r.done}/${r.total || 0}</b><span>repaso del día</span></a>
    </div>
    ${rec ? `<div class="tsec"><span class="pill">${d.is_today ? 'Recomendado de hoy' : 'Último recomendado · ' + fmtDate(d.date + 'T12:00:00')}</span>${sampleBadge(rec)}
      ${rec.read ? '<span class="pill soft">Leído</span>' : ''}
      ${authorLine(rec)}
      <div class="snippet">${esc(snippet(rec.text, 220))}</div>
      ${whyHtml(d.why)}
      <a class="btn accent" href="#/post/${rec.id}">Leer completo →</a></div>` : '<p class="muted small">Sin recomendado todavía. Ejecuta el ingest diario.</p>'}
    <div class="tsec">
      <div class="row between"><b>Repaso del día</b><span class="meta">${r.done}/${r.total} hechos</span></div>
      ${r.total ? `<div class="progress"><i style="width:${r.total ? 100 * r.done / r.total : 0}%"></i></div>
        ${r.items.map(i => `<div class="mini ${i.reviewed_today ? 'done' : ''}">${i.reviewed_today ? '✓ ' : ''}${esc(snippet(i.highlight.text, 90))}</div>`).join('')}
        <a class="btn ${r.done < r.total ? 'primary' : ''}" href="#/repaso" style="margin-top:10px">${r.done < r.total ? 'Repasar ahora' : 'Ver repaso'}</a>`
        : '<p class="muted small">Subraya algo en un post y mañana empezará tu repaso diario.</p>'}
    </div></section>`;
}

function filteredPosts(posts) {
  const q = norm(flt.q.trim());
  return posts.filter(p => (!flt.theme || (p.themes || []).includes(flt.theme))
    && (flt.read === 'all' || (flt.read === 'read') === !!p.read)
    && (!q || norm(p.text + ' ' + p.author_name + ' ' + p.author_username + ' ' + (p.themes || []).join(' ')).includes(q)));
}

async function viewLectura() {
  setTab('lectura'); currentPost = null;
  const [posts, today] = await Promise.all([api('GET', '/api/posts'), api('GET', '/api/today')]);
  const themeCount = {};
  posts.forEach(p => (p.themes || []).forEach(t => themeCount[t] = (themeCount[t] || 0) + 1));
  const recId = today.digest?.post?.id;
  app.innerHTML = todayCard(today) + `<h2>Biblioteca (${posts.length})</h2>
    <div class="searchbar"><input type="search" id="q" placeholder="Buscar en posts, autores y temas…" value="${esc(flt.q)}" autocomplete="off"></div>
    <div class="chips" id="theme-chips"><button class="chip ${!flt.theme ? 'on' : ''}" data-theme="">Todos</button>${Object.keys(themeCount).sort().map(t => `<button class="chip ${flt.theme === t ? 'on' : ''}" data-theme="${esc(t)}">${esc(t)} <i>${themeCount[t]}</i></button>`).join('')}</div>
    <div class="seg" id="seg">${[['all', 'Todos'], ['unread', 'Sin leer'], ['read', 'Leídos']].map(([k, l]) => `<button class="${flt.read === k ? 'on' : ''}" data-read="${k}">${l}</button>`).join('')}</div>
    <div id="plist"></div>`;
  const draw = () => {
    const any = flt.q || flt.theme || flt.read !== 'all';
    const list = filteredPosts(any ? posts : posts.filter(p => p.id !== recId));
    $('#plist').innerHTML = list.length ? list.map(postCard).join('') : '<div class="empty">Ningún post coincide con los filtros.<br><button class="btn small" id="clear">Quitar filtros</button></div>';
    $('#plist').querySelectorAll('[data-go]').forEach(e => e.onclick = () => location.hash = '#/post/' + e.dataset.go);
    const c = $('#clear'); if (c) c.onclick = () => { Object.assign(flt, {q: '', theme: '', read: 'all'}); viewLectura(); };
  };
  $('#q').oninput = e => { flt.q = e.target.value; draw(); };
  $('#theme-chips').onclick = e => { const b = e.target.closest('[data-theme]'); if (!b) return; flt.theme = b.dataset.theme;
    document.querySelectorAll('#theme-chips .chip').forEach(c => c.classList.toggle('on', c === b)); draw(); };
  $('#seg').onclick = e => { const b = e.target.closest('[data-read]'); if (!b) return; flt.read = b.dataset.read;
    document.querySelectorAll('#seg button').forEach(c => c.classList.toggle('on', c === b)); draw(); };
  $('#st-unread').onclick = () => { flt.read = 'unread'; viewLectura().then(() => $('#seg').scrollIntoView({behavior: 'smooth', block: 'start'})); };
  draw();
}

async function viewRepaso() {
  setTab('repaso'); currentPost = null;
  const r = await api('GET', '/api/review/today');
  const pending = r.items.filter(i => !i.reviewed_today), done = r.items.filter(i => i.reviewed_today);
  const resTxt = x => x === 'remembered' ? 'Lo recordé' : 'Repasar de nuevo';
  let html = '<h1>Repaso del día</h1>';
  if (!r.total) html += '<div class="empty">Aún no tienes subrayados para repasar.<br>Subraya algo en un post y vuelve mañana.</div>';
  else {
    html += `<div class="row between"><span class="meta">${r.done} de ${r.total} repasados hoy</span></div><div class="progress"><i style="width:${100 * r.done / r.total}%"></i></div>`;
    if (pending.length) {
      const i = pending[0], h = i.highlight;
      html += `<article class="card review"><span class="pill soft">Subrayado ${r.done + 1} de ${r.total}</span>
        <blockquote class="quote big">${esc(h.text)}</blockquote>
        <div class="meta">${esc(i.post.author_name || '')} · @${esc(i.post.author_username || '')} ${i.post.sample ? '<span class="pill sample">Ejemplo</span>' : ''}<br>Subrayado el ${fmtDate(h.created_at)} · repasado ${i.count} ${i.count === 1 ? 'vez' : 'veces'}</div>
        <div class="row" style="margin:12px 0"><a class="btn small" href="#/post/${i.post.id}?h=${h.id}">Ver en contexto</a>
          ${i.post.url ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(i.post.url)}">Original en X ↗</a>` : ''}</div>
        <div class="row two"><button class="btn big-btn" data-res="again" data-id="${h.id}">↺ Repasar de nuevo</button><button class="btn big-btn ok" data-res="remembered" data-id="${h.id}">✓ Lo recordé</button></div></article>`;
    } else html += '<div class="card review doneall"><h3 style="margin:0 0 6px">¡Listo por hoy! 🎉</h3><p class="muted" style="margin:0">Terminaste el repaso. Mañana habrá una nueva selección.</p></div>';
    if (done.length) html += '<h2>Repasados hoy</h2>' + done.map(i => `<article class="card"><blockquote class="quote">${esc(i.highlight.text)}</blockquote>
      <div class="row between"><span class="pill ${i.result_today === 'remembered' ? 'ok' : 'soft'}">${resTxt(i.result_today)}</span><span class="meta">${i.count} ${i.count === 1 ? 'repaso' : 'repasos'} en total</span></div></article>`).join('');
  }
  app.innerHTML = html;
  app.querySelectorAll('[data-res]').forEach(b => b.onclick = async () => {
    try { await api('POST', '/api/review', {highlight_id: b.dataset.id, result: b.dataset.res}); toast(b.dataset.res === 'remembered' ? '¡Bien! Guardado' : 'Lo verás de nuevo pronto'); viewRepaso(); window.scrollTo(0, 0); }
    catch (e) { toast(e.message); }
  });
}

async function openPost(id, opts = {}) {
  setTab('lectura');
  const [p, hls, notes] = await Promise.all([api('GET', '/api/posts/' + id), api('GET', '/api/highlights'), api('GET', '/api/notes')]);
  currentPost = p;
  if (!p.read && !opts.noAutoRead) { p.read = true; api('POST', `/api/posts/${id}/read`, {read: true}).catch(() => {}); }
  const mine = hls.filter(h => h.post_id === id).sort((a, b) => a.start - b.start);
  const myNotes = notes.filter(n => n.post_id === id);
  app.innerHTML = `<a href="#/" class="small">← Volver a Lectura</a>
    <div class="row between" style="margin-top:10px"><div>${authorLine(p)}</div><span>${sampleBadge(p)}</span></div>
    <div class="chips" style="margin-top:6px">${chipsHtml(p)}</div>
    <div id="ptext" class="reader">${renderMarked(p.text, mine)}</div>
    ${metrics(p.metrics || {})}
    <div class="row" style="margin:14px 0"><a class="btn" target="_blank" rel="noopener" href="${esc(p.url)}">Abrir original en X ↗</a>
      <button class="btn" id="add-note">+ Nota</button>
      <button class="btn" id="toggle-read">${p.read ? '✓ Leído · marcar como no leído' : 'Marcar como leído'}</button></div>
    <p class="small muted">Selecciona texto del post para subrayarlo. Toca un subrayado para quitarlo o anotarlo.</p>
    ${mine.length ? `<h2>Subrayados de este post (${mine.length})</h2>` + mine.map(h => `<blockquote class="quote">${esc(h.text)}</blockquote>`).join('') : ''}
    ${myNotes.length ? `<h2>Notas de este post (${myNotes.length})</h2>` + myNotes.map(noteCard).join('') : ''}`;
  $('#add-note').onclick = () => noteDialog({post_id: id});
  $('#toggle-read').onclick = async () => {
    const nowRead = !(p.read);
    await api('POST', `/api/posts/${id}/read`, {read: nowRead}); p.read = nowRead;
    $('#toggle-read').textContent = nowRead ? '✓ Leído · marcar como no leído' : 'Marcar como leído'; toast(nowRead ? 'Marcado como leído' : 'Marcado como no leído');
  };
  wireNoteButtons();
  app.querySelectorAll('mark.hl').forEach(m => m.onclick = () => {
    const ids = m.dataset.ids.split(',');
    const items = ids.map(i => mine.find(h => h.id === i)).filter(Boolean);
    modal(`<h3>Subrayado</h3>${items.map(h => `<blockquote class="quote">${esc(h.text)}</blockquote>
      <div class="row"><button class="btn small" data-note="${h.id}">+ Nota</button><button class="btn small danger" data-del="${h.id}">Quitar subrayado</button></div>`).join('<div class="sep"></div>')}
      <div class="row" style="margin-top:14px"><button class="btn" id="m-close">Cerrar</button></div>`, mm => {
      $('#m-close').onclick = closeModal;
      mm.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('DELETE', '/api/highlights/' + b.dataset.del); closeModal(); toast('Subrayado quitado'); openPost(id, {noAutoRead: true}); });
      mm.querySelectorAll('[data-note]').forEach(b => b.onclick = () => noteDialog({post_id: id, highlight_id: b.dataset.note}));
    });
  });
  if (opts.hid) {
    const mk = [...app.querySelectorAll('mark.hl')].find(m => m.dataset.ids.split(',').includes(opts.hid));
    if (mk) { mk.scrollIntoView({block: 'center'}); mk.classList.add('flash'); }
  } else window.scrollTo(0, 0);
}

async function viewSubrayados() {
  setTab('subrayados'); currentPost = null;
  const [hls, posts] = await Promise.all([api('GET', '/api/highlights'), api('GET', '/api/posts')]);
  const byId = Object.fromEntries(posts.map(p => [p.id, p]));
  let html = `<h1>Subrayados</h1>`;
  if (!hls.length) html += '<div class="empty">Todavía no has subrayado nada.<br>Abre un post en Lectura y selecciona texto.</div>';
  let last = '';
  for (const h of hls) {
    const p = byId[h.post_id]; const day = dayLabel(h.created_at);
    if (day !== last) { html += `<div class="daygroup">${esc(day)}</div>`; last = day; }
    html += `<article class="card"><blockquote class="quote">${esc(h.text)}</blockquote>
      <div class="meta">${p ? `${esc(p.author_name)} · @${esc(p.author_username)} · ` : ''}${fmtDT(h.created_at)} ${p?.sample ? '<span class="pill sample">Ejemplo</span>' : ''}</div>
      <div class="row" style="margin-top:10px"><button class="btn small primary" data-goh="${h.id}" data-post="${h.post_id}">Ir al post</button>
        ${p ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(p.url)}">Original en X ↗</a>` : ''}
        <button class="btn small" data-note="${h.id}" data-post="${h.post_id}">+ Nota</button>
        <button class="btn small danger" data-del="${h.id}">Quitar</button></div></article>`;
  }
  app.innerHTML = html;
  app.querySelectorAll('[data-goh]').forEach(b => b.onclick = () => location.hash = `#/post/${b.dataset.post}?h=${b.dataset.goh}`);
  app.querySelectorAll('[data-note]').forEach(b => b.onclick = () => noteDialog({post_id: b.dataset.post, highlight_id: b.dataset.note}));
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('¿Quitar este subrayado?')) return; await api('DELETE', '/api/highlights/' + b.dataset.del); toast('Subrayado quitado'); route(); });
}

let postsCache = {};
const noteCard = n => {
  const p = postsCache[n.post_id];
  return `<article class="card" data-nid="${n.id}">
    <div class="meta">${fmtDT(n.created_at)}${n.updated_at !== n.created_at ? ' · editada' : ''} ${p?.sample ? '<span class="pill sample">Ejemplo</span>' : ''}</div>
    ${n.highlight_text ? `<blockquote class="quote">${esc(n.highlight_text)}</blockquote>` : ''}
    ${n.why ? `<div class="why"><b>Por qué lo anoté</b><p>${esc(n.why)}</p></div>` : ''}
    ${n.body ? `<div class="note-body">${esc(n.body)}</div>` : ''}
    <div class="meta">${p ? `De ${esc(p.author_name)} (@${esc(p.author_username)})` : 'Post no disponible'}</div>
    <div class="row" style="margin-top:10px"><a class="btn small primary" href="#/post/${n.post_id}${n.highlight_id ? '?h=' + n.highlight_id : ''}">Ir al post</a>
      ${p ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(p.url)}">Original en X ↗</a>` : ''}
      <button class="btn small" data-edit="${n.id}">Editar</button><button class="btn small danger" data-delnote="${n.id}">Borrar</button></div></article>`;
};
function wireNoteButtons() {
  app.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => {
    const n = (await api('GET', '/api/notes')).find(x => x.id === b.dataset.edit); noteDialog({post_id: n.post_id, note: n});
  });
  app.querySelectorAll('[data-delnote]').forEach(b => b.onclick = async () => { if (!confirm('¿Borrar esta nota?')) return; await api('DELETE', '/api/notes/' + b.dataset.delnote); toast('Nota borrada'); route(); });
}
async function viewNotas() {
  setTab('notas'); currentPost = null;
  const [notes, posts] = await Promise.all([api('GET', '/api/notes'), api('GET', '/api/posts')]);
  postsCache = Object.fromEntries(posts.map(p => [p.id, p]));
  app.innerHTML = `<h1>Notas</h1>` + (notes.length ? notes.map(noteCard).join('') : '<div class="empty">Aún no tienes notas.<br>Crea una desde un post o a partir de un subrayado.</div>');
  wireNoteButtons();
}

async function route() {
  const [path, q] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(q || '');
  try {
    if (path.startsWith('/post/')) { postsCache = {}; await openPost(path.split('/')[2], {hid: params.get('h')}); }
    else if (path === '/repaso') await viewRepaso();
    else if (path === '/subrayados') await viewSubrayados();
    else if (path === '/notas') await viewNotas();
    else await viewLectura();
    if (!path.startsWith('/post/')) window.scrollTo(0, 0);
  } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}<br><a href="#/">Volver</a></div>`; }
}
window.addEventListener('hashchange', () => { closeModal(); $('#selbar').hidden = true; route(); });
route();
})();
