/*
 * engine.js — 8 號球物理與規則引擎（不依賴 DOM，可在瀏覽器與 Node 使用）
 *
 * 座標系：球桌可打區域為 (0,0) ~ (W,H)，球心被限制在距離庫邊 R 的範圍內。
 * 模擬只使用 + - * / 與 sqrt（IEEE 754 保證結果一致），
 * 所以雙方用相同輸入模擬會得到（幾乎）相同結果；最終仍以房主的結果為準。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PoolEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 常數 ----------
  const W = 1000, H = 500, R = 12;
  const STEP = 1 / 480;            // 固定時間步長（秒）
  const MAXV = 2200;               // 母球最大初速
  const FRIC_A = 60, FRIC_B = 0.5; // 滾動阻力：dv/dt = -(A + B*v)
  const STOP_V = 8;                // 低於此速度視為停止
  const E_BALL = 0.96, E_RAIL = 0.8, E_JAW = 0.6;
  const CG = 38;                   // 角袋開口（沿庫邊）
  const SG = 30;                   // 中袋開口半寬
  const RACK_X = 700, RDX = Math.sqrt(3) * R + 0.3, RDY = 2 * R + 0.2;

  const POCKETS = [
    { x: 0, y: 0, r: 29 }, { x: W / 2, y: -4, r: 22 }, { x: W, y: 0, r: 29 },
    { x: 0, y: H, r: 29 }, { x: W / 2, y: H + 4, r: 22 }, { x: W, y: H, r: 29 }
  ];
  // 袋口兩側的「庫角」，球碰到會彈開
  const JAWS = [
    { x: CG, y: 0 }, { x: W / 2 - SG, y: 0 }, { x: W / 2 + SG, y: 0 }, { x: W - CG, y: 0 },
    { x: CG, y: H }, { x: W / 2 - SG, y: H }, { x: W / 2 + SG, y: H }, { x: W - CG, y: H },
    { x: 0, y: CG }, { x: 0, y: H - CG }, { x: W, y: CG }, { x: W, y: H - CG }
  ];

  function groupOf(id) {
    return id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe';
  }

  // ---------- 狀態 ----------
  function newBall(id, x, y) {
    return { id: id, x: x, y: y, vx: 0, vy: 0, pocketed: false };
  }

  function newState(firstTurn, rng) {
    rng = rng || Math.random;
    const solids = [1, 2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
    shuffle(solids, rng); shuffle(stripes, rng);
    const slots = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c <= r; c++) slots.push([r, c]);
    // 8 號球放正中央（索引 4）；最後一排兩個角落一色一花
    const layout = new Array(15);
    layout[4] = 8;
    const cornerSolidFirst = rng() < 0.5;
    layout[10] = cornerSolidFirst ? solids.pop() : stripes.pop();
    layout[14] = cornerSolidFirst ? stripes.pop() : solids.pop();
    const rest = solids.concat(stripes);
    shuffle(rest, rng);
    for (let i = 0; i < 15; i++) if (layout[i] === undefined) layout[i] = rest.pop();

    const balls = new Array(16);
    balls[0] = newBall(0, 250, H / 2);
    for (let i = 0; i < 15; i++) {
      const r = slots[i][0], c = slots[i][1];
      const id = layout[i];
      balls[id] = newBall(id, RACK_X + r * RDX, H / 2 + (c - r / 2) * RDY);
    }
    return {
      balls: balls, turn: firstTurn === 1 ? 1 : 0, groups: [null, null],
      ballInHand: false, winner: null, message: null,
      moving: false, shot: null, events: [], escapes: 0
    };
  }

  function shuffle(a, rng) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
  }

  function playerCleared(state, p) {
    const g = state.groups[p];
    if (!g) return false;
    for (let i = 1; i < 16; i++) {
      const b = state.balls[i];
      if (groupOf(i) === g && !b.pocketed) return false;
    }
    return true;
  }

  // ---------- 擊球 ----------
  function shoot(state, vx, vy) {
    if (state.moving || state.winner !== null || state.ballInHand) return null;
    if (typeof vx !== 'number' || typeof vy !== 'number') return null;
    let s = Math.sqrt(vx * vx + vy * vy);
    if (!(s > 0) || !isFinite(s)) return null;
    if (s > MAXV) { vx = vx * (MAXV / s); vy = vy * (MAXV / s); }
    const cue = state.balls[0];
    if (cue.pocketed) return null;
    cue.vx = vx; cue.vy = vy;
    const p = state.turn;
    state.shot = { player: p, firstHit: null, pocketed: [], cleared: playerCleared(state, p) };
    state.moving = true;
    return { vx: vx, vy: vy };
  }

  function pushEvent(state, type, v) {
    if (state.events.length < 64) state.events.push({ type: type, v: v });
  }

  // ---------- 物理步進 ----------
  function step(state, dt) {
    const balls = state.balls;
    const D2 = 4 * R * R;
    let i, j, b;

    // 位置積分 + 摩擦
    for (i = 0; i < 16; i++) {
      b = balls[i];
      if (b.pocketed) continue;
      if (b.vx !== 0 || b.vy !== 0) {
        b.x += b.vx * dt; b.y += b.vy * dt;
        const s = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        const ns = s - (FRIC_A + FRIC_B * s) * dt;
        if (ns < STOP_V) { b.vx = 0; b.vy = 0; }
        else { const k = ns / s; b.vx *= k; b.vy *= k; }
      }
    }

    // 球與球碰撞（兩輪提高疊球時的穩定度）
    for (let pass = 0; pass < 2; pass++) {
      for (i = 0; i < 16; i++) {
        const a = balls[i];
        if (a.pocketed) continue;
        for (j = i + 1; j < 16; j++) {
          const c = balls[j];
          if (c.pocketed) continue;
          const dx = c.x - a.x, dy = c.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= D2) continue;
          let nx, ny, d;
          if (d2 < 1e-9) { nx = 1; ny = 0; d = 0; }
          else { d = Math.sqrt(d2); nx = dx / d; ny = dy / d; }
          const ov = (2 * R - d) / 2;
          a.x -= nx * ov; a.y -= ny * ov;
          c.x += nx * ov; c.y += ny * ov;
          const vrel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
          if (vrel > 0) {
            const imp = (1 + E_BALL) / 2 * vrel;
            a.vx -= imp * nx; a.vy -= imp * ny;
            c.vx += imp * nx; c.vy += imp * ny;
            if (pass === 0) {
              pushEvent(state, 'ball', vrel);
              if (state.shot && state.shot.firstHit === null) {
                if (i === 0) state.shot.firstHit = j;
                else if (j === 0) state.shot.firstHit = i;
              }
            }
          }
        }
      }
    }

    // 庫邊、庫角、袋口
    for (i = 0; i < 16; i++) {
      b = balls[i];
      if (b.pocketed) continue;
      const x = b.x, y = b.y;
      const onTB = (x > CG && x < W / 2 - SG) || (x > W / 2 + SG && x < W - CG);
      const onLR = y > CG && y < H - CG;
      if (onTB) {
        if (y < R) { b.y = R; if (b.vy < 0) { pushEvent(state, 'rail', -b.vy); b.vy = -b.vy * E_RAIL; } }
        else if (y > H - R) { b.y = H - R; if (b.vy > 0) { pushEvent(state, 'rail', b.vy); b.vy = -b.vy * E_RAIL; } }
      }
      if (onLR) {
        if (x < R) { b.x = R; if (b.vx < 0) { pushEvent(state, 'rail', -b.vx); b.vx = -b.vx * E_RAIL; } }
        else if (x > W - R) { b.x = W - R; if (b.vx > 0) { pushEvent(state, 'rail', b.vx); b.vx = -b.vx * E_RAIL; } }
      }
      for (j = 0; j < JAWS.length; j++) {
        const jw = JAWS[j];
        const dx = b.x - jw.x, dy = b.y - jw.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R * R || d2 < 1e-9) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        b.x = jw.x + nx * R; b.y = jw.y + ny * R;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= (1 + E_JAW) * vn * nx; b.vy -= (1 + E_JAW) * vn * ny;
          pushEvent(state, 'rail', -vn);
        }
      }
      // 袋口
      for (j = 0; j < 6; j++) {
        const pk = POCKETS[j];
        const dx = b.x - pk.x, dy = b.y - pk.y;
        if (dx * dx + dy * dy < pk.r * pk.r) {
          b.pocketed = true; b.vx = 0; b.vy = 0;
          if (state.shot) state.shot.pocketed.push(b.id);
          pushEvent(state, 'pocket', 1);
          break;
        }
      }
      // 保險：理論上不會跑出球桌，萬一發生就拉回來並記錄
      if (!b.pocketed && (b.x < 0 || b.x > W || b.y < 0 || b.y > H)) {
        state.escapes++;
        b.x = Math.min(W - R, Math.max(R, b.x));
        b.y = Math.min(H - R, Math.max(R, b.y));
        b.vx = 0; b.vy = 0;
      }
    }

    let any = false;
    for (i = 0; i < 16; i++) {
      b = balls[i];
      if (!b.pocketed && (b.vx !== 0 || b.vy !== 0)) { any = true; break; }
    }
    state.moving = any;
    return any;
  }

  // ---------- 母球擺放 ----------
  function canPlace(state, x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return false;
    if (x < R + 1 || x > W - R - 1 || y < R + 1 || y > H - R - 1) return false;
    for (let i = 1; i < 16; i++) {
      const b = state.balls[i];
      if (b.pocketed) continue;
      const dx = b.x - x, dy = b.y - y;
      if (dx * dx + dy * dy < (2 * R + 0.5) * (2 * R + 0.5)) return false;
    }
    return true;
  }

  function placeCue(state, x, y) {
    if (!state.ballInHand || state.moving || state.winner !== null) return false;
    if (!canPlace(state, x, y)) return false;
    const c = state.balls[0];
    c.x = x; c.y = y; c.vx = 0; c.vy = 0; c.pocketed = false;
    state.ballInHand = false;
    return true;
  }

  function respot8(state) {
    const b = state.balls[8];
    const baseX = RACK_X + 2 * RDX;
    for (let k = 0; k < 40; k++) {
      const x = baseX + k * (2 * R + 1);
      if (x > W - R - 2) break;
      b.x = x; b.y = H / 2; b.pocketed = false; b.vx = b.vy = 0;
      let ok = true;
      for (let i = 0; i < 16 && ok; i++) {
        if (i === 8 || state.balls[i].pocketed) continue;
        const dx = state.balls[i].x - x, dy = state.balls[i].y - H / 2;
        if (dx * dx + dy * dy < 4 * R * R) ok = false;
      }
      if (ok) return;
    }
    // 找不到位置（極端情況）：放在開球線上
    b.x = 250; b.y = H / 2 + 60; b.pocketed = false;
  }

  // ---------- 規則判定 ----------
  function finishShot(state) {
    const sh = state.shot;
    const p = sh.player, o = 1 - p;
    const open = state.groups[0] === null;
    const reasons = [];
    const scratched = sh.pocketed.indexOf(0) >= 0;
    let objs = sh.pocketed.filter(function (id) { return id !== 0; });

    if (scratched) reasons.push('scratch');
    if (sh.firstHit === null) reasons.push('nohit');
    else if (open) { if (sh.firstHit === 8) reasons.push('wrongfirst'); }
    else if (sh.cleared) { if (sh.firstHit !== 8) reasons.push('wrongfirst'); }
    else if (groupOf(sh.firstHit) !== state.groups[p]) reasons.push('wrongfirst');

    const foul = reasons.length > 0;
    const msg = { p: p, foul: foul, reasons: reasons, potted: objs.slice(), win: false, end: null, assigned: null, respot: false };
    state.shot = null;
    state.moving = false;

    if (objs.indexOf(8) >= 0) {
      if (open) {                       // 開球階段 8 號球落袋：放回
        respot8(state);
        objs = objs.filter(function (id) { return id !== 8; });
        msg.potted = objs.slice();
        msg.respot = true;
      } else {
        const legal = sh.cleared && !foul;
        state.winner = legal ? p : o;
        msg.win = true;
        msg.end = legal ? 'win8' : (sh.cleared ? 'foul8' : 'early8');
        state.message = msg;
        return msg;
      }
    }

    if (open && !foul && objs.length > 0) {
      const g = groupOf(objs[0]);
      state.groups[p] = g;
      state.groups[o] = g === 'solid' ? 'stripe' : 'solid';
      msg.assigned = g;
    }

    let keep = false;
    if (!foul) {
      const g = state.groups[p];
      if (g) keep = objs.some(function (id) { return groupOf(id) === g; });
    }

    if (foul) {
      state.turn = o;
      state.ballInHand = true;
      const cue = state.balls[0];
      cue.pocketed = true; cue.vx = 0; cue.vy = 0;
    } else if (!keep) {
      state.turn = o;
    }
    state.message = msg;
    return msg;
  }

  // ---------- 瞄準輔助 ----------
  // 從 (x,y) 沿單位向量 (dx,dy) 發射，回傳第一個碰撞點
  function aim(state, x, y, dx, dy) {
    let bestT = Infinity, hit = null;
    for (let i = 1; i < 16; i++) {
      const b = state.balls[i];
      if (b.pocketed) continue;
      const cx = b.x - x, cy = b.y - y;
      const proj = cx * dx + cy * dy;
      if (proj <= 0) continue;
      const c2 = cx * cx + cy * cy;
      const disc = proj * proj - (c2 - 4 * R * R);
      if (disc < 0) continue;
      const t = proj - Math.sqrt(disc);
      if (t > 0 && t < bestT) { bestT = t; hit = b; }
    }
    let wallT = Infinity;
    if (dx > 0) wallT = Math.min(wallT, (W - R - x) / dx);
    else if (dx < 0) wallT = Math.min(wallT, (R - x) / dx);
    if (dy > 0) wallT = Math.min(wallT, (H - R - y) / dy);
    else if (dy < 0) wallT = Math.min(wallT, (R - y) / dy);
    if (wallT < 0) wallT = 0;
    if (hit && bestT <= wallT) {
      const gx = x + dx * bestT, gy = y + dy * bestT;
      let nx = hit.x - gx, ny = hit.y - gy;
      const nl = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= nl; ny /= nl;
      let ox = dx - (dx * nx + dy * ny) * nx, oy = dy - (dx * nx + dy * ny) * ny;
      const ol = Math.sqrt(ox * ox + oy * oy);
      if (ol > 1e-6) { ox /= ol; oy /= ol; } else { ox = 0; oy = 0; }
      return { t: bestT, ballId: hit.id, gx: gx, gy: gy, tx: nx, ty: ny, ox: ox, oy: oy };
    }
    return { t: wallT, ballId: null, gx: x + dx * wallT, gy: y + dy * wallT };
  }

  // ---------- 序列化（網路同步用） ----------
  function serialize(state) {
    return {
      b: state.balls.map(function (b) { return [b.x, b.y, b.pocketed ? 1 : 0]; }),
      turn: state.turn, groups: state.groups.slice(),
      bih: state.ballInHand, win: state.winner, msg: state.message
    };
  }

  function sanitizeMsg(m) {
    if (!m || typeof m !== 'object') return null;
    const ids = function (a) {
      return Array.isArray(a) ? a.filter(function (n) { return Number.isInteger(n) && n >= 0 && n <= 15; }).slice(0, 15) : [];
    };
    return {
      p: m.p === 1 ? 1 : 0,
      foul: !!m.foul,
      reasons: Array.isArray(m.reasons)
        ? m.reasons.filter(function (r) { return r === 'scratch' || r === 'nohit' || r === 'wrongfirst'; }) : [],
      potted: ids(m.potted),
      win: !!m.win,
      end: (m.end === 'win8' || m.end === 'early8' || m.end === 'foul8') ? m.end : null,
      assigned: (m.assigned === 'solid' || m.assigned === 'stripe') ? m.assigned : null,
      respot: !!m.respot
    };
  }

  function validSnapshot(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.b) || s.b.length !== 16) return false;
    for (let i = 0; i < 16; i++) {
      const e = s.b[i];
      if (!Array.isArray(e) || e.length !== 3) return false;
      if (typeof e[0] !== 'number' || typeof e[1] !== 'number' || !isFinite(e[0]) || !isFinite(e[1])) return false;
      if (e[0] < -50 || e[0] > W + 50 || e[1] < -50 || e[1] > H + 50) return false;
    }
    if (s.turn !== 0 && s.turn !== 1) return false;
    if (!Array.isArray(s.groups) || s.groups.length !== 2) return false;
    for (let k = 0; k < 2; k++) {
      const g = s.groups[k];
      if (g !== null && g !== 'solid' && g !== 'stripe') return false;
    }
    if (typeof s.bih !== 'boolean') return false;
    if (s.win !== null && s.win !== 0 && s.win !== 1) return false;
    return true;
  }

  function applySnapshot(state, s) {
    for (let i = 0; i < 16; i++) {
      const b = state.balls[i];
      b.x = s.b[i][0]; b.y = s.b[i][1]; b.pocketed = !!s.b[i][2]; b.vx = 0; b.vy = 0;
    }
    state.turn = s.turn; state.groups = s.groups.slice();
    state.ballInHand = s.bih; state.winner = s.win;
    state.message = sanitizeMsg(s.msg);
    state.moving = false; state.shot = null;
  }

  return {
    W: W, H: H, R: R, STEP: STEP, MAXV: MAXV, POCKETS: POCKETS, JAWS: JAWS, CG: CG, SG: SG,
    groupOf: groupOf, newState: newState, shoot: shoot, step: step, finishShot: finishShot,
    canPlace: canPlace, placeCue: placeCue, aim: aim, playerCleared: playerCleared,
    serialize: serialize, applySnapshot: applySnapshot, validSnapshot: validSnapshot
  };
});
