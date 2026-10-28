'use strict';
const assert = require('assert');
const E = require('../engine.js');
const { Session } = require('../session.js');

// 可重現的亂數
function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function runToRest(s, maxSec) {
  let n = 0;
  const lim = Math.round(maxSec / E.STEP);
  while (s.moving && n < lim) { E.step(s, E.STEP); n++; }
  return n * E.STEP;
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

// ---------- 擺球 ----------
test('開局擺球：16 顆、不重疊、8 號在中央', function () {
  for (let seed = 1; seed <= 20; seed++) {
    const s = E.newState(0, mulberry(seed));
    const ids = s.balls.map(function (b) { return b.id; });
    assert.deepStrictEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
      const d = Math.hypot(s.balls[i].x - s.balls[j].x, s.balls[i].y - s.balls[j].y);
      assert(d >= 2 * E.R, 'overlap ' + i + ',' + j);
    }
    assert(Math.abs(s.balls[8].y - E.H / 2) < 1e-9);
  }
});

// ---------- 隨機擊球壓力測試 ----------
test('隨機 400 桿：無 NaN、一定停下、不出界、球數守恆', function () {
  const rng = mulberry(42);
  let totalPocketed = 0, longest = 0, scratches = 0;
  for (let game = 0; game < 40; game++) {
    const s = E.newState(0, rng);
    for (let shot = 0; shot < 10; shot++) {
      if (s.balls[0].pocketed) { s.balls[0].pocketed = false; s.balls[0].x = 250; s.balls[0].y = 250; s.ballInHand = false; }
      const a = rng() * Math.PI * 2, v = 100 + rng() * 2100;
      s.ballInHand = false; s.winner = null;
      assert(E.shoot(s, Math.cos(a) * v, Math.sin(a) * v));
      const t = runToRest(s, 40);
      longest = Math.max(longest, t);
      assert(!s.moving, '40 秒內沒有停下 (game ' + game + ' shot ' + shot + ')');
      const sh = s.shot;
      totalPocketed += sh.pocketed.length;
      if (sh.pocketed.indexOf(0) >= 0) scratches++;
      for (const b of s.balls) {
        assert(isFinite(b.x) && isFinite(b.y) && isFinite(b.vx) && isFinite(b.vy), 'NaN');
        if (!b.pocketed) assert(b.x >= 0 && b.x <= E.W && b.y >= 0 && b.y <= E.H, 'out of table');
      }
      for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
        const A = s.balls[i], B = s.balls[j];
        if (A.pocketed || B.pocketed) continue;
        assert(Math.hypot(A.x - B.x, A.y - B.y) > 2 * E.R - 1.5, 'resting overlap');
      }
      s.shot = null; s.events.length = 0;
    }
    assert.strictEqual(s.escapes, 0, 'ball escaped ' + s.escapes);
  }
  console.log('        最長一桿 ' + longest.toFixed(1) + ' 秒，總進球 ' + totalPocketed + '，母球落袋 ' + scratches);
  assert(totalPocketed > 0);
});

// ---------- 決定性：同樣輸入結果一致 ----------
test('決定性：兩份相同狀態跑同一桿，結果位元級一致', function () {
  const a = E.newState(0, mulberry(7)), b = E.newState(0, mulberry(7));
  E.shoot(a, 1800, 130); E.shoot(b, 1800, 130);
  runToRest(a, 40); runToRest(b, 40);
  assert.deepStrictEqual(E.serialize(a), E.serialize(b));
});

// ---------- 物理直覺 ----------
test('正面撞擊：母球把動量傳給目標球', function () {
  const s = E.newState(0, mulberry(1));
  for (const b of s.balls) b.pocketed = true;
  s.balls[0].pocketed = false; s.balls[1].pocketed = false;
  s.balls[0].x = 300; s.balls[0].y = 250; s.balls[1].x = 500; s.balls[1].y = 250;
  E.shoot(s, 600, 0);
  let impact = 0;
  while (s.moving && s.shot.firstHit === null) { impact = s.balls[0].vx; E.step(s, E.STEP); }
  assert.strictEqual(s.shot.firstHit, 1);
  for (let i = 0; i < 20; i++) E.step(s, E.STEP);
  assert(impact > 300 && impact < 600, '撞擊前速度應已被摩擦力略微減速 (' + impact + ')');
  assert(s.balls[1].vx > 0.9 * impact, '目標球應獲得大部分速度 (' + s.balls[1].vx + ' vs ' + impact + ')');
  assert(s.balls[0].vx < 0.1 * impact, '母球應幾乎停住 (' + s.balls[0].vx + ')');
});

test('中袋與角袋都能進球', function () {
  const cases = [
    { x: 500, y: 250, vx: 0, vy: -500 },       // 中袋（上）
    { x: 500, y: 250, vx: 0, vy: 500 },        // 中袋（下）
    { x: 200, y: 200, vx: -400, vy: -400 },    // 左上角
    { x: 800, y: 300, vx: 400, vy: 400 }       // 右下角
  ];
  for (const c of cases) {
    const s = E.newState(0, mulberry(1));
    for (const b of s.balls) b.pocketed = true;
    s.balls[0].pocketed = false; s.balls[0].x = c.x; s.balls[0].y = c.y;
    E.shoot(s, c.vx, c.vy);
    runToRest(s, 20);
    assert(s.balls[0].pocketed, '應該進袋 ' + JSON.stringify(c));
  }
});

test('庫邊反彈：不會穿牆', function () {
  const s = E.newState(0, mulberry(1));
  for (const b of s.balls) b.pocketed = true;
  s.balls[0].pocketed = false; s.balls[0].x = 300; s.balls[0].y = 100;
  E.shoot(s, 700, 0);
  runToRest(s, 20);
  assert(!s.balls[0].pocketed && s.balls[0].x <= E.W - E.R + 1e-6);
});

// ---------- 規則 ----------
function bare(turn) {
  const s = E.newState(turn || 0, mulberry(3));
  s.shot = { player: s.turn, firstHit: null, pocketed: [], cleared: false };
  s.moving = true;
  return s;
}

test('開球階段進球 → 指定花色並續打', function () {
  const s = bare(0);
  s.shot.firstHit = 3; s.shot.pocketed = [3];
  s.balls[3].pocketed = true;
  const m = E.finishShot(s);
  assert.strictEqual(s.groups[0], 'solid'); assert.strictEqual(s.groups[1], 'stripe');
  assert.strictEqual(s.turn, 0); assert(!m.foul);
});

test('沒進球 → 換人', function () {
  const s = bare(0);
  s.shot.firstHit = 3;
  E.finishShot(s);
  assert.strictEqual(s.turn, 1); assert(!s.ballInHand);
});

test('母球落袋 → 犯規、對手自由球', function () {
  const s = bare(0);
  s.shot.firstHit = 3; s.shot.pocketed = [0];
  s.balls[0].pocketed = true;
  const m = E.finishShot(s);
  assert(m.foul); assert.strictEqual(s.turn, 1); assert(s.ballInHand);
  assert.deepStrictEqual(m.reasons, ['scratch']);
});

test('沒打到任何球 → 犯規', function () {
  const s = bare(0);
  const m = E.finishShot(s);
  assert(m.foul && m.reasons.indexOf('nohit') >= 0 && s.ballInHand);
});

test('已分組後先碰到對手球 → 犯規', function () {
  const s = bare(0);
  s.groups = ['solid', 'stripe'];
  s.shot.firstHit = 10;
  const m = E.finishShot(s);
  assert(m.foul && m.reasons.indexOf('wrongfirst') >= 0);
});

test('已分組後先碰 8 號但自己還有球 → 犯規', function () {
  const s = bare(0);
  s.groups = ['solid', 'stripe'];
  s.shot.firstHit = 8;
  assert(E.finishShot(s).foul);
});

test('開球階段 8 號球落袋 → 放回，不判負', function () {
  const s = bare(0);
  s.shot.firstHit = 1; s.shot.pocketed = [8];
  s.balls[8].pocketed = true;
  const m = E.finishShot(s);
  assert.strictEqual(s.winner, null); assert(m.respot); assert(!s.balls[8].pocketed);
});

test('太早打進 8 號球 → 判負', function () {
  const s = bare(0);
  s.groups = ['solid', 'stripe'];
  s.shot.firstHit = 1; s.shot.pocketed = [8];
  s.balls[8].pocketed = true;
  E.finishShot(s);
  assert.strictEqual(s.winner, 1);
});

test('清完自己的球後打進 8 號 → 獲勝', function () {
  const s = bare(0);
  s.groups = ['solid', 'stripe'];
  for (let i = 1; i <= 7; i++) s.balls[i].pocketed = true;
  s.shot.cleared = E.playerCleared(s, 0);
  assert(s.shot.cleared);
  s.shot.firstHit = 8; s.shot.pocketed = [8];
  s.balls[8].pocketed = true;
  const m = E.finishShot(s);
  assert.strictEqual(s.winner, 0); assert.strictEqual(m.end, 'win8');
});

test('打進 8 號同時母球落袋 → 判負', function () {
  const s = bare(0);
  s.groups = ['solid', 'stripe'];
  for (let i = 1; i <= 7; i++) s.balls[i].pocketed = true;
  s.shot.cleared = true; s.shot.firstHit = 8; s.shot.pocketed = [8, 0];
  s.balls[8].pocketed = true; s.balls[0].pocketed = true;
  E.finishShot(s);
  assert.strictEqual(s.winner, 1);
});

test('自由球擺放：不能壓到別的球', function () {
  const s = E.newState(0, mulberry(3));
  s.ballInHand = true; s.balls[0].pocketed = true;
  const b1 = s.balls[1];
  assert(!E.placeCue(s, b1.x + 5, b1.y));
  assert(E.placeCue(s, 150, 150));
  assert(!s.ballInHand && !s.balls[0].pocketed);
});

// ---------- 雙人連線同步（用記憶體管線模擬網路） ----------
test('房主 + 挑戰者：同步開局、輪流擊球、結果一致', function () {
  const toGuest = [], toHost = [];
  const host = new Session(E, 'host', function (m) { toGuest.push(JSON.parse(JSON.stringify(m))); }, {});
  const guest = new Session(E, 'guest', function (m) { toHost.push(JSON.parse(JSON.stringify(m))); }, {});
  function pump() {
    let moved = true;
    while (moved) {
      moved = false;
      while (toGuest.length) { guest.receive(toGuest.shift()); moved = true; }
      while (toHost.length) { host.receive(toHost.shift()); moved = true; }
    }
  }
  function frames(n) { for (let i = 0; i < n; i++) { host.update(1 / 60); guest.update(1 / 60); pump(); } }

  host.startGame(0); pump();
  assert(guest.ready);
  assert.deepStrictEqual(E.serialize(guest.state), E.serialize(host.state));
  assert(host.canAct() && !guest.canAct());

  const rng = mulberry(99);
  let shots = 0, placed = 0;
  for (let i = 0; i < 60 && host.state.winner === null; i++) {
    const actor = host.state.turn === 0 ? host : guest;
    if (actor.state.ballInHand) {
      assert(actor.tryPlace(100 + rng() * 150, 60 + rng() * 380) || actor.tryPlace(60, 60));
      placed++; pump();
    }
    const a = rng() * Math.PI * 2, v = 300 + rng() * 1800;
    assert(actor.tryShoot(Math.cos(a) * v, Math.sin(a) * v), '應可擊球');
    assert(!actor.canAct());
    shots++;
    pump();
    frames(60 * 45);
    assert(!host.state.moving && !guest.state.moving);
    assert(!guest.awaiting, '挑戰者應已收到結算');
    assert.deepStrictEqual(E.serialize(guest.state), E.serialize(host.state), '第 ' + shots + ' 桿後盤面不一致');
    assert.strictEqual(guest.canAct(), host.state.turn === 1 && host.state.winner === null);
  }
  console.log('        同步 ' + shots + ' 桿（自由球 ' + placed + ' 次），勝者 = ' + host.state.winner);
});

test('作弊防護：挑戰者在對方回合出桿會被房主拒絕並重新同步', function () {
  const toGuest = [];
  const host = new Session(E, 'host', function (m) { toGuest.push(m); }, {});
  host.startGame(0); toGuest.length = 0;
  host.receive({ t: 'shot', vx: 1000, vy: 0 });      // 現在是房主回合
  assert(!host.state.moving);
  assert(toGuest.some(function (m) { return m.t === 'sync'; }));
  host.receive({ t: 'shot', vx: NaN, vy: 'x' });
  host.receive(null); host.receive({ t: 5 }); host.receive({ t: 'sync', s: {} });
  assert(!host.state.moving);
});

test('壞掉的快照會被挑戰者忽略', function () {
  const guest = new Session(E, 'guest', function () {}, {});
  guest.receive({ t: 'sync', init: true, s: { b: [], turn: 0 } });
  assert(!guest.ready);
  guest.receive({ t: 'sync', init: true, s: { b: new Array(16).fill([1e9, 0, 0]), turn: 0, groups: [null, null], bih: false, win: null } });
  assert(!guest.ready);
});

console.log('\n' + passed + ' 項測試全部通過');
