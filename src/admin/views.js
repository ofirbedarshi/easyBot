import { stageLabel } from './stage.js';

const LEAD_ANSWER_LABELS = {
  channels: 'Where the bot should work',
  channelsOther: 'Other channel',
  actions: 'Beyond answering questions',
  actionsOther: 'Other action',
  dailyInquiries: 'Inquiries per day',
  system: 'Current system',
  systemName: 'System name',
};

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#0b6b6e"/><path d="M8 11.2c0-1.2.9-2.2 2.1-2.2h11.8c1.2 0 2.1 1 2.1 2.2v8.1c0 1.2-.9 2.2-2.1 2.2h-6.3L11 24.2v-2.7H10.1C8.9 21.5 8 20.5 8 19.3v-8.1z" fill="#fff"/><circle cx="13" cy="15.2" r="1.15" fill="#0b6b6e"/><circle cx="16.4" cy="15.2" r="1.15" fill="#0b6b6e"/><circle cx="19.8" cy="15.2" r="1.15" fill="#0b6b6e"/></svg>`;

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function formatStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function css() {
  return `
:root {
  --bg: #f3efe6;
  --bg-2: #ebe4d6;
  --paper: #fffcf7;
  --ink: #1b1f1e;
  --muted: #5f6b68;
  --line: #e4dccb;
  --teal: #0b6b6e;
  --teal-ink: #084446;
  --teal-soft: #d7eeee;
  --sand: #f7f1e6;
  --out: #d9efe8;
  --in: #ffffff;
  --lead: #1b5e20;
  --ok: #0d47a1;
  --warn: #b45309;
  --err-bg: #fdecea;
  --err-ink: #8a1f11;
  --shadow: 0 10px 30px rgba(27, 31, 30, 0.06);
  --radius: 16px;
  --tap: 44px;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font: 16px/1.45 "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: var(--ink);
  background:
    radial-gradient(1200px 500px at 10% -10%, #e7f3f3 0%, transparent 55%),
    var(--bg);
}
a { color: var(--teal); }
button, input { font: inherit; }
.mark { width: 32px; height: 32px; display: block; flex: none; }

/* —— Login —— */
.login-page { min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; }
.login-card {
  width: min(100%, 400px);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: var(--shadow);
  padding: 32px 26px 28px;
}
.login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.login-brand h1 { margin: 0; font-size: 1.35rem; letter-spacing: -0.03em; }
.login-brand p { margin: 2px 0 0; color: var(--muted); font-size: 0.92rem; }
.login-card label { display: block; font-size: 0.8rem; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
.login-card input[type=password] {
  width: 100%; padding: 13px 14px; border: 1px solid var(--line); border-radius: 12px;
  background: #fff; margin-bottom: 16px;
}
.login-card input:focus { outline: 2px solid var(--teal); outline-offset: 1px; }
.btn {
  appearance: none; border: 0; border-radius: 12px; background: var(--teal); color: #fff;
  padding: 12px 16px; min-height: var(--tap); font-weight: 650; cursor: pointer; width: 100%;
}
.btn:hover { background: #09585b; }
.err { background: var(--err-bg); color: var(--err-ink); padding: 10px 12px; border-radius: 12px; margin: 0 0 14px; }

/* —— App chrome —— */
.app-body { height: 100dvh; overflow: hidden; }
.top {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; background: #0f3d3e; color: #fff;
  min-height: 56px;
}
.top h1 { margin: 0; font-size: 1.05rem; letter-spacing: -0.02em; flex: 1; }
.top .sub { color: #c9e4e4; font-size: 0.8rem; font-weight: 500; }
.top a, .top button.link { color: #fff; }
button.link, a.back {
  appearance: none; background: none; border: 0; color: inherit; cursor: pointer;
  min-height: var(--tap); min-width: var(--tap); display: inline-flex; align-items: center;
  justify-content: center; text-decoration: none; padding: 0 6px; font-weight: 650;
}
form.inline { margin: 0; }
.app { display: flex; flex-direction: column; height: calc(100dvh - 56px); }
.list-pane, .detail-pane { min-height: 0; background: transparent; }

/* Mobile: one pane at a time */
@media (max-width: 879px) {
  .app.has-selection .list-pane { display: none; }
  .app:not(.has-selection) .detail-pane { display: none; }
  .list-pane, .detail-pane { flex: 1; display: flex; flex-direction: column; }
  .desk-only { display: none !important; }
}

/* Desktop master-detail */
@media (min-width: 880px) {
  .app { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; }
  .list-pane { border-right: 1px solid var(--line); background: color-mix(in srgb, var(--paper) 80%, var(--bg)); }
  .phone-only { display: none !important; }
  .back { display: none !important; }
}

/* —— List —— */
.sticky-tools {
  position: sticky; top: 0; z-index: 2;
  background: color-mix(in srgb, var(--paper) 92%, var(--bg));
  backdrop-filter: blur(8px);
  padding: 12px 12px 8px;
  border-bottom: 1px solid var(--line);
}
.search { display: flex; gap: 8px; }
.search input {
  flex: 1; min-height: var(--tap); padding: 0 14px;
  border: 1px solid var(--line); border-radius: 12px; background: #fff;
}
.search button { width: auto; padding: 0 14px; min-width: 72px; }
.chips { display: flex; gap: 6px; overflow: auto; padding: 10px 0 4px; scrollbar-width: none; }
.chips::-webkit-scrollbar { display: none; }
.chips a {
  flex: none; min-height: 34px; padding: 6px 12px; border-radius: 999px;
  background: #fff; border: 1px solid var(--line); color: var(--ink);
  text-decoration: none; font-size: 0.86rem; display: inline-flex; align-items: center;
}
.chips a.on { background: var(--teal-ink); color: #fff; border-color: var(--teal-ink); }
.user-list { overflow: auto; flex: 1; padding: 8px; }
.user {
  display: block; text-decoration: none; color: inherit;
  background: var(--paper); border: 1px solid transparent;
  border-radius: 14px; padding: 12px 12px 11px; margin: 0 0 6px;
}
.user:hover { border-color: var(--line); }
.user.on { background: var(--teal-soft); border-color: #b7d9d9; }
.user .row { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.user .name { font-weight: 700; letter-spacing: -0.02em; }
.user .phone { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.92rem; margin-top: 2px; }
.muted { color: var(--muted); font-size: 0.82rem; }
.pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
.pill {
  font-size: 0.72rem; font-weight: 700; letter-spacing: .02em;
  padding: 3px 8px; border-radius: 999px; background: #eee; color: #444;
}
.pill.building { background: #eee6d6; color: #5b4a2a; }
.pill.approved { background: #dce9fb; color: var(--ok); }
.pill.tried { background: #fde7c7; color: var(--warn); }
.pill.lead { background: #d9f0dc; color: var(--lead); }
.empty {
  margin: 28px 16px; text-align: center; color: var(--muted);
  background: var(--paper); border: 1px dashed var(--line); border-radius: var(--radius);
  padding: 28px 16px;
}
.empty strong { display: block; color: var(--ink); margin-bottom: 6px; }

/* —— Detail —— */
.detail-pane { display: flex; flex-direction: column; min-width: 0; }
.detail-head {
  padding: 12px 16px 10px; background: var(--paper);
  border-bottom: 1px solid var(--line);
}
.detail-head .who { display: flex; align-items: flex-start; gap: 10px; }
.detail-head h2 { margin: 0; font-size: 1.15rem; letter-spacing: -0.03em; }
.detail-main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
@media (min-width: 1200px) {
  .detail-main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; }
  .facts-col { border-left: 1px solid var(--line); overflow: auto; background: var(--sand); }
  .thread-col { min-height: 0; }
}
.facts-col { padding: 12px; overflow: auto; }
.section {
  background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
  padding: 12px 14px; margin: 0 0 10px;
}
.section h3 { margin: 0 0 8px; font-size: 0.78rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
pre.sum { white-space: pre-wrap; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
dl { margin: 0; }
dt { font-size: 0.75rem; color: var(--muted); margin-top: 8px; }
dd { margin: 2px 0 0; }
.thread-col { flex: 1; min-height: 0; display: flex; flex-direction: column; background:
  linear-gradient(180deg, rgba(11,107,110,.04), transparent 80px),
  var(--bg-2); }
.thread {
  flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 16px 14px 24px;
}
.msg {
  max-width: min(78%, 560px); padding: 9px 12px 8px; border-radius: 14px;
  box-shadow: 0 1px 0 rgba(27,31,30,.04);
}
.msg.in { align-self: flex-start; background: var(--in); border-top-left-radius: 5px; }
.msg.out { align-self: flex-end; background: var(--out); border-top-right-radius: 5px; }
.msg .body { white-space: pre-wrap; word-break: break-word; }
.msg .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 6px; color: var(--muted); font-size: 0.72rem; }
.msg .mode {
  text-transform: uppercase; letter-spacing: .04em; font-weight: 700;
  background: rgba(27,31,30,.06); padding: 1px 6px; border-radius: 999px;
}
.pick {
  flex: 1; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 32px 20px;
}
.pick h2 { margin: 0 0 8px; color: var(--ink); font-size: 1.25rem; letter-spacing: -0.03em; }
.progress {
  display: none; position: fixed; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent, #7fd4d6, transparent);
}
.navigating .progress { display: block; animation: slide 0.9s linear infinite; }
@keyframes slide { from { transform: translateX(-40%); } to { transform: translateX(40%); } }
.note { margin: 0 14px 8px; }
`;
}

function layout({ title, body, extraHead = '', app = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<style>${css()}</style>
${extraHead}
</head>
<body class="${app ? 'app-body' : ''}">
<div class="progress" aria-hidden="true"></div>
${body}
</body>
</html>`;
}

function pills(user, { count = false } = {}) {
  return `<div class="pills">
  <span class="pill ${esc(user.stage)}">${esc(stageLabel(user.stage))}</span>
  ${user.isLead ? '<span class="pill lead">Lead</span>' : ''}
  ${count ? `<span class="muted">${user.messageCount} message${user.messageCount === 1 ? '' : 's'}</span>` : ''}
</div>`;
}

function userHref(senderId, q, stage) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (stage) params.set('stage', stage);
  const qs = params.toString();
  return `/admin/users/${encodeURIComponent(senderId)}${qs ? `?${qs}` : ''}`;
}

function listHref(q, stage) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (stage) params.set('stage', stage);
  const qs = params.toString();
  return `/admin${qs ? `?${qs}` : ''}`;
}

function tools({ q = '', stage = '', action = '/admin' }) {
  const chips = [
    ['', 'All'],
    ['building', 'Building'],
    ['approved', 'Approved'],
    ['tried', 'Tried'],
    ['lead', 'Leads'],
  ];
  return `<div class="sticky-tools">
  <form class="search" method="get" action="${esc(action)}">
    <input type="search" name="q" value="${esc(q)}" placeholder="Search phone or name" aria-label="Search" autocomplete="off">
    ${stage ? `<input type="hidden" name="stage" value="${esc(stage)}">` : ''}
    <button class="btn" type="submit">Search</button>
  </form>
  <div class="chips">
    ${chips
      .map(([id, label]) => {
        let href;
        if (action === '/admin') href = listHref(q, id);
        else {
          const params = new URLSearchParams();
          if (id) params.set('stage', id);
          if (q) params.set('q', q);
          const qs = params.toString();
          href = qs ? `${action}?${qs}` : action;
        }
        return `<a class="${id === stage ? 'on' : ''}" href="${esc(href)}">${esc(label)}</a>`;
      })
      .join('')}
  </div>
</div>`;
}

function formatAnswer(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value == null) return '';
  return String(value);
}

function leadBlock(user) {
  if (!user?.lead) return '<p class="muted">No questionnaire yet.</p>';
  return `<dl>${Object.entries(user.lead.answers || {})
    .map(
      ([k, v]) =>
        `<dt>${esc(LEAD_ANSWER_LABELS[k] || k)}</dt><dd>${esc(formatAnswer(v))}</dd>`
    )
    .join('')}
    ${user.lead.createdAt ? `<dt>Submitted</dt><dd>${esc(formatStamp(user.lead.createdAt))}</dd>` : ''}
  </dl>`;
}

function threadHtml(user) {
  const msgs = (user.messages || [])
    .map((m) => {
      const side = m.direction === 'outbound' ? 'out' : 'in';
      const who = m.direction === 'outbound' ? 'easyBot' : 'Owner';
      return `<div class="msg ${side}">
  <div class="body">${esc(m.body)}</div>
  <div class="meta"><span class="mode">${esc(m.mode)}</span><span>${esc(who)}</span><span>${esc(formatStamp(m.createdAt))}</span></div>
</div>`;
    })
    .join('');
  return `${user.truncated ? '<p class="muted note">Showing the latest 2000 messages.</p>' : ''}
<div class="thread" id="thread">${msgs || '<div class="empty"><strong>No messages yet</strong>This sender has no logged WhatsApp turns.</div>'}</div>`;
}

function listCards({ users, selectedId, q, stage, truncated }) {
  if (!users.length) {
    return `<div class="empty"><strong>No matching users</strong>WhatsApp owners will appear here after they message the Sandbox.</div>`;
  }
  const cards = users
    .map((u) => {
      const on = u.senderId === selectedId ? ' on' : '';
      return `<a class="user${on}" href="${esc(userHref(u.senderId, q, stage))}" data-name="${esc((u.businessName || '').toLowerCase())}" data-phone="${esc((u.phoneE164 || '').toLowerCase())}">
  <div class="row"><span class="name">${esc(u.businessName || 'Unnamed')}</span><span class="muted">${esc(relativeTime(u.lastMessageAt || u.firstSeenAt))}</span></div>
  <div class="phone">${esc(u.phoneE164 || '—')}</div>
  ${pills(u, { count: true })}
</a>`;
    })
    .join('');
  return `${truncated ? '<p class="muted note">Showing the 200 most recently active.</p>' : ''}${cards}`;
}

function detailPane(selected) {
  if (!selected) {
    return `<div class="pick desk-only">
  <div>
    ${MARK}
    <h2>Select a conversation</h2>
    <p>The full WhatsApp thread, profile, and lead answers open here.</p>
  </div>
</div>`;
  }
  const title = selected.businessName || selected.phoneE164 || 'User';
  return `<div class="detail-head">
  <div class="who">
    <a class="back phone-only" href="/admin" aria-label="Back to users">←</a>
    <div>
      <h2>${esc(title)}</h2>
      <div class="phone">${esc(selected.phoneE164 || '—')}</div>
      ${pills(selected, { count: true })}
      <p class="muted" style="margin:8px 0 0">First seen ${esc(relativeTime(selected.firstSeenAt))}</p>
    </div>
  </div>
</div>
<div class="detail-main">
  <div class="thread-col">${threadHtml(selected)}</div>
  <aside class="facts-col">
    <div class="section"><h3>Profile</h3><pre class="sum">${esc(selected.summary || '')}</pre></div>
    <div class="section"><h3>Lead</h3>${leadBlock(selected)}</div>
  </aside>
</div>`;
}

const APP_JS = `<script>
(function(){
  document.addEventListener('click', function(e){
    var a = e.target.closest('a.user, a.back, .chips a');
    if (a) document.body.classList.add('navigating');
  });
  var thread = document.getElementById('thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
  var box = document.querySelector('.search input[name=q]');
  if (box) {
    box.addEventListener('input', function(){
      var q = box.value.trim().toLowerCase();
      document.querySelectorAll('.user').forEach(function(el){
        var hay = (el.getAttribute('data-name')||'') + ' ' + (el.getAttribute('data-phone')||'');
        el.style.display = !q || hay.indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }
})();
</script>`;

export function renderLogin({ error } = {}) {
  return layout({
    title: 'easyBot admin',
    body: `<main class="login-page">
  <div class="login-card">
    <div class="login-brand">${MARK}<div><h1>easyBot admin</h1><p>Private owner dashboard</p></div></div>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="post" action="/admin/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button class="btn" type="submit">Sign in</button>
    </form>
  </div>
</main>`,
  });
}

export function renderApp({
  users = [],
  selected = null,
  q = '',
  stage = '',
  truncated = false,
} = {}) {
  const selectedId = selected?.senderId || '';
  const filterAction = selected
    ? `/admin/users/${encodeURIComponent(selected.senderId)}`
    : '/admin';
  const title = selected
    ? `${selected.businessName || selected.phoneE164 || 'User'} · admin`
    : 'easyBot admin';
  return layout({
    title,
    app: true,
    extraHead: APP_JS,
    body: `<header class="top">
  ${MARK}
  <div style="flex:1">
    <h1>easyBot</h1>
    <div class="sub desk-only">WhatsApp owners and leads</div>
  </div>
  <form class="inline" method="post" action="/admin/logout"><button class="link" type="submit">Log out</button></form>
</header>
<div class="app${selected ? ' has-selection' : ''}">
  <section class="list-pane">
    ${tools({ q, stage, action: filterAction })}
    <div class="user-list">${listCards({ users, selectedId, q, stage, truncated })}</div>
  </section>
  <section class="detail-pane">${detailPane(selected)}</section>
</div>`,
  });
}

export function renderUserList(opts) {
  return renderApp({ ...opts, selected: null });
}

export function renderUserDetail(user, opts = {}) {
  return renderApp({
    users: opts.users || (user ? [user] : []),
    selected: user,
    q: opts.q || '',
    stage: opts.stage || '',
    truncated: opts.truncated || false,
  });
}

export function renderSimple(statusText, { error = false } = {}) {
  return layout({
    title: 'easyBot admin',
    body: `<main class="login-page"><div class="login-card">${
      error ? `<div class="err">${esc(statusText)}</div>` : `<p>${esc(statusText)}</p>`
    }<p><a href="/admin">Back to admin</a></p></div></main>`,
  });
}
