/* duplex-rx.js —— 电脑端：听手机的超声状态包，反过来调 cimbar 的播放参数
 *
 * 三条作用：
 *   1. 手机收齐了 → 立刻停机，不用把整轮播完
 *   2. 手机读不出（反光/失焦/太远）→ 降帧率换稳定性；读得爽就提速
 *   3. 把手机锁定的 mode 显示出来，让你在开播前对齐（不自动改，避免打断正在传的流）
 *
 * 回退：连续 12 秒收不到有效包 → 判定双向失联，停止下发任何控制，
 *       回到 cimbar 原生的单向喷泉模式继续跑（它本来就不依赖反馈）。
 */
(function (root) {
  'use strict';

  var SILENCE_MS = 12000;
  // 映射以 main.js 的 setMode 为准：4C→4，Bu→66（micro），Bm→67（mini），其余→68
  var MODE_NAME = { 0: '自动', 4: '4C', 66: 'Bu(micro)', 67: 'Bm(mini)', 68: 'B' };
  var MODE_TO_STR = { 4: '4C', 66: 'Bu', 67: 'Bm', 68: 'B' };

  var st = {
    on: false, ctx: null, stream: null, proc: null, mute: null, src: null,
    decoder: null, target: null,           // target() 返回 iframe 的 window
    packets: 0, badPackets: 0, lastGoodAt: 0, lastStatus: null,
    fallback: false, level: 0, peak: 0, curFps: 15, modeApplied: false,
    log: []
  };

  function log(msg) {
    st.log.push(msg);
    if (st.log.length > 40) st.log.shift();
    if (root.DuplexLog) try { root.DuplexLog(msg); } catch (e) { }
    console.log('[duplex-rx] ' + msg);
  }

  function ui() {
    if (root.DuplexUI) try { root.DuplexUI(); } catch (e) { }
  }

  function targetWin() {
    try { return st.target && st.target(); } catch (e) { return null; }
  }

  function callMain(fn, arg) {
    var w = targetWin();
    if (!w || !w.Main || typeof w.Main[fn] !== 'function') return false;
    try { w.Main[fn](arg); return true; } catch (e) { log('调用 Main.' + fn + ' 失败：' + e.message); return false; }
  }

  /* ---------- 应用一条状态 ---------- */
  function apply(status) {
    var now = performance.now();
    st.lastGoodAt = now;
    st.lastStatus = status;
    st.packets++;
    if (st.fallback) { st.fallback = false; log('双向恢复'); }

    // 1) 收齐 → 停机
    if (status.done) {
      var w = targetWin();
      var paused = false;
      try { paused = !!(w && w.Main && w.Main.isPaused && w.Main.isPaused()); } catch (e) { }
      if (!paused && callMain('togglePause', true)) log('手机已收齐 → 停止播放');
      ui();
      return;
    }

    // 2) 帧率自适应（这是唯一能在传输中途安全调整的旋钮；
    //    改 mode 会让喷泉流的身份变掉，正在收的块可能作废，所以不自动改）
    if (status.fps >= 5 && status.fps <= 20 && status.fps !== st.curFps) {
      if (status.down || status.up) {
        if (callMain('setFPS', status.fps)) {
          log('帧率 ' + st.curFps + ' → ' + status.fps + '（' +
            (status.down ? '手机读不动，放慢' : '手机读得爽，提速') + '）');
          st.curFps = status.fps;
        }
      }
    }
    ui();
  }

  /* ---------- 手动对齐 mode（开播前用） ---------- */
  function applyModeFromPhone() {
    var w = targetWin();
    if (!w || !w.Main) { log('编码页还没就绪'); return false; }
    var s = st.lastStatus;
    if (!s) { log('还没收到手机状态'); return false; }
    if (!MODE_TO_STR[s.mode]) { log('手机报的 mode ' + s.mode + ' 认不出'); return false; }

    var paused = true;
    try { paused = !!(w.Main.isPaused && w.Main.isPaused()); } catch (e) { }
    if (!paused) {
      log('正在播放中，不改 mode（会打断喷泉流）。先暂停再改');
      return false;
    }
    var ok = callMain('setMode', MODE_TO_STR[s.mode]);
    if (ok) { st.modeApplied = true; log('已把编码 mode 对齐为 ' + MODE_TO_STR[s.mode]); }
    ui();
    return ok;
  }

  /* ---------- 麦克风 ---------- */
  async function start(target) {
    if (st.on) return true;
    if (!target) { log('没有可控制的编码页'); return false; }
    st.target = target;
    try {
      st.ctx = Duplex.makeCtx();
      if (st.ctx.state === 'suspended') await st.ctx.resume();
      st.stream = await Duplex.openMic();
    } catch (e) {
      log('麦克风失败：' + e.message);
      return false;
    }

    st.decoder = new Duplex.StreamDecoder(st.ctx.sampleRate);
    st.decoder.onPacket = function (payload) {
      var s = Duplex.unpackStatus(payload);
      if (!s) { st.badPackets++; return; }
      apply(s);
    };
    st.decoder.onError = function (why) { st.badPackets++; };

    st.src = st.ctx.createMediaStreamSource(st.stream);
    st.proc = st.ctx.createScriptProcessor(2048, 1, 1);
    st.proc.onaudioprocess = function (e) {
      var d = e.inputBuffer.getChannelData(0);
      var sum = 0, pk = 0;
      for (var i = 0; i < d.length; i++) { var v = d[i]; sum += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); }
      st.level = Math.sqrt(sum / d.length);
      if (pk > st.peak) st.peak = pk;
      st.decoder.push(Float32Array.from(d));
    };
    st.mute = st.ctx.createGain();
    st.mute.gain.value = 0;
    st.src.connect(st.proc);
    st.proc.connect(st.mute);
    st.mute.connect(st.ctx.destination);   // 必须接输出才会被驱动，增益置 0 静音

    st.on = true;
    st.lastGoodAt = performance.now();
    log('已开启：' + Duplex.bitrate() + ' bps · 采样率 ' + st.ctx.sampleRate +
      ' · 单包 ' + Duplex.packetDuration(5, st.ctx.sampleRate).toFixed(2) + ' 秒');

    watchdog();
    ui();
    return true;
  }

  function stop() {
    st.on = false;
    try { st.proc && st.proc.disconnect(); } catch (e) { }
    try { st.src && st.src.disconnect(); } catch (e) { }
    try { st.mute && st.mute.disconnect(); } catch (e) { }
    try { st.stream && st.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
    log('已关闭');
    ui();
  }

  /* ---------- 看门狗：超时就回退到纯单向 ---------- */
  function watchdog() {
    setTimeout(function () {
      if (!st.on) return;
      var dt = performance.now() - st.lastGoodAt;
      if (dt > SILENCE_MS && !st.fallback) {
        st.fallback = true;
        st.curFps = 15;
        log('连续 ' + Math.round(dt / 1000) + ' 秒没收到有效包 → 回退纯 cimbar 单向模式（喷泉码自己会兜住）');
        ui();
      }
      watchdog();
    }, 1500);
  }

  root.DuplexRx = {
    start: start, stop: stop, applyModeFromPhone: applyModeFromPhone,
    state: st,
    modeName: function (m) { return MODE_NAME[m] || ('?' + m); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
