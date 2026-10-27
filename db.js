// Database layer — uses Node's built-in node:sqlite (no native deps).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'hitbreaker.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  paypal_email TEXT,
  cashtag TEXT,
  payout_method TEXT DEFAULT 'paypal' CHECK (payout_method IN ('paypal','cashapp')),
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entry_fee_cents INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','closed','paid')),
  pot_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tournament_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  paypal_order_id TEXT NOT NULL,
  paid_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tournament_id INTEGER REFERENCES tournaments(id),
  score INTEGER NOT NULL,
  perfect INTEGER DEFAULT 0,
  good INTEGER DEFAULT 0,
  miss INTEGER DEFAULT 0,
  max_combo INTEGER DEFAULT 0,
  accuracy REAL DEFAULT 0,
  level_reached INTEGER DEFAULT 1,
  stars INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  submitted_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tournament_id INTEGER REFERENCES tournaments(id),
  created_at TEXT DEFAULT (datetime('now')),
  used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('paypal','cashapp')),
  destination TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','paid','failed','pending_manual','pending_info')),
  paypal_batch_id TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS ad_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ad_type TEXT DEFAULT 'rewarded' CHECK (ad_type IN ('rewarded','banner','interstitial')),
  earnings_cents INTEGER NOT NULL DEFAULT 2,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS free_plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ad_view_id INTEGER REFERENCES ad_views(id),
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---- Users ----
const getUserByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const getUserByUsername = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username);

function createUser({ username, email, password_hash, is_admin }) {
  const r = db.prepare(
    'INSERT INTO users (username, email, password_hash, is_admin) VALUES (?,?,?,?)'
  ).run(username, email, password_hash, is_admin ? 1 : 0);
  return getUserById(r.lastInsertRowid);
}

function updateUserProfile(id, { paypal_email, cashtag, payout_method }) {
  db.prepare(
    'UPDATE users SET paypal_email = ?, cashtag = ?, payout_method = ? WHERE id = ?'
  ).run(paypal_email || null, cashtag || null, payout_method, id);
  return getUserById(id);
}

// ---- Tournaments ----
function createTournament({ name, entry_fee_cents, starts_at, ends_at }) {
  const r = db.prepare(
    'INSERT INTO tournaments (name, entry_fee_cents, starts_at, ends_at) VALUES (?,?,?,?)'
  ).run(name, entry_fee_cents, starts_at, ends_at);
  return db.prepare('SELECT * FROM tournaments WHERE id = ?').get(r.lastInsertRowid);
}

const getTournament = (id) => db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);

function listOpenTournaments() {
  return db.prepare(`
    SELECT t.*, COUNT(e.id) AS entries,
           (COUNT(e.id) * t.entry_fee_cents * 0.8) AS pot_preview_cents
    FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
    WHERE t.status = 'open' AND datetime('now') BETWEEN t.starts_at AND t.ends_at
    GROUP BY t.id ORDER BY t.entry_fee_cents
  `).all();
}

function listAllTournaments() {
  return db.prepare(`
    SELECT t.*, COUNT(e.id) AS entries
    FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
    GROUP BY t.id ORDER BY t.id DESC
  `).all();
}

function hasEntry(tournament_id, user_id) {
  return !!db.prepare(
    'SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ?'
  ).get(tournament_id, user_id);
}

function addEntry(tournament_id, user_id, paypal_order_id) {
  db.prepare(
    'INSERT INTO tournament_entries (tournament_id, user_id, paypal_order_id) VALUES (?,?,?)'
  ).run(tournament_id, user_id, paypal_order_id);
  db.prepare('UPDATE tournaments SET pot_cents = pot_cents + CAST(entry_fee_cents * 0.8 AS INTEGER) WHERE id = ?')
    .run(tournament_id);
}

function setTournamentStatus(id, status) {
  db.prepare('UPDATE tournaments SET status = ? WHERE id = ?').run(status, id);
}

// ---- Game tokens (anti-cheat) ----
function issueToken(user_id, tournament_id) {
  const crypto = require('crypto');
  const token = crypto.randomUUID();
  db.prepare('INSERT INTO game_tokens (token, user_id, tournament_id) VALUES (?,?,?)')
    .run(token, user_id, tournament_id || null);
  return token;
}

function consumeToken(token, user_id) {
  const row = db.prepare('SELECT * FROM game_tokens WHERE token = ? AND user_id = ? AND used = 0').get(token, user_id);
  if (!row) return null;
  // Expire after 30 minutes
  const ageMin = (Date.now() - new Date(row.created_at + 'Z').getTime()) / 60000;
  if (ageMin > 30) return null;
  db.prepare('UPDATE game_tokens SET used = 1 WHERE token = ?').run(token);
  return row;
}

// ---- Scores ----
function saveScore(s) {
  const r = db.prepare(`
    INSERT INTO scores (user_id, tournament_id, score, perfect, good, miss, max_combo, accuracy, level_reached, stars, duration_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(s.user_id, s.tournament_id || null, s.score, s.perfect, s.good, s.miss,
          s.max_combo, s.accuracy, s.level_reached, s.stars, s.duration_ms);
  return r.lastInsertRowid;
}

function leaderboard(since) {
  const where = since ? `WHERE s.submitted_at >= datetime('now', '${since}')` : '';
  return db.prepare(`
    SELECT u.username, MAX(s.score) AS best_score, MAX(s.accuracy) AS best_accuracy,
           MAX(s.level_reached) AS level_reached, MAX(s.submitted_at) AS played_at,
           COUNT(s.id) AS games
    FROM scores s JOIN users u ON u.id = s.user_id
    ${where}
    GROUP BY s.user_id ORDER BY best_score DESC LIMIT 50
  `).all();
}

function tournamentStandings(tournament_id) {
  return db.prepare(`
    SELECT u.id AS user_id, u.username, MAX(s.score) AS best_score
    FROM scores s JOIN users u ON u.id = s.user_id
    WHERE s.tournament_id = ?
    GROUP BY s.user_id ORDER BY best_score DESC
  `).all(tournament_id);
}

function userStats(user_id) {
  return db.prepare(`
    SELECT COUNT(*) AS games, COALESCE(MAX(score),0) AS best_score,
           COALESCE(AVG(accuracy),0) AS avg_accuracy, COALESCE(SUM(stars),0) AS stars,
           COALESCE((SELECT SUM(amount_cents) FROM payouts WHERE user_id = ? AND status IN ('sent','paid')),0) AS total_won_cents
    FROM scores WHERE user_id = ?
  `).get(user_id, user_id);
}

function userPayouts(user_id) {
  return db.prepare(`
    SELECT p.*, t.name AS tournament_name FROM payouts p
    JOIN tournaments t ON t.id = p.tournament_id
    WHERE p.user_id = ? ORDER BY p.id DESC
  `).all(user_id);
}

// ---- Payouts ----
function createPayout({ tournament_id, user_id, amount_cents, method, destination, status, note }) {
  const r = db.prepare(`
    INSERT INTO payouts (tournament_id, user_id, amount_cents, method, destination, status, note)
    VALUES (?,?,?,?,?,?,?)
  `).run(tournament_id, user_id, amount_cents, method, destination || null, status, note || null);
  return r.lastInsertRowid;
}

function listPayouts(status) {
  const where = status ? 'WHERE p.status = ?' : '';
  const args = status ? [status] : [];
  return db.prepare(`
    SELECT p.*, u.username, u.paypal_email, u.cashtag, t.name AS tournament_name
    FROM payouts p JOIN users u ON u.id = p.user_id LEFT JOIN tournaments t ON t.id = p.tournament_id
    ${where} ORDER BY p.id DESC
  `).all(...args);
}

function markPayoutPaid(id, paypal_batch_id) {
  if (paypal_batch_id) {
    db.prepare(`UPDATE payouts SET status='sent', paypal_batch_id=?, paid_at=datetime('now') WHERE id=?`).run(paypal_batch_id, id);
  } else {
    db.prepare(`UPDATE payouts SET status='paid', paid_at=datetime('now') WHERE id=?`).run(id);
  }
}

function markPayoutFailed(id, note) {
  db.prepare(`UPDATE payouts SET status='failed', note=? WHERE id=?`).run(note, id);
}

function listUsers() {
  return db.prepare('SELECT id, username, email, payout_method, paypal_email, cashtag, is_admin, created_at FROM users ORDER BY id').all();
}

// ---- Free play / ads ----
function recordAdView(userId, adType) {
  const earnings = 2; // $0.02 per ad view
  const r = db.prepare('INSERT INTO ad_views (user_id, ad_type, earnings_cents) VALUES (?,?,?)').run(userId, adType || 'rewarded', earnings);
  return { id: Number(r.lastInsertRowid), earnings_cents: earnings };
}
function recordFreePlay(userId, adViewId) {
  db.prepare('INSERT INTO free_plays (user_id, ad_view_id) VALUES (?,?)').run(userId, adViewId);
}
function getAdEarnings(userId) {
  const row = db.prepare(`SELECT COALESCE(SUM(earnings_cents),0) AS total_cents, COUNT(*) AS views FROM ad_views WHERE user_id = ?`).get(userId);
  const paid = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS paid_cents FROM payouts WHERE user_id = ? AND note LIKE 'ad-%' AND status IN ('pending','sent','paid','pending_manual')`).get(userId);
  return { total_cents: row.total_cents, views: row.views, paid_cents: paid.paid_cents, balance_cents: row.total_cents - paid.paid_cents };
}
function getAdLeaderboard(limit) {
  return db.prepare(`
    SELECT u.username, COUNT(a.id) AS views, COALESCE(SUM(a.earnings_cents),0) AS earnings_cents,
           COALESCE(MAX(s.score),0) AS best_score
    FROM users u
    JOIN ad_views a ON a.user_id = u.id
    LEFT JOIN scores s ON s.user_id = u.id AND s.tournament_id IS NULL
    GROUP BY u.id ORDER BY earnings_cents DESC LIMIT ?
  `).all(limit || 50);
}

module.exports = {
  db, getUserByEmail, getUserById, getUserByUsername, createUser, updateUserProfile,
  createTournament, getTournament, listOpenTournaments, listAllTournaments,
  hasEntry, addEntry, setTournamentStatus,
  issueToken, consumeToken, saveScore, leaderboard, tournamentStandings,
  userStats, userPayouts, createPayout, listPayouts, markPayoutPaid, markPayoutFailed, listUsers,
  recordAdView, recordFreePlay, getAdEarnings, getAdLeaderboard,
};
