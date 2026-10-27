// Hit Breaker server — Express + node:sqlite + PayPal (Orders + Payouts).
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const paypal = require('./paypal');
const { hashPassword, verifyPassword, requireLogin, requireAdmin } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'hit-breaker-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true },
}));

// ---------- helpers ----------
const publicUser = (u) => u && ({
  id: u.id, username: u.username, email: u.email,
  paypal_email: u.paypal_email, cashtag: u.cashtag,
  payout_method: u.payout_method, is_admin: !!u.is_admin,
});

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
const fmtDT = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

const TIERS = [
  { name: 'Hit Breaker Daily — $1 Entry', entry_fee_cents: 100 },
  { name: 'Hit Breaker Daily — $5 Entry', entry_fee_cents: 500 },
  { name: 'Hit Breaker Daily — $10 Entry', entry_fee_cents: 1000 },
];

function ensureDailyTournaments() {
  for (const t of TIERS) {
    const existing = db.db.prepare(
      `SELECT 1 FROM tournaments WHERE entry_fee_cents = ? AND status = 'open'
       AND date(ends_at) = date('now', 'localtime')`
    ).get(t.entry_fee_cents);
    if (!existing) {
      db.createTournament({
        name: t.name, entry_fee_cents: t.entry_fee_cents,
        starts_at: fmtDT(new Date()), ends_at: fmtDT(endOfToday()),
      });
      console.log(`Created tournament: ${t.name}`);
    }
  }
}

// ---------- tournament close + payouts ----------
async function closeTournament(tournamentId) {
  const t = db.getTournament(tournamentId);
  if (!t || t.status !== 'open') return { error: 'Tournament not open' };

  const standings = db.tournamentStandings(tournamentId).slice(0, 3);
  const pot = t.pot_cents;
  const results = [];

  if (standings.length > 0 && pot > 0) {
    const weights = [50, 30, 20].slice(0, standings.length);
    const totalW = weights.reduce((a, b) => a + b, 0);
    let distributed = 0;
    const paypalItems = [];

    standings.forEach((s, i) => {
      let cents = Math.floor(pot * weights[i] / totalW);
      if (i === standings.length - 1) cents = pot - distributed; // remainder to last
      distributed += cents;
      const user = db.getUserById(s.user_id);
      const method = user.payout_method === 'cashapp' ? 'cashapp' : 'paypal';

      if (method === 'paypal' && user.paypal_email) {
        const pid = db.createPayout({
          tournament_id: t.id, user_id: user.id, amount_cents: cents,
          method: 'paypal', destination: user.paypal_email, status: 'pending',
          note: `1st/2nd/3rd place — ${t.name}`,
        });
        paypalItems.push({ payoutId: pid, email: user.paypal_email, cents, note: `Hit Breaker winnings — ${t.name}` });
        results.push({ user: user.username, cents, method: 'paypal', status: 'pending' });
      } else if (method === 'cashapp' && user.cashtag) {
        db.createPayout({
          tournament_id: t.id, user_id: user.id, amount_cents: cents,
          method: 'cashapp', destination: user.cashtag, status: 'pending_manual',
          note: 'Manual Cash App payout — admin sends via Cash App',
        });
        results.push({ user: user.username, cents, method: 'cashapp', status: 'pending_manual' });
      } else {
        db.createPayout({
          tournament_id: t.id, user_id: user.id, amount_cents: cents,
          method, destination: null, status: 'pending_info',
          note: 'Winner has no payout destination set — update profile',
        });
        results.push({ user: user.username, cents, method, status: 'pending_info' });
      }
    });

    // Send PayPal payouts in one batch
    if (paypalItems.length > 0) {
      try {
        const batch = await paypal.sendPayoutBatch(paypalItems);
        for (const it of paypalItems) db.markPayoutPaid(it.payoutId, batch.payout_batch_id);
        console.log(`PayPal batch ${batch.payout_batch_id} sent for tournament ${t.id}`);
      } catch (e) {
        console.error('PayPal payout failed:', e.message);
        for (const it of paypalItems) db.markPayoutFailed(it.payoutId, e.message);
      }
    }
  }

  db.setTournamentStatus(t.id, 'paid');
  return { ok: true, pot_cents: pot, winners: results };
}

// Auto-close loop: every minute, close expired open tournaments.
setInterval(async () => {
  const expired = db.db.prepare(
    `SELECT id FROM tournaments WHERE status = 'open' AND ends_at < datetime('now', 'localtime')`
  ).all();
  for (const { id } of expired) {
    console.log(`Auto-closing tournament ${id}`);
    try { await closeTournament(id); } catch (e) { console.error(e.message); }
  }
  ensureDailyTournaments();
}, 60 * 1000);

// ---------- public API ----------
app.get('/api/config', (req, res) => {
  res.json({ paypalClientId: process.env.PAYPAL_CLIENT_ID || '', paypalMode: paypal.mode() });
});

// ---- auth ----
app.post('/api/auth/signup', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  if (db.getUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
  if (db.getUserByUsername(username)) return res.status(400).json({ error: 'Username taken' });
  const is_admin = !!(process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase());
  const user = db.createUser({ username, email, password_hash: hashPassword(password), is_admin });
  req.session.userId = user.id;
  req.session.isAdmin = !!user.is_admin;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId = user.id;
  req.session.isAdmin = !!user.is_admin;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: publicUser(db.getUserById(req.session.userId)) });
});

app.put('/api/auth/profile', requireLogin, (req, res) => {
  const { paypal_email, cashtag, payout_method } = req.body || {};
  if (!['paypal', 'cashapp'].includes(payout_method))
    return res.status(400).json({ error: 'payout_method must be paypal or cashapp' });
  const user = db.updateUserProfile(req.session.userId, { paypal_email, cashtag, payout_method });
  res.json({ user: publicUser(user) });
});

// ---- tournaments ----
app.get('/api/tournaments', (req, res) => {
  const list = db.listOpenTournaments().map((t) => ({
    ...t,
    entered: req.session.userId ? db.hasEntry(t.id, req.session.userId) : false,
  }));
  res.json(list);
});

app.post('/api/tournaments/:id/create-order', requireLogin, async (req, res) => {
  try {
    const t = db.getTournament(req.params.id);
    if (!t || t.status !== 'open') return res.status(400).json({ error: 'Tournament not open' });
    if (db.hasEntry(t.id, req.session.userId)) return res.status(400).json({ error: 'Already entered' });
    if (!paypal.isConfigured()) return res.status(500).json({ error: 'PayPal not configured' });
    const order = await paypal.createOrder(t.entry_fee_cents, `Hit Breaker entry — ${t.name}`);
    res.json({ orderId: order.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tournaments/:id/capture-order', requireLogin, async (req, res) => {
  try {
    const t = db.getTournament(req.params.id);
    if (!t || t.status !== 'open') return res.status(400).json({ error: 'Tournament not open' });
    if (db.hasEntry(t.id, req.session.userId)) return res.status(400).json({ error: 'Already entered' });
    const captured = await paypal.captureOrder(req.body.orderId);
    if (captured !== t.entry_fee_cents)
      return res.status(400).json({ error: `Payment amount mismatch (got ${captured}, expected ${t.entry_fee_cents})` });
    db.addEntry(t.id, req.session.userId, req.body.orderId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- game ----
app.post('/api/game/start', requireLogin, (req, res) => {
  const { tournamentId } = req.body || {};
  if (tournamentId) {
    const t = db.getTournament(tournamentId);
    if (!t || t.status !== 'open') return res.status(400).json({ error: 'Tournament not open' });
    if (!db.hasEntry(tournamentId, req.session.userId))
      return res.status(403).json({ error: 'Entry fee required for this tournament' });
  }
  const token = db.issueToken(req.session.userId, tournamentId || null);
  res.json({ token });
});

// Anti-cheat: max 3x combo multiplier, sane caps.
const MAX_NOTES = 400;
const MAX_MULT = 3;

app.post('/api/scores', requireLogin, (req, res) => {
  const b = req.body || {};
  const tok = db.consumeToken(b.token, req.session.userId);
  if (!tok) return res.status(400).json({ error: 'Invalid or expired game token' });

  const perfect = b.perfect | 0, good = b.good | 0, miss = b.miss | 0;
  const total = perfect + good + miss;
  const score = b.score | 0;
  const accuracy = Number(b.accuracy) || 0;

  if (total <= 0 || total > MAX_NOTES) return res.status(400).json({ error: 'Impossible note count' });
  if (score < 0 || score > total * 100 * MAX_MULT) return res.status(400).json({ error: 'Impossible score' });
  const expectedAcc = (perfect * 100 + good * 50) / (total * 100) * 100;
  if (Math.abs(expectedAcc - accuracy) > 2) return res.status(400).json({ error: 'Accuracy mismatch' });
  if (accuracy < 0 || accuracy > 100) return res.status(400).json({ error: 'Bad accuracy' });
  const durationMs = b.durationMs | 0;
  if (durationMs < total * 200) return res.status(400).json({ error: 'Impossibly fast play' });

  const id = db.saveScore({
    user_id: req.session.userId, tournament_id: tok.tournament_id, score,
    perfect, good, miss, max_combo: b.maxCombo | 0, accuracy,
    level_reached: Math.min(3, Math.max(1, b.levelReached | 0 || 1)),
    stars: Math.min(3, Math.max(0, b.stars | 0 || 0)), duration_ms: durationMs,
  });
  res.json({ ok: true, id });
});

// ---- leaderboards ----
app.get('/api/leaderboard', (req, res) => res.json(db.leaderboard(null)));
app.get('/api/leaderboard/daily', (req, res) => res.json(db.leaderboard('-1 day')));
app.get('/api/leaderboard/weekly', (req, res) => res.json(db.leaderboard('-7 days')));
app.get('/api/leaderboard/free', (req, res) => res.json(db.getAdLeaderboard(50)));

// ---- free play / ads ----
app.post('/api/ads/view', requireLogin, (req, res) => {
  const { adType } = req.body || {};
  const view = db.recordAdView(req.session.userId, adType);
  res.json(view);
});
app.post('/api/free/start', requireLogin, (req, res) => {
  const { adViewId } = req.body || {};
  if (!adViewId) return res.status(400).json({ error: 'Watch an ad first' });
  const view = db.db.prepare('SELECT * FROM ad_views WHERE id = ? AND user_id = ?').get(adViewId, req.session.userId);
  if (!view) return res.status(400).json({ error: 'Invalid ad view' });
  const used = db.db.prepare('SELECT 1 FROM free_plays WHERE ad_view_id = ?').get(adViewId);
  if (used) return res.status(400).json({ error: 'Ad already used' });
  db.recordFreePlay(req.session.userId, adViewId);
  const token = db.issueToken(req.session.userId, null);
  res.json({ token });
});
app.get('/api/ads/earnings', requireLogin, (req, res) => {
  res.json(db.getAdEarnings(req.session.userId));
});
const AD_CASHOUT_MIN_CENTS = 500; // $5.00 minimum cashout
app.post('/api/ads/cashout', requireLogin, async (req, res) => {
  try {
    const bal = db.getAdEarnings(req.session.userId);
    if (bal.balance_cents < AD_CASHOUT_MIN_CENTS) {
      return res.status(400).json({ error: `Minimum $${(AD_CASHOUT_MIN_CENTS / 100).toFixed(2)} to cash out (you have $${(bal.balance_cents / 100).toFixed(2)})` });
    }
    const user = db.getUserById(req.session.userId);
    const method = user.payout_method === 'cashapp' ? 'cashapp' : 'paypal';
    const destination = method === 'cashapp' ? user.cashtag : user.paypal_email;
    if (!destination) {
      return res.status(400).json({ error: method === 'cashapp'
        ? 'Add your Cash App tag in your profile first'
        : 'Add your PayPal email in your profile first' });
    }
    const amount = bal.balance_cents;
    const payoutId = db.createPayout({
      tournament_id: null, user_id: req.session.userId,
      amount_cents: amount, method, destination,
      status: 'pending', note: 'ad-cashout'
    });
    if (method === 'paypal') {
      try {
        const batch = await paypal.sendPayoutBatch([
          { payoutId, email: destination, cents: amount, note: 'Hit High Breaker ad earnings cashout' }
        ]);
        db.markPayoutPaid(payoutId, batch.payout_batch_id);
        return res.json({ ok: true, amount_cents: amount, method: 'paypal', status: 'sent' });
      } catch (e) {
        db.markPayoutFailed(payoutId, e.message);
        return res.status(502).json({ error: 'PayPal payout failed, nothing was charged: ' + e.message });
      }
    }
    db.db.prepare(`UPDATE payouts SET status = 'pending_manual' WHERE id = ?`).run(payoutId);
    return res.json({ ok: true, amount_cents: amount, method: 'cashapp', status: 'pending_manual' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---- profile ----
app.get('/api/profile', requireLogin, (req, res) => {
  res.json({ stats: db.userStats(req.session.userId), payouts: db.userPayouts(req.session.userId) });
});

// ---- admin ----
app.get('/api/admin/tournaments', requireLogin, requireAdmin, (req, res) => res.json(db.listAllTournaments()));
app.post('/api/admin/tournaments', requireLogin, requireAdmin, (req, res) => {
  const { name, entry_fee_cents, ends_at } = req.body || {};
  if (!name || !entry_fee_cents || !ends_at) return res.status(400).json({ error: 'Missing fields' });
  res.json(db.createTournament({ name, entry_fee_cents, starts_at: fmtDT(new Date()), ends_at }));
});
app.post('/api/admin/tournaments/:id/close', requireLogin, requireAdmin, async (req, res) => {
  res.json(await closeTournament(Number(req.params.id)));
});
app.get('/api/admin/payouts', requireLogin, requireAdmin, (req, res) => {
  res.json(db.listPayouts(req.query.status || null));
});
app.post('/api/admin/payouts/:id/mark-paid', requireLogin, requireAdmin, (req, res) => {
  db.markPayoutPaid(Number(req.params.id)); // manual (Cash App) payout confirmed
  res.json({ ok: true });
});
app.get('/api/admin/users', requireLogin, requireAdmin, (req, res) => res.json(db.listUsers()));
app.get('/api/admin/ad-earnings', requireLogin, requireAdmin, (req, res) => {
  const rows = db.getAdLeaderboard(100).map(r => ({ username: r.username, views: r.views, balance_cents: r.earnings_cents }));
  res.json(rows);
});

// ---------- frontend ----------
app.use(express.static(__dirname));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

ensureDailyTournaments();
app.listen(PORT, () => console.log(`Hit Breaker running on http://localhost:${PORT} (PayPal ${paypal.mode()})`));
