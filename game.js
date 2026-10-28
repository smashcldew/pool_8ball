/*
 * game.js — 介面、繪圖、操作與 PeerJS 連線
 * 規則與物理在 engine.js，對戰流程與同步在 session.js。
 */
(function () {
  'use strict';

  const E = window.PoolEngine;
  const Session = window.PoolSession.Session;
  const $ = function (id) { return document.getElementById(id); };

  // ---------- 設定 ----------
  const PEER_PREFIX = 'cldew-8ball-';                  // 邀請碼前綴，避免和別人的房間撞 ID
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 I L O 0 1
  const CODE_LEN = 5;
  const STUN = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ];
  // TURN 中繼伺服器：當雙方 NAT 太嚴格（校園／宿舍網路常見）無法直接打洞時，
  // 改用中繼轉送，連線成功率接近 100%。下面是 Open Relay 的免費公共 TURN（盡力而為、
  // 可能限流或失效）。要穩定請自行申請免費額度（metered.ca、Twilio 等）填在這裡。
  const TURN = [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ];
  const ICE = STUN.concat(TURN);
  const PEER_OPTS = { config: { iceServers: ICE }, debug: 0 };
  const CONNECT_TRIES = 4, OPEN_TIMEOUT = 7000, JOIN_TIMEOUT = 28000;

  const B = 40, CW = E.W + 2 * B, CH = E.H + 2 * B;     // 球桌外框
  const PULL_MAX = 260, MIN_PULL = 18, MIN_V = 120;     // 拉桿操作
  const COLORS = [null, '#f2c500', '#1d4fd8', '#d62828', '#6a2c91', '#f77f00', '#1b8a3a', '#7a1f1f', '#161616'];

  // ---------- 狀態 ----------
  let session = null, peer = null, conn = null;
  let pingT = 0, watchT = 0, lastRecv = 0, roomCode = '';
  let aiming = false, placing = false;
  let pointer = { x: 0, y: 0, has: false };
  let rafId = 0, lastT = 0;
  let k = 1, tableCv = null;
  let soundOn = true, ac = null;
  let rematchSent = false, peerGone = false;
  let lastStatus = '';

  const cv = $('cv'), ctx = cv.getContext('2d');

  // ---------- 畫面切換 ----------
  function show(name) {
    ['lobby', 'room', 'game'].forEach(function (n) { $(n).classList.toggle('hidden', n !== name); });
  }
  function setMsg(el, text, isErr) {
    el.textContent = text || '';
    el.classList.toggle('err', !!isErr);
  }

  // ---------- 網路 ----------
  function genCode() {
    let s = '';
    const buf = new Uint32Array(CODE_LEN);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
    return s;
  }
  function cleanCode(v) {
    return String(v || '').toUpperCase().split('').filter(function (c) { return CODE_CHARS.indexOf(c) >= 0; }).join('').slice(0, CODE_LEN);
  }
  function netErr(err) {
    const t = err && err.type;
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed')
      return '連不上配對伺服器（PeerJS 公共服務），請稍後再試。';
    if (t === 'browser-incompatible') return '這個瀏覽器不支援 WebRTC，請改用新版 Chrome / Safari / Firefox。';
    if (t === 'webrtc') return 'P2P 連線失敗，雙方的網路可能需要 TURN 中繼。';
    return '連線錯誤：' + ((err && (err.message || err.type)) || '未知');
  }

  function teardownNet() {
    clearInterval(pingT); clearInterval(watchT);
    const c = conn, p = peer;
    conn = null; peer = null;
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    try { if (p) p.destroy(); } catch (e) { /* ignore */ }
  }

  function backToLobby(msg, isErr) {
    teardownNet();
    session = null; aiming = false; placing = false; peerGone = false; rematchSent = false;
    cancelAnimationFrame(rafId); rafId = 0;
    $('overlay').classList.add('hidden');
    show('lobby');
    setMsg($('lobbyMsg'), msg || '', isErr);
  }

  function createRoom(attempt) {
    attempt = attempt || 0;
    if (typeof window.Peer === 'undefined') {
      backToLobby('無法載入連線元件（PeerJS）。請檢查網路後重新整理頁面。', true);
      return;
    }
    teardownNet();
    roomCode = genCode();
    $('roomCode').textContent = roomCode;
    setMsg($('roomMsg'), '正在連線到配對伺服器…');
    show('room');

    const p = new window.Peer(PEER_PREFIX + roomCode, PEER_OPTS);
    peer = p;
    p.on('open', function () {
      if (peer !== p) return;
      setMsg($('roomMsg'), '等待朋友加入…（請保持此頁面開啟）');
    });
    p.on('connection', function (c) {
      if (peer !== p) return;
      // 遊戲已經開始才拒絕新連線；開始前若對手重試（換一條新連線），用最新的取代尚未
      // 開啟的舊連線——否則房主會鎖在一條半開、對方已放棄的死連線上，造成「機率性失敗」。
      if (session) { c.on('open', function () { try { c.close(); } catch (e) { /* ignore */ } }); return; }
      if (conn && conn !== c) { try { conn.close(); } catch (e) { /* ignore */ } }
      conn = c;
      setMsg($('roomMsg'), '對手連線中…');
      wireConn(c, 'host');
    });
    p.on('disconnected', function () { try { if (peer === p && !p.destroyed) p.reconnect(); } catch (e) { /* ignore */ } });
    p.on('error', function (err) {
      if (peer !== p) return;
      if (err.type === 'unavailable-id' && attempt < 5) { createRoom(attempt + 1); return; }
      backToLobby(netErr(err), true);
    });
  }

  function joinRoom(code) {
    code = cleanCode(code);
    if (code.length !== CODE_LEN) { setMsg($('lobbyMsg'), '邀請碼是 ' + CODE_LEN + ' 個字元', true); return; }
    if (typeof window.Peer === 'undefined') {
      setMsg($('lobbyMsg'), '無法載入連線元件（PeerJS）。請檢查網路後重新整理頁面。', true);
      return;
    }
    teardownNet();
    setMsg($('lobbyMsg'), '連線中…');
    const p = new window.Peer(PEER_OPTS);
    peer = p;
    let tries = 0, openTimer = 0;
    const giveUp = setTimeout(function () {
      if (peer === p && !session) { clearTimeout(openTimer); backToLobby('連線逾時：請確認邀請碼、房主是否還開著頁面，或雙方網路是否允許 P2P（嚴格網路可能需要 TURN）。', true); }
    }, JOIN_TIMEOUT);

    // 偶發失敗（broker 傳播延遲、ICE 打洞沒打中）重試常能成功，所以在開啟逾時後換一條新連線重試。
    function attempt() {
      if (peer !== p || session) return;
      tries++;
      setMsg($('lobbyMsg'), tries === 1 ? '連線中…' : '連線中…（重試 ' + tries + '/' + CONNECT_TRIES + '）');
      const c = p.connect(PEER_PREFIX + code, { reliable: true });
      conn = c;
      wireConn(c, 'guest', giveUp);
      clearTimeout(openTimer);
      openTimer = setTimeout(function () {
        if (peer !== p || session || c.open) return;        // 已成功則不動
        try { c.close(); } catch (e) { /* ignore */ }
        if (conn === c) conn = null;
        if (tries < CONNECT_TRIES) attempt(); else backToLobby('連不上房主：可能雙方網路不允許 P2P，嚴格網路（校園／宿舍）通常需要 TURN 中繼。', true);
      }, OPEN_TIMEOUT);
    }

    p.on('open', function () { if (peer === p) attempt(); });
    p.on('error', function (err) {
      if (peer !== p || session) return;
      // 房主 ID 可能還沒在 broker 上傳播完 → 短暫重試，而不是直接報「找不到房間」
      if (err.type === 'peer-unavailable' && tries < CONNECT_TRIES) { setTimeout(attempt, 900); return; }
      if (err.type === 'peer-unavailable') return;           // 交給 giveUp 逾時統一處理
      clearTimeout(giveUp); clearTimeout(openTimer);
      backToLobby(netErr(err), true);
    });
  }

  function wireConn(c, role, timer) {
    let opened = false;
    function onOpen() {
      if (opened || conn !== c) return;
      opened = true;
      clearTimeout(timer);
      lastRecv = Date.now();
      session = new Session(E, role, function (m) { if (c.open) c.send(m); }, hooks);
      peerGone = false;
      pingT = setInterval(function () { if (c.open) c.send({ t: 'ping' }); }, 4000);
      watchT = setInterval(function () { if (Date.now() - lastRecv > 20000) onPeerGone(); }, 5000);
      if (role === 'host') {
        session.startGame(0);
      } else {
        setMsg($('lobbyMsg'), '已連線，等待房主開始…');
        if (c.open) c.send({ t: 'hello' });   // 主動要求房主送開局資料（保險）
      }
    }
    // 重點修正：PeerJS 接收端（房主）常常在我們掛上 'open' 監聽器之前就已經 open，
    // 導致事件被錯過、房主永遠不會開始。所以先檢查 c.open，已開就立即處理。
    if (c.open) onOpen(); else c.on('open', onOpen);

    c.on('data', function (m) {
      if (conn !== c) return;
      lastRecv = Date.now();
      if (m && m.t === 'hello') {
        // 房主收到挑戰者的 hello：把目前的開局盤面再送一次，確保對方一定收到
        if (session && session.role === 'host' && session.ready && c.open)
          c.send({ t: 'sync', init: true, s: E.serialize(session.state) });
        return;
      }
      if (session) session.receive(m);
    });
    c.on('close', function () { if (conn === c) onPeerGone(); });
    c.on('error', function () { if (conn === c) onPeerGone(); });
  }

  function onPeerGone() {
    if (peerGone || !session) return;
    peerGone = true;
    clearInterval(pingT); clearInterval(watchT);
    showOverlay('對手已離線', '連線已中斷。', false);
  }

  // ---------- Session 回呼 ----------
  const hooks = {
    onInit: function () {
      rematchSent = false;
      $('overlay').classList.add('hidden');
      $('btnRematch').disabled = false; $('btnRematch').textContent = '再來一局';
      enterGame();
    },
    onSync: function () { refreshHUD(); if (session.state.winner !== null) checkOver(); },
    onAwaiting: function () { refreshHUD(); },
    onShotEnd: function () { refreshHUD(); checkOver(); }
  };

  function enterGame() {
    show('game');
    resize();
    refreshHUD();
    if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); }
  }

  // ---------- 文字 ----------
  function nameOf(p) {
    if (session.my === null) return '玩家 ' + (p + 1);
    return p === session.my ? '你' : '對手';
  }
  function groupName(g) { return g === 'solid' ? '全色球（1–7）' : '花色球（9–15）'; }
  function describe(m) {
    if (!m) return '';
    const who = nameOf(m.p);
    if (m.win) {
      if (m.end === 'win8') return who + '打進 8 號球，獲勝！';
      if (m.end === 'early8') return who + '太早打進 8 號球，判負。';
      return who + '打進 8 號球時犯規，判負。';
    }
    const parts = [];
    if (m.respot) parts.push('開球時 8 號球落袋，已放回球桌');
    if (m.potted.length) parts.push(who + '進了 ' + m.potted.map(function (n) { return '#' + n; }).join(' '));
    if (m.assigned) parts.push(who + '打' + groupName(m.assigned));
    if (m.foul) {
      const why = m.reasons.map(function (r) {
        return r === 'scratch' ? '母球落袋' : r === 'nohit' ? '沒有碰到任何球' : '先碰到不該碰的球';
      }).join('、');
      parts.push('犯規（' + why + '），' + nameOf(1 - m.p) + '可自由擺放母球');
    } else if (!m.potted.length && !m.respot) {
      parts.push(who + '沒有進球');
    }
    return parts.join('；') + '。';
  }

  function statusText() {
    if (!session) return '';
    const s = session.state;
    if (!session.ready) return '等待遊戲開始…';
    const last = describe(s.message);
    let tail;
    if (s.winner !== null) tail = '';
    else if (s.moving) tail = '球正在滾動…';
    else if (session.awaiting) tail = '同步結果中…';
    else if (session.canAct()) {
      const who = session.my === null ? '輪到' + nameOf(s.turn) + '：' : '輪到你：';
      tail = who + (s.ballInHand ? '點一下球桌放置母球。' : '在球桌按住、往母球反方向拉，放開擊球。');
    } else tail = '等待' + nameOf(s.turn) + '出桿…';
    return (last ? last + ' ' : '') + tail;
  }

  function refreshHUD() {
    if (!session) return;
    const s = session.state;
    for (let p = 0; p < 2; p++) {
      const card = $('p' + p);
      card.classList.toggle('active', s.turn === p && s.winner === null);
      card.querySelector('.pname').textContent = nameOf(p);
      const g = s.groups[p];
      card.querySelector('.pgroup').textContent = g ? (g === 'solid' ? '全色 1–7' : '花色 9–15') : '尚未分組';
      const chips = card.querySelector('.chips');
      chips.textContent = '';
      if (g) {
        const ids = g === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
        ids.push(8);
        ids.forEach(function (id) {
          const d = document.createElement('span');
          d.className = 'chip' + (id > 8 ? ' stripe' : '') + (s.balls[id].pocketed ? ' out' : '');
          const c = COLORS[id > 8 ? id - 8 : id];
          d.style.background = c; d.style.setProperty('--c', c);
          d.textContent = id;
          chips.appendChild(d);
        });
      }
    }
  }

  function showOverlay(title, text, canRematch) {
    $('ovTitle').textContent = title;
    $('ovText').textContent = text;
    $('btnRematch').classList.toggle('hidden', !canRematch);
    $('overlay').classList.remove('hidden');
  }

  function checkOver() {
    const s = session.state;
    if (s.winner === null || peerGone) return;
    const w = s.winner;
    const title = session.my === null ? nameOf(w) + '獲勝' : (w === session.my ? '你贏了 🎉' : '你輸了');
    let text = describe(s.message);
    if (session.role === 'host' && session.rematch[1] && !session.rematch[0]) text += ' 對手想再來一局。';
    showOverlay(title, text, true);
  }

  // ---------- 音效 ----------
  function ensureAudio() {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } }
    if (ac && ac.state === 'suspended') ac.resume();
  }
  function tick(freq, vol, dur) {
    if (!ac || !soundOn) return;
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.5), t + dur);
    g.gain.setValueAtTime(Math.max(0.001, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function playEvents() {
    const ev = session.state.events;
    if (!ev.length) return;
    let n = 0;
    for (let i = 0; i < ev.length && n < 4; i++) {
      const e = ev[i];
      if (e.type === 'ball') { tick(850 + Math.random() * 250, Math.min(0.25, e.v / 1200), 0.06); n++; }
      else if (e.type === 'rail') { tick(210, Math.min(0.18, e.v / 1500), 0.08); n++; }
      else if (e.type === 'pocket') { tick(110, 0.3, 0.25); n++; }
    }
    ev.length = 0;
  }

  // ---------- 繪圖 ----------
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function resize() {
    const r = cv.getBoundingClientRect();
    if (r.width < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(r.width * dpr), h = Math.round(r.width * (CH / CW) * dpr);
    if (cv.width !== w || cv.height !== h || !tableCv) {
      cv.width = w; cv.height = h;
      k = w / CW;
      tableCv = document.createElement('canvas');
      tableCv.width = w; tableCv.height = h;
      drawTable(tableCv.getContext('2d'));
    }
  }

  function drawTable(c) {
    c.setTransform(k, 0, 0, k, 0, 0);
    // 木框
    const wood = c.createLinearGradient(0, 0, 0, CH);
    wood.addColorStop(0, '#8a5a2b'); wood.addColorStop(1, '#4a2a10');
    rr(c, 0, 0, CW, CH, 26); c.fillStyle = wood; c.fill();
    c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 2; rr(c, 2, 2, CW - 4, CH - 4, 24); c.stroke();
    // 庫邊
    rr(c, B - 16, B - 16, E.W + 32, E.H + 32, 8); c.fillStyle = '#0f5a37'; c.fill();
    // 檯呢
    const cloth = c.createRadialGradient(CW / 2, CH / 2, 40, CW / 2, CH / 2, CW * 0.6);
    cloth.addColorStop(0, '#2fa06a'); cloth.addColorStop(1, '#17744a');
    c.fillStyle = cloth; c.fillRect(B, B, E.W, E.H);
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 3; c.strokeRect(B, B, E.W, E.H);
    // 開球線與擺球點
    c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(B + 250, B); c.lineTo(B + 250, B + E.H); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.22)';
    c.beginPath(); c.arc(B + 250, B + E.H / 2, 3, 0, 6.2832); c.fill();
    c.beginPath(); c.arc(B + 700, B + E.H / 2, 3, 0, 6.2832); c.fill();
    // 鑽石標記
    c.fillStyle = '#ecdcab';
    function dia(x, y) { c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x + 4, y); c.lineTo(x, y + 4); c.lineTo(x - 4, y); c.closePath(); c.fill(); }
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      dia(B + E.W * i / 8, B - 28); dia(B + E.W * i / 8, B + E.H + 28);
    }
    for (let j = 1; j < 4; j++) { dia(B - 28, B + E.H * j / 4); dia(B + E.W + 28, B + E.H * j / 4); }
    // 袋口
    E.POCKETS.forEach(function (p) {
      const g = c.createRadialGradient(B + p.x, B + p.y, 2, B + p.x, B + p.y, p.r + 2);
      g.addColorStop(0, '#000'); g.addColorStop(0.8, '#070a07'); g.addColorStop(1, '#1b1b1b');
      c.beginPath(); c.arc(B + p.x, B + p.y, p.r + 1, 0, 6.2832);
      c.fillStyle = g; c.fill();
      c.lineWidth = 4; c.strokeStyle = '#3b230f'; c.stroke();
    });
  }

  function drawBall(x, y, id, alpha) {
    const R = E.R;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.beginPath(); ctx.arc(2.5, 3.5, R, 0, 6.2832); ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.clip();
    const col = id === 0 ? '#f4f1e8' : COLORS[id > 8 ? id - 8 : id];
    ctx.fillStyle = (id === 0 || id > 8) ? '#f4f1e8' : col;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
    if (id > 8) { ctx.fillStyle = col; ctx.fillRect(-R, -6.5, 2 * R, 13); }
    if (id !== 0) {
      ctx.beginPath(); ctx.arc(0, 0, 5.8, 0, 6.2832); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = 'bold 8px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(id), 0, 0.5);
    }
    const sh = ctx.createRadialGradient(-4, -5, 1, 0, 0, R);
    sh.addColorStop(0, 'rgba(255,255,255,.6)'); sh.addColorStop(0.35, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,.38)');
    ctx.fillStyle = sh; ctx.fillRect(-R, -R, 2 * R, 2 * R);
    ctx.restore();
  }

  function aimVec() {
    const s = session.state, cue = s.balls[0];
    if (cue.pocketed || !pointer.has) return null;
    const vx = cue.x - pointer.x, vy = cue.y - pointer.y;
    const dist = Math.sqrt(vx * vx + vy * vy);
    if (dist < 1e-6) return null;
    return { dx: vx / dist, dy: vy / dist, dist: dist, power: Math.min(1, dist / PULL_MAX) };
  }

  function drawStick(cue, a) {
    const tipD = E.R + 5 + a.power * 55, len = 330;
    const tx = cue.x - a.dx * tipD, ty = cue.y - a.dy * tipD;
    const bx = tx - a.dx * len, by = ty - a.dy * len;
    const px = -a.dy, py = a.dx;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
    const g = ctx.createLinearGradient(tx, ty, bx, by);
    g.addColorStop(0, '#f1e0b5'); g.addColorStop(0.08, '#c9a46a'); g.addColorStop(0.6, '#8a5a2b'); g.addColorStop(1, '#2d1a0b');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(tx + px * 2, ty + py * 2); ctx.lineTo(bx + px * 5, by + py * 5);
    ctx.lineTo(bx - px * 5, by - py * 5); ctx.lineTo(tx - px * 2, ty - py * 2);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#3a78c8';
    ctx.beginPath(); ctx.arc(tx, ty, 2.2, 0, 6.2832); ctx.fill();
  }

  function drawAim(cue, a) {
    const info = E.aim(session.state, cue.x, cue.y, a.dx, a.dy);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.setLineDash([9, 8]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.beginPath(); ctx.moveTo(cue.x, cue.y); ctx.lineTo(info.gx, info.gy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(info.gx, info.gy, E.R, 0, 6.2832); ctx.stroke();
    if (info.ballId !== null) {
      const tb = session.state.balls[info.ballId];
      ctx.strokeStyle = 'rgba(255,225,80,.9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tb.x, tb.y); ctx.lineTo(tb.x + info.tx * 80, tb.y + info.ty * 80); ctx.stroke();
      if (info.ox !== 0 || info.oy !== 0) {
        ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(info.gx, info.gy); ctx.lineTo(info.gx + info.ox * 45, info.gy + info.oy * 45); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function draw() {
    if (!tableCv) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tableCv, 0, 0);
    ctx.setTransform(k, 0, 0, k, B * k, B * k);
    const s = session.state;
    for (let i = 0; i < 16; i++) {
      const b = s.balls[i];
      if (!b.pocketed) drawBall(b.x, b.y, b.id);
    }
    const can = session.canAct();
    if (can && s.ballInHand && pointer.has) {
      const x = Math.min(E.W - E.R, Math.max(E.R, pointer.x)), y = Math.min(E.H - E.R, Math.max(E.R, pointer.y));
      const ok = E.canPlace(s, x, y);
      drawBall(x, y, 0, 0.7);
      ctx.save();
      ctx.lineWidth = 2.5; ctx.strokeStyle = ok ? 'rgba(80,255,140,.95)' : 'rgba(255,90,80,.95)';
      ctx.beginPath(); ctx.arc(x, y, E.R + 4, 0, 6.2832); ctx.stroke();
      ctx.restore();
    }
    let pw = 0;
    if (aiming && can && !s.ballInHand) {
      const a = aimVec();
      if (a && a.dist >= MIN_PULL) {
        drawAim(s.balls[0], a);
        drawStick(s.balls[0], a);
        pw = a.power;
      }
    }
    $('power').style.width = (pw * 100).toFixed(0) + '%';
    $('powerText').textContent = pw > 0 ? Math.round(pw * 100) + '%' : '';
  }

  function frame(t) {
    rafId = 0;
    if (!session) return;
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    session.update(dt);
    playEvents();
    draw();
    const txt = statusText();
    if (txt !== lastStatus) {
      lastStatus = txt;
      $('status').textContent = txt;
      refreshHUD();
    }
    $('status').classList.toggle('mine', session.canAct());
    rafId = requestAnimationFrame(frame);
  }

  // ---------- 操作 ----------
  function toTable(e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * CW - B, y: (e.clientY - r.top) / r.height * CH - B, has: true };
  }
  function cancelAim() { aiming = false; placing = false; }

  cv.addEventListener('pointerdown', function (e) {
    ensureAudio();
    if (!session) return;
    e.preventDefault();
    if (e.button === 2) { cancelAim(); return; }
    pointer = toTable(e);
    if (!session.canAct()) return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (session.state.ballInHand) placing = true; else aiming = true;
  });
  cv.addEventListener('pointermove', function (e) {
    if (!session) return;
    pointer = toTable(e);
  });
  cv.addEventListener('pointerup', function (e) {
    if (!session) return;
    pointer = toTable(e);
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    // 先用「放開瞬間」的位置結算，之後才清掉（觸控沒有 hover，不需要留著游標）
    if (aiming) {
      const a = aimVec();
      aiming = false;
      if (a && a.dist >= MIN_PULL) {
        const v = MIN_V + (E.MAXV - MIN_V) * a.power * a.power;
        if (session.tryShoot(a.dx * v, a.dy * v)) tick(520, 0.2 + 0.2 * a.power, 0.07);
      }
    } else if (placing) {
      placing = false;
      const x = Math.min(E.W - E.R, Math.max(E.R, pointer.x));
      const y = Math.min(E.H - E.R, Math.max(E.R, pointer.y));
      if (session.tryPlace(x, y)) { refreshHUD(); lastStatus = ''; }
    }
    if (e.pointerType && e.pointerType !== 'mouse') pointer.has = false;
  });
  cv.addEventListener('pointercancel', cancelAim);
  cv.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !aiming && !placing) pointer.has = false; });
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); cancelAim(); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') cancelAim(); });
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe($('stage'));

  // ---------- 按鈕 ----------
  function copyText(text, okMsg, el) {
    function done() { setMsg(el, okMsg); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('複製這段文字：', text); });
    else window.prompt('複製這段文字：', text);
  }

  $('btnCreate').addEventListener('click', function () { createRoom(0); });
  $('joinForm').addEventListener('submit', function (e) { e.preventDefault(); joinRoom($('codeInput').value); });
  $('codeInput').addEventListener('input', function (e) { e.target.value = cleanCode(e.target.value); });
  $('btnLocal').addEventListener('click', function () {
    teardownNet();
    session = new Session(E, 'local', null, hooks);
    session.startGame(0);
  });
  $('btnCopyCode').addEventListener('click', function () { copyText(roomCode, '已複製邀請碼：' + roomCode, $('roomMsg')); });
  $('btnCopyLink').addEventListener('click', function () {
    const url = location.origin + location.pathname + '?room=' + roomCode;
    copyText(url, '已複製邀請連結', $('roomMsg'));
  });
  $('btnCancelRoom').addEventListener('click', function () { backToLobby(''); });
  $('btnSound').addEventListener('click', function () {
    soundOn = !soundOn; ensureAudio();
    $('btnSound').textContent = soundOn ? '🔊' : '🔇';
  });
  $('btnLeave').addEventListener('click', function () {
    if (session && session.role !== 'local' && session.state.winner === null && !peerGone &&
        !window.confirm('確定要離開？對手會看到你離線。')) return;
    backToLobby('');
  });
  $('btnBack').addEventListener('click', function () { backToLobby(''); });
  $('btnRematch').addEventListener('click', function () {
    if (!session || session.state.winner === null) return;
    session.requestRematch();
    // requestRematch() 可能已經「雙方都同意→立刻開新局」，此時 onInit 已把按鈕復原，
    // 不可再蓋成等待狀態。只有在仍停留在結算畫面（還沒開新局）時才顯示等待對手。
    if (session.role !== 'local' && session.state.winner !== null) {
      rematchSent = true;
      $('btnRematch').disabled = true; $('btnRematch').textContent = '等待對手同意…';
    }
  });

  // 邀請連結 ?room=XXXXX：自動填入並加入
  (function autoJoin() {
    let code = '';
    try { code = cleanCode(new URLSearchParams(location.search).get('room')); } catch (e) { /* ignore */ }
    if (code.length === CODE_LEN) {
      $('codeInput').value = code;
      history.replaceState(null, '', location.pathname);
      setTimeout(function () { joinRoom(code); }, 150);
    }
  })();

  // 讓測試可以取用內部狀態（不影響遊戲）
  window.__pool = { get session() { return session; } };
})();
