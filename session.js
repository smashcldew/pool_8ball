/*
 * session.js — 對戰流程與網路同步（不依賴 DOM / PeerJS，可在 Node 測試）
 *
 * 角色：
 *   host  = 房主，玩家 0，負責規則判定，是最終權威
 *   guest = 挑戰者，玩家 1
 *   local = 同一台電腦兩人輪流
 *
 * 訊息（皆為純 JSON）：
 *   {t:'sync', init?:true, s:snapshot}  房主 → 挑戰者：完整盤面（開局 / 每桿結算後）
 *   {t:'shot', vx, vy}                  出桿者 → 對方：擊球速度，雙方各自模擬動畫
 *   {t:'place', x, y}                   出桿者 → 對方：擺放母球
 *   {t:'rematch'}                       挑戰者 → 房主：再來一局
 *   {t:'ping'}                          心跳
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PoolSession = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function Session(E, role, send, hooks) {
    this.E = E;
    this.role = role;                       // 'host' | 'guest' | 'local'
    this.my = role === 'host' ? 0 : role === 'guest' ? 1 : null;
    this.send = send || function () {};
    this.hooks = hooks || {};
    this.state = E.newState(0);
    this.ready = false;                     // 挑戰者：收到第一個 init 後才為 true
    this.acc = 0;
    this.pending = null;                    // 動畫尚未結束時先收到的結算
    this.awaiting = false;                  // 挑戰者動畫結束，等房主結算
    this.rematch = [false, false];
    this.nextFirst = 0;
  }

  Session.prototype._hook = function (name, a) {
    if (typeof this.hooks[name] === 'function') this.hooks[name](a);
  };

  // 開新局（房主 / 本機）
  Session.prototype.startGame = function (firstTurn) {
    this.state = this.E.newState(firstTurn);
    this.ready = true; this.pending = null; this.awaiting = false; this.acc = 0;
    this.rematch = [false, false];
    this.nextFirst = 1 - firstTurn;
    this.send({ t: 'sync', init: true, s: this.E.serialize(this.state) });
    this._hook('onInit');
  };

  Session.prototype.canAct = function () {
    const s = this.state;
    return this.ready && s.winner === null && !s.moving && !this.awaiting &&
      (this.my === null || s.turn === this.my);
  };

  Session.prototype.tryShoot = function (vx, vy) {
    if (!this.canAct() || this.state.winner !== null) return false;
    const r = this.E.shoot(this.state, vx, vy);
    if (!r) return false;
    this.send({ t: 'shot', vx: r.vx, vy: r.vy });
    return true;
  };

  Session.prototype.tryPlace = function (x, y) {
    if (!this.canAct()) return false;
    if (!this.E.placeCue(this.state, x, y)) return false;
    this.send({ t: 'place', x: x, y: y });
    this._hook('onSync');
    return true;
  };

  Session.prototype.requestRematch = function () {
    if (this.state.winner === null) return;
    if (this.role === 'local') { this.startGame(this.nextFirst); return; }
    if (this.role === 'host') { this.rematch[0] = true; this._maybeRestart(); }
    else this.send({ t: 'rematch' });
  };

  Session.prototype._maybeRestart = function () {
    if (this.rematch[0] && this.rematch[1]) this.startGame(this.nextFirst);
    else this._hook('onSync');
  };

  // 收到對方訊息
  Session.prototype.receive = function (msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const E = this.E, s = this.state;
    const opp = this.role === 'host' ? 1 : 0;       // 對方的玩家編號

    switch (msg.t) {
      case 'sync':
        if (this.role !== 'guest' || !E.validSnapshot(msg.s)) return;
        if (msg.init === true) {
          this.state = E.newState(0);
          E.applySnapshot(this.state, msg.s);
          this.ready = true; this.pending = null; this.awaiting = false; this.acc = 0;
          this.rematch = [false, false];
          this._hook('onInit');
        } else if (s.moving) {
          this.pending = msg.s;
        } else {
          E.applySnapshot(s, msg.s);
          this.awaiting = false;
          this._hook('onShotEnd', s.message);
        }
        break;

      case 'shot':
        if (this.role === 'local' || !this.ready) return;
        if (s.turn !== opp || s.moving || s.winner !== null || s.ballInHand) { this._resync(); return; }
        if (!E.shoot(s, msg.vx, msg.vy)) this._resync();
        break;

      case 'place':
        if (this.role === 'local' || !this.ready) return;
        if (s.turn !== opp || s.moving || !s.ballInHand || !E.placeCue(s, msg.x, msg.y)) { this._resync(); return; }
        this._hook('onSync');
        break;

      case 'rematch':
        if (this.role !== 'host' || s.winner === null) return;
        this.rematch[1] = true;
        this._maybeRestart();
        break;
    }
  };

  // 房主偵測到對方做了不合法的動作：把正確盤面再送一次
  Session.prototype._resync = function () {
    if (this.role === 'host' && !this.state.moving) {
      this.send({ t: 'sync', s: this.E.serialize(this.state) });
    }
  };

  // 每個畫格呼叫一次；dt 為真實經過的秒數
  Session.prototype.update = function (dt) {
    const s = this.state, E = this.E;
    if (!s.moving) return;
    this.acc += Math.min(dt, 0.05);
    while (this.acc >= E.STEP && s.moving) {
      E.step(s, E.STEP);
      this.acc -= E.STEP;
    }
    if (!s.moving) { this.acc = 0; this._onSimEnd(); }
  };

  Session.prototype._onSimEnd = function () {
    const s = this.state, E = this.E;
    if (this.role === 'guest') {
      s.shot = null;
      if (this.pending) {
        E.applySnapshot(s, this.pending);
        this.pending = null;
        this._hook('onShotEnd', s.message);
      } else {
        this.awaiting = true;
        this._hook('onAwaiting');
      }
    } else {
      const msg = E.finishShot(s);
      if (this.role === 'host') this.send({ t: 'sync', s: E.serialize(s) });
      this._hook('onShotEnd', msg);
    }
  };

  return { Session: Session };
});
