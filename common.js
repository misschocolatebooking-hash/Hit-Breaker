// Shared frontend helpers: auth state, nav, API wrapper.
async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let currentUser = null;

async function refreshAuth() {
  try {
    const { user } = await api('/api/auth/me');
    currentUser = user;
  } catch { currentUser = null; }
  renderNav();
  return currentUser;
}

function renderNav() {
  const el = document.getElementById('navLinks');
  if (!el) return;
  let html = `<a href="/">Play</a><a href="/tournaments.html">Tournaments</a><a href="/leaderboard.html">Leaderboard</a>`;
  if (currentUser) {
    html += `<a href="/profile.html">${esc(currentUser.username)}</a>`;
    if (currentUser.is_admin) html += `<a href="/admin.html">Admin</a>`;
    html += `<button id="logoutBtn">Logout</button>`;
  } else {
    html += `<a href="/login.html">Login</a><a href="/signup.html">Sign Up</a>`;
  }
  el.innerHTML = html;
  const lb = document.getElementById('logoutBtn');
  if (lb) lb.onclick = async () => { await api('/api/auth/logout', 'POST'); location.href = '/'; };
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(cents) { return '$' + (cents / 100).toFixed(2); }
function showAlert(id, msg, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'alert ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
  el.classList.remove('hidden');
}
