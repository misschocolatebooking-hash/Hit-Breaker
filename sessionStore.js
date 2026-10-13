// SQLite-backed express-session store using node:sqlite (no native deps).
const session = require('express-session');
const { db } = require('./db');

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

function expiryOf(sess) {
  const exp = sess && sess.cookie && sess.cookie.expires;
  if (exp) {
    const t = new Date(exp).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return Date.now() + DEFAULT_TTL_MS;
}

class SqliteStore extends session.Store {
  constructor() {
    super();
    this.stmts = {
      get: db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
      set: db.prepare(
        'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };

    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  prune() {
    try { this.stmts.prune.run(Date.now()); } catch (e) { /* best effort */ }
  }

  // Run fn synchronously, then deliver the result to cb on a later tick so
  // errors thrown by cb are never mistaken for store errors.
  _run(fn, cb) {
    let err = null;
    let result;
    try { result = fn(); } catch (e) { err = e; }
    if (typeof cb !== 'function') return;
    setImmediate(() => (err ? cb(err) : cb(null, result)));
  }

  get(sid, cb) {
    this._run(() => {
      const row = this.stmts.get.get(sid);
      if (!row) return null;
      if (row.expires <= Date.now()) {
        this.stmts.destroy.run(sid);
        return null;
      }
      return JSON.parse(row.sess);
    }, cb);
  }

  set(sid, sess, cb) {
    this._run(() => {
      this.stmts.set.run(sid, JSON.stringify(sess), expiryOf(sess));
    }, cb);
  }

  destroy(sid, cb) {
    this._run(() => {
      this.stmts.destroy.run(sid);
    }, cb);
  }

  touch(sid, sess, cb) {
    this._run(() => {
      this.stmts.touch.run(expiryOf(sess), sid);
    }, cb);
  }
}

module.exports = SqliteStore;
