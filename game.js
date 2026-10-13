// Hit Breaker rhythm game — Canvas + Web Audio.
// 4 lanes, tap beats in time. Perfect=100, Good=50, Miss=0. Combo multiplier.
(function () {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = 480, H = 720;
  canvas.width = W; canvas.height = H;

  const LANES = 4;
  const KEYS = { d: 0, f: 1, j: 2, k: 3 };
  const LANE_COLORS = ['#e05252', '#5fa8e0', '#5fc46a', '#d4af37'];
  const HIT_Y = H - 110;
  const PERFECT_MS = 70, GOOD_MS = 150;

  const LEVELS = [
    { bpm: 72,  duration: 45, travel: 2600, name: 'Level 1' },
    { bpm: 92,  duration: 50, travel: 2100, name: 'Level 2' },
    { bpm: 112, duration: 55, travel: 1750, name: 'Level 3' },
  ];

  // Deterministic RNG so charts are identical every run.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildChart(levelIdx) {
    const L = LEVELS[levelIdx];
    const rand = mulberry32(1234 + levelIdx * 777);
    const beatMs = 60000 / L.bpm;
    const notes = [];
    const totalBeats = Math.floor((L.duration * 1000) / beatMs);
    let lane = Math.floor(rand() * LANES);
    for (let b = 2; b < totalBeats; b++) { // skip first 2 beats (count-in)
      const t = b * beatMs;
      // move to a (usually) different lane
      lane = (lane + 1 + Math.floor(rand() * (LANES - 1))) % LANES;
      notes.push({ lane, time: t, hit: false, judged: false });
      // Level 2+: occasional 8th-note pickup
      if (levelIdx >= 1 && rand() < 0.18) {
        const l2 = (lane + 1 + Math.floor(rand() * (LANES - 1))) % LANES;
        notes.push({ lane: l2, time: t + beatMs / 2, hit: false, judged: false });
      }
      // Level 3: occasional double (two lanes at once, never 3+)
      if (levelIdx >= 2 && rand() < 0.12) {
        const l2 = (lane + 2) % LANES;
        notes.push({ lane: l2, time: t, hit: false, judged: false });
      }
    }
    notes.sort((a, b) => a.time - b.time);
    return notes;
  }

  // ---------- audio ----------
  let AC = null;
  function audio() {
    if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
    return AC;
  }
  function kick(t) {
    const ac = audio(), o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.16);
  }
  function hat(t) {
    const ac = audio(), len = ac.sampleRate * 0.05, buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = ac.createBufferSource(); s.buffer = buf;
    const g = ac.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    const f = ac.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
    s.connect(f).connect(g).connect(ac.destination); s.start(t);
  }
  function blip(perfect) {
    const ac = audio(), t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = 'triangle'; o.frequency.value = perfect ? 880 : 620;
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.1);
  }

  // ---------- game state ----------
  const G = {
    screen: 'menu', level: 0, notes: [], startTime: 0,
    score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0,
    token: null, tournamentId: null, judgedFlash: null, flashLane: -1, flashT: 0,
    totalScore: 0, totalPerfect: 0, totalGood: 0, totalMiss: 0, totalMaxCombo: 0,
    runStart: 0, beatTimer: null,
  };

  function laneX(i) { return (W / LANES) * i + W / LANES / 2; }

  function mult() { return 1 + Math.min(G.combo, 40) * 0.05; }

  function startLevel(idx) {
    G.level = idx;
    G.notes = buildChart(idx);
    G.score = 0; G.combo = 0; G.maxCombo = 0; G.perfect = 0; G.good = 0; G.miss = 0;
    G.screen = 'countdown';
    G.countdownT = 3;
    G.screen = 'playing';
    G.startTime = performance.now() + 1500; // 1.5s count-in
    G.runStart = G.runStart || performance.now();
    scheduleBeats(idx);
  }

  function scheduleBeats(idx) {
    const L = LEVELS[idx], beatMs = 60000 / L.bpm;
    const ac = audio();
    let next = ac.currentTime + 1.5;
    const totalBeats = Math.floor((L.duration * 1000) / beatMs);
    for (let b = 0; b < totalBeats; b++) {
      const t = next + b * (beatMs / 1000);
      setTimeout(((tt) => () => { kick(tt); })(t), (t - ac.currentTime) * 1000);
      setTimeout(((tt) => () => { hat(tt); })(t + beatMs / 2000), (t + beatMs / 2000 - ac.currentTime) * 1000);
    }
  }

  function judge(lane) {
    const now = performance.now() - G.startTime;
    let best = null, bestDt = Infinity;
    for (const n of G.notes) {
      if (n.lane !== lane || n.judged) continue;
      const dt = Math.abs(n.time - now);
      if (dt < bestDt) { bestDt = dt; best = n; }
      if (n.time - now > GOOD_MS) break;
    }
    G.flashLane = lane; G.flashT = performance.now();
    if (best && bestDt <= GOOD_MS) {
      best.judged = true; best.hit = true;
      const perfect = bestDt <= PERFECT_MS;
      G.combo++;
      G.maxCombo = Math.max(G.maxCombo, G.combo);
      const pts = Math.round((perfect ? 100 : 50) * mult());
      G.score += pts;
      if (perfect) G.perfect++; else G.good++;
      G.judgedFlash = { text: perfect ? 'PERFECT' : 'GOOD', color: perfect ? '#ffd700' : '#5fc46a', t: performance.now() };
      blip(perfect);
    } else {
      G.judgedFlash = { text: 'MISS', color: '#e05252', t: performance.now() };
    }
  }

  function update() {
    if (G.screen !== 'playing') return;
    const now = performance.now() - G.startTime;
    for (const n of G.notes) {
      if (!n.judged && now - n.time > GOOD_MS) {
        n.judged = true; G.miss++; G.combo = 0;
      }
    }
    const L = LEVELS[G.level];
    const lastNote = G.notes[G.notes.length - 1];
    if (now > lastNote.time + 600) endLevel();
  }

  function endLevel() {
    const total = G.perfect + G.good + G.miss;
    const acc = total ? ((G.perfect * 100 + G.good * 50) / (total * 100)) * 100 : 0;
    const stars = acc >= 85 ? 3 : acc >= 65 ? 2 : acc >= 40 ? 1 : 0;
    G.totalScore += G.score;
    G.totalPerfect += G.perfect; G.totalGood += G.good; G.totalMiss += G.miss;
    G.totalMaxCombo = Math.max(G.totalMaxCombo, G.maxCombo);
    G.lastAcc = acc; G.lastStars = stars;
    G.screen = stars >= 1 ? (G.level < 2 ? 'levelclear' : 'complete') : 'retry';
    if (G.screen === 'complete') submitScore();
  }

  async function submitScore() {
    if (!G.token) return;
    const total = G.totalPerfect + G.totalGood + G.totalMiss;
    const acc = total ? ((G.totalPerfect * 100 + G.totalGood * 50) / (total * 100)) * 100 : 0;
    try {
      await api('/api/scores', 'POST', {
        token: G.token, score: G.totalScore,
        perfect: G.totalPerfect, good: G.totalGood, miss: G.totalMiss,
        maxCombo: G.totalMaxCombo, accuracy: acc,
        levelReached: 3, stars: Math.min(3, G.lastStars),
        durationMs: Math.round(performance.now() - G.runStart),
      });
      G.submitted = true;
    } catch (e) { G.submitError = e.message; }
  }

  // ---------- rendering ----------
  function draw() {
    ctx.clearRect(0, 0, W, H);
    // lanes
    for (let i = 0; i < LANES; i++) {
      const x = (W / LANES) * i;
      ctx.fillStyle = i % 2 ? '#0d0a06' : '#100c07';
      ctx.fillRect(x, 0, W / LANES, H);
      ctx.strokeStyle = '#2a2114';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      // key hint
      ctx.fillStyle = '#8a744a'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('DFJK'[i], laneX(i), H - 24);
      // hit receptor
      const flash = (G.flashLane === i && performance.now() - G.flashT < 120);
      ctx.fillStyle = flash ? LANE_COLORS[i] : 'rgba(212,175,55,0.25)';
      ctx.beginPath(); ctx.arc(laneX(i), HIT_Y, 30, 0, 7); ctx.fill();
      ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 2; ctx.stroke();
    }
    // hit line
    ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, HIT_Y); ctx.lineTo(W, HIT_Y); ctx.stroke();

    if (G.screen === 'menu') {
      ctx.fillStyle = '#d4af37'; ctx.textAlign = 'center';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText('HIT BREAKER', W / 2, H / 2 - 80);
      ctx.fillStyle = '#f0e1c3'; ctx.font = '18px sans-serif';
      ctx.fillText('Tap the beats in time with the music', W / 2, H / 2 - 40);
      ctx.fillText('Keys: D F J K  •  or tap the lanes', W / 2, H / 2 - 12);
      ctx.fillStyle = '#d4af37'; ctx.font = 'bold 20px sans-serif';
      ctx.fillText('▶ TAP TO START ◀', W / 2, H / 2 + 40);
      ctx.fillStyle = '#8a744a'; ctx.font = '15px sans-serif';
      ctx.fillText('"When others say no, we say yes!"', W / 2, H / 2 + 80);
      ctx.fillText('— Miss Chocolate', W / 2, H / 2 + 104);
      return;
    }

    if (G.screen === 'playing') {
      const L = LEVELS[G.level];
      const now = performance.now() - G.startTime;
      if (now < 0) {
        ctx.fillStyle = '#d4af37'; ctx.textAlign = 'center'; ctx.font = 'bold 60px sans-serif';
        ctx.fillText(Math.ceil(-now / 1000), W / 2, H / 2);
        ctx.font = '22px sans-serif'; ctx.fillText(L.name, W / 2, H / 2 + 50);
      }
      for (const n of G.notes) {
        if (n.judged) continue;
        const dt = n.time - now;
        if (dt > L.travel || dt < -GOOD_MS) continue;
        const y = HIT_Y - (dt / L.travel) * HIT_Y;
        ctx.fillStyle = LANE_COLORS[n.lane];
        ctx.beginPath(); ctx.arc(laneX(n.lane), y, 24, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('♪', laneX(n.lane), y + 6);
      }
      // HUD
      ctx.textAlign = 'left'; ctx.fillStyle = '#d4af37'; ctx.font = 'bold 22px sans-serif';
      ctx.fillText(L.name, 12, 30);
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff';
      ctx.fillText(String(G.score), W - 12, 30);
      ctx.fillStyle = '#f5d78c'; ctx.font = '18px sans-serif';
      ctx.fillText(G.combo > 1 ? `x${mult().toFixed(2)} combo ${G.combo}` : '', W - 12, 56);
      // judgment flash
      if (G.judgedFlash && performance.now() - G.judgedFlash.t < 500) {
        ctx.textAlign = 'center'; ctx.fillStyle = G.judgedFlash.color;
        ctx.font = 'bold 34px sans-serif';
        ctx.fillText(G.judgedFlash.text, W / 2, H / 2);
      }
      return;
    }

    // result screens
    ctx.textAlign = 'center';
    const showResults = (title, color, extra) => {
      ctx.fillStyle = color; ctx.font = 'bold 40px sans-serif';
      ctx.fillText(title, W / 2, 200);
      ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif';
      ctx.fillText(`Score: ${G.totalScore}`, W / 2, 270);
      ctx.fillText(`Accuracy: ${G.lastAcc.toFixed(1)}%`, W / 2, 310);
      ctx.fillStyle = '#ffd700'; ctx.font = '36px sans-serif';
      ctx.fillText('★'.repeat(G.lastStars) + '☆'.repeat(3 - G.lastStars), W / 2, 360);
      ctx.fillStyle = '#f0e1c3'; ctx.font = '18px sans-serif';
      ctx.fillText(`Perfect ${G.totalPerfect} • Good ${G.totalGood} • Miss ${G.totalMiss}`, W / 2, 410);
      if (extra) { ctx.fillStyle = '#8a744a'; ctx.fillText(extra, W / 2, 450); }
      if (G.submitError) { ctx.fillStyle = '#e05252'; ctx.fillText('Score not saved: ' + G.submitError, W / 2, 480); }
      else if (G.submitted) { ctx.fillStyle = '#5fc46a'; ctx.fillText('Score saved!', W / 2, 480); }
      ctx.fillStyle = '#d4af37'; ctx.font = 'bold 22px sans-serif';
      ctx.fillText('▶ TAP TO CONTINUE ◀', W / 2, 560);
    };

    if (G.screen === 'levelclear') showResults(LEVELS[G.level].name + ' CLEAR!', '#5fc46a');
    else if (G.screen === 'retry') showResults('NOT QUITE —', '#e05252', 'One more try! You need 1 star to advance.');
    else if (G.screen === 'complete') showResults('YOU BROKE THE HIT!', '#ffd700', 'All 3 levels complete!');
  }

  function loop() { update(); draw(); requestAnimationFrame(loop); }

  // ---------- input ----------
  function onTap(x) {
    const rect = canvas.getBoundingClientRect();
    const cx = (x - rect.left) * (W / rect.width);
    const lane = Math.min(LANES - 1, Math.max(0, Math.floor(cx / (W / LANES))));
    handlePress(lane);
  }
  function handlePress(lane) {
    audio(); // unlock audio on gesture
    if (G.screen === 'menu') { beginRun(); return; }
    if (G.screen === 'playing') { if (lane !== undefined) judge(lane); return; }
    if (G.screen === 'levelclear') { startLevel(G.level + 1); return; }
    if (G.screen === 'retry') { startLevel(G.level); return; }
    if (G.screen === 'complete') { resetToMenu(); return; }
  }

  async function beginRun() {
    // reset totals
    G.totalScore = 0; G.totalPerfect = 0; G.totalGood = 0; G.totalMiss = 0;
    G.totalMaxCombo = 0; G.submitted = false; G.submitError = null;
    G.runStart = performance.now();
    // get a game token (requires login)
    const params = new URLSearchParams(location.search);
    G.tournamentId = params.get('tournament') || null;
    if (!currentUser) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); return; }
    try {
      const { token } = await api('/api/game/start', 'POST', { tournamentId: G.tournamentId });
      G.token = token;
    } catch (e) {
      alert(e.message);
      return;
    }
    startLevel(0);
  }

  function resetToMenu() { G.screen = 'menu'; G.token = null; }

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k in KEYS) { e.preventDefault(); handlePress(KEYS[k]); }
    else if (k === ' ' || k === 'enter') { e.preventDefault(); handlePress(undefined); }
  });
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); onTap(e.clientX); });

  // expose for page
  window.HBGame = { get state() { return G; } };
  loop();
})();
