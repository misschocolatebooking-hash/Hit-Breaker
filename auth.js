// Auth: password hashing (scrypt, built-in) + session middleware.
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { hashPassword, verifyPassword, requireLogin, requireAdmin };
