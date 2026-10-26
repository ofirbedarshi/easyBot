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

const MODE_LABELS = {
  opening: 'Opening',
  builder: 'Builder',
  test: 'Test',
  menu: 'Menu',
  lead: 'Lead',
  command: 'Command',
  limit: 'Limit',
  error: 'Error',
};

const AVATAR_TONES = [
  ['#d9eeee', '#0b4f51'],
  ['#eee6d4', '#5a4424'],
  ['#e3ebf6', '#2a4068'],
  ['#e6f0dc', '#2f4a22'],
  ['#f0e4e8', '#5a3340'],
];

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#0b5f61"/><path d="M8 11.2c0-1.2.9-2.2 2.1-2.2h11.8c1.2 0 2.1 1 2.1 2.2v8.1c0 1.2-.9 2.2-2.1 2.2h-6.3L11 24.2v-2.7H10.1C8.9 21.5 8 20.5 8 19.3v-8.1z" fill="#fff"/><circle cx="13" cy="15.2" r="1.15" fill="#0b5f61"/><circle cx="16.4" cy="15.2" r="1.15" fill="#0b5f61"/><circle cx="19.8" cy="15.2" r="1.15" fill="#0b5f61"/></svg>`;

const CHEVRON = `<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M12.2 4.4 6.6 10l5.6 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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

function formatDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yday = new Date(today);
  yday.setUTCDate(today.getUTCDate() - 1);
  const key = d.toISOString().slice(0, 10);
  if (key === today.toISOString().slice(0, 10)) return 'Today';
  if (key === yday.toISOString().slice(0, 10)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function modeLabel(mode) {
  if (!mode) return '—';
  return MODE_LABELS[mode] || String(mode);
}

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarTone(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function avatarHtml(name) {
  const [bg, fg] = avatarTone(name);
  return `<div class="avatar" style="background:${bg};color:${fg}" aria-hidden="true">${esc(initials(name))}</div>`;
}

function css() {
  return `
:root {
  --bg: #f3eee4;
  --bg-2: #e8e0d2;
  --paper: #fffcf6;
  --ink: #1a1f1d;
  --muted: #5f6965;
  --line: #e4dac8;
  --teal: #0b5f61;
  --teal-ink: #084446;
  --teal-soft: #d7ecec;
  --sand: #f6f1e6;
  --out: #d5ebe4;
  --in: #ffffff;
  --lead: #1a5a2a;
  --ok: #1d4f8a;
  --warn: #8a4a0c;
  --err-bg: #fdecea;
  --err-ink: #8a1f11;
  --shadow: 0 18px 50px rgba(26, 31, 29, 0.08);
  --radius: 20px;
  --tap: 44px;
  --display: Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, serif;
  --sans: "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
html { color-scheme: light; }
body {
  font: 16px/1.5 var(--sans);
  color: var(--ink);
  background:
    radial-gradient(820px 380px at 0% -10%, #d9ecec 0%, transparent 58%),
    radial-gradient(640px 320px at 110% 0%, #f5e6c8 0%, transparent 50%),
    var(--bg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--teal); }
button, input { font: inherit; }
.mark { width: 32px; height: 32px; display: block; flex: none; }
.chev { width: 20px; height: 20px; display: block; }

.login-page {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: max(28px, env(safe-area-inset-top)) 18px max(28px, env(safe-area-inset-bottom));
}
.login-card {
  width: min(100%, 408px);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 26px;
  box-shadow: var(--shadow);
  padding: 36px 28px 30px;
}
.login-brand { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
.login-brand h1 {
  margin: 0;
  font-family: var(--display);
  font-size: 1.7rem;
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.15;
}
.login-brand p { margin: 5px 0 0; color: var(--muted); font-size: 0.95rem; }
.login-card label {
  display: block; font-size: 0.74rem; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px;
}
.login-card input[type=password] {
  width: 100%; padding: 14px 15px; border: 1px solid var(--line); border-radius: 13px;
  background: #fff; margin-bottom: 16px; font-size: 16px;
}
.login-card input:focus, .search input:focus {
  outline: 2px solid var(--teal); outline-offset: 1px; border-color: transparent;
}
.btn {
  appearance: none; border: 0; border-radius: 13px; background: var(--teal); color: #fff;
  padding: 12px 16px; min-height: var(--tap); font-weight: 650; cursor: pointer; width: 100%;
}
.btn:hover { background: #08494b; }
.btn:active { transform: translateY(1px); }
.err { background: var(--err-bg); color: var(--err-ink); padding: 11px 13px; border-radius: 12px; margin: 0 0 16px; }

.app-body { height: 100dvh; overflow: hidden; display: flex; flex-direction: column; }
.top {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px 10px max(16px, env(safe-area-inset-left));
  padding-right: max(12px, env(safe-area-inset-right));
  background: #0d3536; color: #fff; min-height: 56px;
}
.top h1 {
  margin: 0;
  font-family: var(--display);
  font-size: 1.22rem;
  letter-spacing: -0.02em;
  font-weight: 500;
}
.top .sub { color: #c5dedd; font-size: 0.78rem; font-weight: 500; margin-top: 1px; }
button.link, a.back {
  appearance: none; background: none; border: 0; color: inherit; cursor: pointer;
  min-height: var(--tap); min-width: var(--tap); display: inline-flex; align-items: center;
  justify-content: center; text-decoration: none; padding: 0 10px; font-weight: 650; gap: 2px;
}
button.link { border-radius: 10px; color: #e7f4f4; }
button.link:hover { background: rgba(255,255,255,.08); }
a.back {
  justify-content: flex-start; min-width: auto; color: var(--teal-ink);
  padding: 0 10px 0 2px; gap: 2px; font-size: 0.98rem;
}
form.inline { margin: 0; }
.app { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.list-pane, .detail-pane { min-height: 0; }

.sticky-tools {
  position: sticky; top: 0; z-index: 2;
  background: color-mix(in srgb, var(--paper) 92%, var(--bg));
  backdrop-filter: blur(12px);
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--line);
}
.search { display: flex; gap: 8px; }
.search input {
  flex: 1; min-height: var(--tap); padding: 0 15px;
  border: 1px solid var(--line); border-radius: 999px; background: #fff; font-size: 16px;
}
.search button { width: auto; padding: 0 16px; min-width: 80px; border-radius: 999px; }
.chips { display: flex; gap: 7px; overflow: auto; padding: 11px 0 5px; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.chips::-webkit-scrollbar { display: none; }
.chips a {
  flex: none; min-height: 36px; padding: 6px 13px; border-radius: 999px;
  background: #fff; border: 1px solid var(--line); color: var(--ink);
  text-decoration: none; font-size: 0.86rem; display: inline-flex; align-items: center;
}
.chips a.on { background: var(--teal-ink); color: #fff; border-color: var(--teal-ink); }
.user-list { overflow: auto; flex: 1; padding: 10px 10px 22px; overscroll-behavior: contain; }
.user {
  display: grid; grid-template-columns: 46px 1fr; gap: 4px 12px; align-items: start;
  text-decoration: none; color: inherit;
  background: var(--paper); border: 1px solid transparent;
  border-radius: 16px; padding: 12px 12px 13px; margin: 0 0 6px;
}
.user:hover { border-color: var(--line); }
.user.on { background: var(--teal-soft); border-color: #bcdada; }
.user:active { background: #e7f3f3; }
.avatar {
  width: 46px; height: 46px; border-radius: 15px;
  display: grid; place-items: center;
  font-weight: 750; letter-spacing: -0.02em; font-size: 0.84rem;
}
.user .row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.user .name { font-weight: 700; letter-spacing: -0.02em; }
.user .phone { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.9rem; margin-top: 1px; }
.user .preview {
  color: var(--muted); font-size: 0.9rem; margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.user .seen { color: var(--muted); font-size: 0.76rem; margin-top: 4px; }
.muted { color: var(--muted); font-size: 0.82rem; }
.pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.pill {
  font-size: 0.7rem; font-weight: 750; letter-spacing: .03em;
  padding: 3px 8px; border-radius: 999px; background: #eeeae2; color: #4a4f4c;
}
.pill.building { background: #eee6d4; color: #5b4a2a; }
.pill.approved { background: #dce8f8; color: var(--ok); }
.pill.tried { background: #fde6c4; color: var(--warn); }
.pill.lead { background: #d7efda; color: var(--lead); }
.badge-lead {
  font-size: 0.7rem; font-weight: 750; letter-spacing: .04em;
  padding: 2px 8px; border-radius: 999px; border: 1px solid #96c89d;
  color: var(--lead); background: #fff;
}
.empty {
  margin: 32px 18px; text-align: center; color: var(--muted);
  background: var(--paper); border: 1px dashed var(--line); border-radius: var(--radius);
  padding: 32px 18px;
}
.empty .mark { margin: 0 auto 12px; }
.empty strong { display: block; color: var(--ink); margin-bottom: 6px; font-size: 1.05rem; }

.detail-pane { display: flex; flex-direction: column; min-width: 0; background: var(--bg-2); }
.detail-head {
  padding: 8px 16px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
.detail-head .back { margin: 0 0 2px -8px; }
.detail-head .who { display: flex; align-items: flex-start; gap: 12px; }
.detail-head h2 {
  margin: 0;
  font-family: var(--display);
  font-size: 1.28rem;
  font-weight: 500;
  letter-spacing: -0.03em;
}
.detail-head .phone { font-variant-numeric: tabular-nums; color: var(--muted); margin-top: 2px; }
.detail-main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.facts-acc {
  margin: 10px 12px 0; background: var(--paper); border: 1px solid var(--line);
  border-radius: 14px; padding: 0 4px;
}
.facts-acc > summary {
  min-height: 46px; display: flex; align-items: center; cursor: pointer;
  font-weight: 700; letter-spacing: -0.02em; padding: 0 12px; list-style: none;
}
.facts-acc > summary::-webkit-details-marker { display: none; }
.facts-acc[open] > summary { border-bottom: 1px solid var(--line); }
.facts-acc .section { border: 0; box-shadow: none; margin: 0; }
.facts-col { padding: 14px 12px 24px; overflow: auto; overscroll-behavior: contain; }
.section {
  background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
  padding: 13px 14px; margin: 0 0 10px;
}
.section h3 {
  margin: 0 0 8px; font-size: 0.72rem; letter-spacing: .07em;
  text-transform: uppercase; color: var(--muted); font-weight: 750;
}
pre.sum { white-space: pre-wrap; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; color: #2b3330; }
dl { margin: 0; }
dt { font-size: 0.74rem; color: var(--muted); margin-top: 9px; }
dd { margin: 2px 0 0; }
.thread-col {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  background:
    radial-gradient(rgba(11,95,97,.045) 1px, transparent 1px),
    linear-gradient(180deg, rgba(11,95,97,.04), transparent 88px),
    var(--bg-2);
  background-size: 18px 18px, auto, auto;
}
.thread {
  flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 9px;
  padding: 16px 14px calc(28px + env(safe-area-inset-bottom));
  overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
}
.day {
  align-self: center; margin: 6px 0 2px;
}
.day span {
  display: inline-block; padding: 3px 10px; border-radius: 999px;
  background: rgba(255,252,246,.82); color: var(--muted);
  font-size: 0.72rem; font-weight: 650; letter-spacing: .02em;
}
.msg {
  max-width: min(84%, 560px); padding: 10px 13px 8px; border-radius: 18px;
  box-shadow: 0 1px 0 rgba(26,31,29,.05);
}
.msg.in { align-self: flex-start; background: var(--in); border-top-left-radius: 5px; }
.msg.out { align-self: flex-end; background: var(--out); border-top-right-radius: 5px; }
.msg .body { white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
.msg .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 7px; color: var(--muted); font-size: 0.7rem; }
.msg .mode {
  text-transform: uppercase; letter-spacing: .04em; font-weight: 750;
  background: rgba(26,31,29,.06); padding: 1px 6px; border-radius: 999px;
}
.pick {
  flex: 1; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 40px 24px;
  background: var(--bg-2);
}
.pick h2 {
  margin: 14px 0 8px; color: var(--ink);
  font-family: var(--display); font-size: 1.55rem; font-weight: 500; letter-spacing: -0.03em;
}
.pick .mark { margin: 0 auto; width: 40px; height: 40px; }
.progress {
  display: none; position: fixed; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent, #8edcde, transparent);
}
.navigating .progress { display: block; animation: slide 0.9s linear infinite; }
@keyframes slide { from { transform: translateX(-40%); } to { transform: translateX(40%); } }
.note { margin: 8px 14px; }
@media (prefers-reduced-motion: reduce) {
  .navigating .progress, .btn:active { animation: none; transform: none; }
}
@media (max-width: 879px) {
  .app.has-selection .list-pane { display: none; }
  .app:not(.has-selection) .detail-pane { display: none; }
  .list-pane, .detail-pane { flex: 1; display: flex; flex-direction: column; }
  .desk-only { display: none !important; }
  .user-list { padding: 0 0 20px; }
  .user {
    margin: 0; border-radius: 0; padding: 14px 16px;
    border: 0; border-bottom: 1px solid var(--line); background: transparent;
  }
  .user:hover { border-color: var(--line); background: transparent; }
  .user.on { background: var(--teal-soft); border-color: var(--line); }
}
@media (min-width: 880px) {
  .app { display: grid; grid-template-columns: minmax(320px, 400px) 1fr; }
  .list-pane {
    border-right: 1px solid var(--line);
    background: color-mix(in srgb, var(--paper) 86%, var(--bg));
    display: flex; flex-direction: column;
  }
  .phone-only { display: none !important; }
}
@media (min-width: 1100px) {
  .detail-main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; }
  .facts-col { border-left: 1px solid var(--line); overflow: auto; background: var(--sand); }
  .facts-acc { display: none !important; }
}
@media (max-width: 1099px) {
  .facts-col { display: none !important; }
}
`;
}

function layout({ title, body, extraHead = '', app = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d3536">
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
  ${user.isLead ? '<span class="badge-lead">Lead</span>' : ''}
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

function factsHtml(user) {
  return `<div class="section"><h3>Profile</h3><pre class="sum">${esc(user.summary || '')}</pre></div>
    <div class="section"><h3>Lead</h3>${leadBlock(user)}</div>`;
}

function threadHtml(user) {
  const msgs = user.messages || [];
  if (!msgs.length) {
    return `<div class="thread" id="thread"><div class="empty">${MARK}<strong>No messages yet</strong>This sender has no logged WhatsApp turns.</div></div>`;
  }
  let lastDay = '';
  const parts = msgs.map((m) => {
    const side = m.direction === 'outbound' ? 'out' : 'in';
    const who = m.direction === 'outbound' ? 'easyBot' : 'Owner';
    const day = formatDay(m.createdAt);
    let sep = '';
    if (day && day !== lastDay) {
      lastDay = day;
      sep = `<div class="day"><span>${esc(day)}</span></div>`;
    }
    return `${sep}<div class="msg ${side}">
  <div class="body">${esc(m.body)}</div>
  <div class="meta"><span class="mode">${esc(modeLabel(m.mode))}</span><span>${esc(who)}</span><span>${esc(formatStamp(m.createdAt))}</span></div>
</div>`;
  });
  return `${user.truncated ? '<p class="muted note">Showing the latest 2000 messages.</p>' : ''}
<div class="thread" id="thread">${parts.join('')}</div>`;
}

function listCards({ users, selectedId, q, stage, truncated }) {
  if (!users.length) {
    return `<div class="empty">${MARK}<strong>No matching users</strong>WhatsApp owners will appear here after they message the Sandbox.</div>`;
  }
  const cards = users
    .map((u) => {
      const on = u.senderId === selectedId ? ' on' : '';
      const title = u.businessName || 'Unnamed';
      const preview = u.lastMessagePreview
        ? esc(u.lastMessagePreview)
        : 'No messages yet';
      const current = u.senderId === selectedId ? ' aria-current="page"' : '';
      return `<a class="user${on}" href="${esc(userHref(u.senderId, q, stage))}" data-name="${esc((u.businessName || '').toLowerCase())}" data-phone="${esc((u.phoneE164 || '').toLowerCase())}"${current}>
  ${avatarHtml(title)}
  <div>
    <div class="row"><span class="name">${esc(title)}</span><span class="muted">${esc(relativeTime(u.lastMessageAt || u.firstSeenAt))}</span></div>
    <div class="phone">${esc(u.phoneE164 || '—')}</div>
    <div class="preview">${preview}</div>
    <div class="seen">First seen ${esc(relativeTime(u.firstSeenAt))}</div>
    ${pills(u, { count: true })}
  </div>
</a>`;
    })
    .join('');
  return `${truncated ? '<p class="muted note">Showing the 200 most recently active.</p>' : ''}${cards}`;
}

function detailPane(selected, q = '', stage = '') {
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
  <a class="back phone-only" href="${esc(listHref(q, stage))}" aria-label="Back to users">${CHEVRON} Users</a>
  <div class="who">
    ${avatarHtml(title)}
    <div>
      <h2>${esc(title)}</h2>
      <div class="phone">${esc(selected.phoneE164 || '—')}</div>
      ${pills(selected, { count: true })}
      <p class="muted" style="margin:8px 0 0">First seen ${esc(relativeTime(selected.firstSeenAt))}</p>
    </div>
  </div>
</div>
<div class="detail-main">
  <details class="facts-acc">
    <summary>Profile and lead</summary>
    ${factsHtml(selected)}
  </details>
  <div class="thread-col">${threadHtml(selected)}</div>
  <aside class="facts-col">${factsHtml(selected)}</aside>
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
  <section class="detail-pane">${detailPane(selected, q, stage)}</section>
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
