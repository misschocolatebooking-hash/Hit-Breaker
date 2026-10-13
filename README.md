# Hit Breaker 🎮💰

A skill-based rhythm arcade game (Miss Chocolate branding — gold/black) where players
pay entry fees into daily tournaments and the top 3 scorers win **real money**.

- **Entry fees** collected via **PayPal Checkout** (Orders API)
- **Winnings** paid automatically via **PayPal Payouts API**
- **Cash App** winners go into a **manual payout queue** (no public Cash App API exists —
  the admin sends the payment in the Cash App and clicks "Mark Paid")
- 80% of entry fees go to the prize pot, 20% is the house cut
- Pot splits 50/30/20 among the top 3 scorers

## Tech

- Backend: Node.js + Express + built-in `node:sqlite` (no native modules needed)
- Passwords: scrypt hashing via `node:crypto`
- Sessions: `express-session` stored in SQLite (same `data/hitbreaker.db` file as user accounts, so they survive restarts)
- Frontend: HTML5 Canvas + Web Audio API, served by the same Express app

## Setup

1. **Install:**
   ```bash
   cd hit-breaker
   npm install
   ```

2. **Configure:** copy `.env.example` to `.env` and fill in:
   ```
   PORT=3000
   SESSION_SECRET=a-long-random-string
   PAYPAL_MODE=sandbox
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ADMIN_EMAIL=you@example.com   # your login email → becomes admin
   ```

3. **PayPal sandbox (for testing):**
   - Create a free account at https://developer.paypal.com
   - Go to *Apps & Credentials* → create a Sandbox app → copy Client ID + Secret
   - Sandbox Payouts are enabled by default — test payouts work with sandbox accounts

4. **Run:**
   ```bash
   npm start
   # → http://localhost:3000
   ```

5. **First run:** sign up with the `ADMIN_EMAIL` address — that account becomes admin
   and can open `/admin.html`.

## How it works

- Three daily tournaments auto-create on startup ($1 / $5 / $10 entry), ending at midnight.
- Player clicks **Enter** → PayPal button → approves → server captures the order and
  **verifies the captured amount matches the entry fee** before recording the entry.
- Player clicks **Play Now** → server issues a **single-use game token** (30-min expiry).
- On game end the client POSTs the score with the token. The server validates:
  - token is valid, unused, unexpired, belongs to the player
  - note count within sane bounds, score ≤ notes × 100 × 3 (max combo multiplier)
  - accuracy recomputed from Perfect/Good/Miss counts (must match within 2%)
  - play duration not impossibly fast
- Every minute, expired tournaments auto-close: top 3 by best score split the pot.
  - **PayPal** winners (with a PayPal email on their profile) are paid in one batch
    via the Payouts API.
  - **Cash App** winners (with a $cashtag) go to the admin's manual queue.
  - Winners with no payout destination set are flagged `pending_info`.
- Admin closes tournaments early, creates custom tournaments, and marks Cash App
  payments as paid from `/admin.html`.

## Going live (PayPal)

1. In the PayPal Developer Dashboard, switch your app to **Live** and copy the live
   Client ID + Secret into `.env`, set `PAYPAL_MODE=live`.
2. **Payouts must be approved for live use:** apply at
   developer.paypal.com → your app → request Payouts approval (requires a PayPal
   Business account in good standing). Until approved, live payouts will fail —
   winners will show as `failed` in the admin panel and you can retry/pay manually.
3. Persist the `data/` directory (e.g. a Railway volume mounted at `/app/data`) so
   accounts and sessions survive redeploys, run behind HTTPS, and keep `.env` out
   of version control.

## Cash App note

Cash App has **no public payouts API**. The manual queue in `/admin.html` shows each
winner's $cashtag and amount. Send the payment in your Cash App, then click
**Mark Paid**. That record is your audit trail.

## Project structure

```
hit-breaker/
├── server.js          # Express app, all API routes, tournament close/payout logic
├── db.js              # SQLite schema + queries (node:sqlite)
├── paypal.js          # PayPal Orders + Payouts client
├── auth.js            # scrypt password hashing, login/admin middleware
├── public/
│   ├── index.html     # Home + the game
│   ├── tournaments.html  # Browse + enter tournaments (PayPal buttons)
│   ├── leaderboard.html  # All-time / daily / weekly
│   ├── profile.html   # Stats + payout settings + winnings
│   ├── admin.html     # Tournaments, payout queue, users
│   ├── login.html / signup.html
│   ├── css/style.css
│   └── js/common.js   # API + nav helpers
│   └── js/game.js     # Canvas rhythm game engine
└── data/              # SQLite database (created on first run)
```

## Legal note

Skill-based prize games are regulated differently by state/country. Entry-fee
tournaments can be treated as gambling in some jurisdictions. Get legal advice
before taking real-money entry fees.
