/* duplex-tx.js —— 手机端：把解码状态用超声回传给电脑
 *
 * 挂载方式：运行时包装 Sink/Recv/Zstd 的现有方法，不改你 recv.js 一行。
 * 上行只发 5 字节状态，不做位图 —— 因为 cimbar 用喷泉码，不需要点名。
 *
 * 关键设计：电脑端只需要知道三件事
 *   1. 我还差几帧（喷泉码的 need）
 *   2. 我现在锁在哪个 mode（省掉 4 个 worker 盲猜）
 *   3. 我这两秒的成败比（决定要不要降帧率换稳定性）
 */
(function (root) {
  'use strict';

  var BASE_GAP = 2600;     // 正常节拍
  var FAST_GAP = 1400;     // 解码持续失败时加快，让电脑尽快介入
  var WINDOW_MS = 2400;    // 统计窗口

  var st = {
    enabled: false,
    ctx: null, tx: null, timer: null,
    winStart: 0, attempts: 0, ok: 0, fail: 0,
    mode: 0, need: 0, done: false,
    packets: 0, lastSent: 0, consecutiveFail: 0,
    hooks: false, started: false
  };

  function log(msg) {
    if (root.DuplexLog) try { root.DuplexLog(msg); } catch (e) { }
    console.log('[duplex-tx] ' + msg);
  }

  /* ---------- 运行时挂钩子 ---------- */
  function installHooks() {
    if (st.hooks) return true;
    if (typeof Sink === 'undefined' || typeof Recv === 'undefined') return false;

    var origDecode = Recv.on_decode;
    Recv.on_decode = function (wid, data) {
      st.attempts++;
      if (data && data.failed_extract) { st.fail++; st.consecutiveFail++; }
      else if (data && data.buff && data.buff.length > 0) { st.ok++; st.consecutiveFail = 0; }
      return origDecode.apply(this, arguments);
    };

    var origMode = Recv.setMode;
    if (origMode) {
      // setMode 既接受数字也接受字符串（'4C'/'B'/'Bm'/'Bu'）。
      // 映射以 main.js 第 275–286 行为准：4C→4，Bu→66，Bm→67，其余→68。
      // 内部自动识别那条路径传的是数字，直接取用；用户手动切换传字符串，按表映射。
      var NAME_TO_MODE = { '4C': 4, 'Bm': 67, 'Bu': 66, 'B': 68, 'Auto': 0 };
      Recv.setMode = function (m) {
        var v = origMode.apply(this, arguments);
        if (typeof m === 'number') st.mode = m;
        else if (typeof m === 'string') st.mode = (m in NAME_TO_MODE) ? NAME_TO_MODE[m] : st.mode;
        return v;
      };
    }

    var origSink = Sink.on_decode;
    Sink.on_decode = function (buff) {
      var r = origSink.apply(this, arguments);
      // 收块之后捞一次报告，尽量把 need 挖出来
      try {
        var rep = Sink.get_report();
        st.need = extractNeed(rep);
      } catch (e) { }
      return r;
    };

    // 文件拼齐时会走 Zstd.decompress（或直接 download），两者都当完成信号
    if (typeof Zstd !== 'undefined' && Zstd.decompress) {
      var origZ = Zstd.decompress;
      Zstd.decompress = function () {
        st.done = true;
        return origZ.apply(this, arguments);
      };
    }
    var origDl = Recv.download_bytes;
    if (origDl) {
      Recv.download_bytes = function () {
        st.done = true;
        return origDl.apply(this, arguments);
      };
    }

    st.hooks = true;
    log('钩子已挂载');
    return true;
  }

  /* 从 get_report 的返回里尽量挖出"还差多少"。
     形状未知，所以做保守递进：优先认名字，认不出来就放弃（当 0）。 */
  function extractNeed(rep) {
    if (rep == null) return 0;
    var KEY = /need|remain|missing|todo/i;
    var found = 0;
    (function walk(o, depth) {
      if (found || depth > 4 || o == null) return;
      if (typeof o === 'number') return;
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i], depth + 1); return; }
      if (typeof o === 'object') {
        for (var k in o) {
          if (typeof o[k] === 'number' && KEY.test(k)) { found = o[k]; return; }
          walk(o[k], depth + 1);
        }
      }
    })(rep, 0);
    return found > 0 && found < 65535 ? Math.round(found) : 0;
  }

  /* ---------- 计算本窗口结论 ---------- */
  function snapshot() {
    var now = performance.now();
    var dt = Math.max(1, now - st.winStart);
    var total = st.attempts;
    var ratio = total > 0 ? st.ok / total : 0;
    var rate = total / (dt / 1000);           // 每秒可解帧数（含失败）
    var down = false, up = false;

    if (total >= 8 && ratio < 0.5) down = true;         // 一半以上读不出 → 让电脑放慢
    else if (total >= 12 && ratio > 0.9) up = true;     // 基本都能读出 → 可以提速

    // 建议帧率：以"每秒成功解出的帧数"为锚，给电脑一个可执行的目标
    var fpsHint = 0;
    if (down) fpsHint = Math.max(5, Math.min(20, Math.floor(st.ok / (dt / 1000) * 1.5)));
    else if (up) fpsHint = Math.max(5, Math.min(20, Math.ceil(st.ok / (dt / 1000) * 1.2)));

    var snap = {
      attempts: total, ok: st.ok, fail: st.fail, ratio: ratio, rate: rate,
      down: down, up: up, fpsHint: fpsHint, need: st.need, mode: st.mode,
      done: st.done, consecutiveFail: st.consecutiveFail
    };

    st.winStart = now; st.attempts = 0; st.ok = 0; st.fail = 0;
    return snap;
  }

  /* ---------- 发送 ---------- */
  function tick() {
    if (!st.enabled) return;
    var s = snapshot();

    var payload = Duplex.packStatus({
      done: s.done, down: s.down, up: s.up,
      mode: s.mode, need: s.need, fps: s.fpsHint
    });

    if (!st.tx) st.tx = new Duplex.Tx(st.ctx);
    if (st.tx.busy) { schedule(BASE_GAP); return; }   // 上一包还在播，别叠加成噪声

    st.tx.send(Duplex.buildPacket(payload));
    st.packets++;
    st.lastSent = performance.now();

    if (root.DuplexUI) try { root.DuplexUI(s, st.packets); } catch (e) { }

    if (s.done) {
      log('已收齐，通知电脑停机');
      schedule(1200, true);        // 再补两遍就收工
      st.exitAfter = (st.exitAfter || 0) + 1;
      if (st.exitAfter >= 2) { stop(); return; }
      return;
    }
    st.exitAfter = 0;

    var gap = (s.down || s.consecutiveFail >= 3) ? FAST_GAP : BASE_GAP;
    schedule(gap);
  }

  function schedule(gap, keep) {
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(tick, gap);
  }

  /* ---------- 生命周期 ---------- */
  async function start() {
    if (st.enabled) return true;
    if (!installHooks()) { log('页面还没就绪（Sink/Recv 未定义）'); return false; }
    try {
      st.ctx = Duplex.makeCtx();
      if (st.ctx.state === 'suspended') await st.ctx.resume();
    } catch (e) { log('AudioContext 失败：' + e.message); return false; }

    if (Math.abs((st.ctx.sampleRate || 0) - Duplex.SR) > 1) {
      log('注意：AudioContext 采样率是 ' + st.ctx.sampleRate + '，不是 48000，高频可能失真');
    }
    st.tx = new Duplex.Tx(st.ctx);
    st.enabled = true;
    st.winStart = performance.now();
    st.attempts = st.ok = st.fail = 0;
    log('双向已开启：' + Duplex.bitrate() + ' bps，单包 ' + Duplex.packetDuration(5, Duplex.SR).toFixed(2) + ' 秒');
    schedule(600);
    return true;
  }

  function stop() {
    st.enabled = false;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    log('双向已关闭');
    if (root.DuplexUI) try { root.DuplexUI(null, st.packets); } catch (e) { }
  }

  async function toggle() {
    if (st.enabled) { stop(); return; }
    var okStart = await start();
    var btn = document.getElementById('duplex-toggle');
    if (btn) btn.textContent = okStart ? '双向：开' : '双向：失败';
  }

  root.DuplexTx = {
    start: start, stop: stop, toggle: toggle,
    state: st,
    stats: function () { return { packets: st.packets, mode: st.mode, need: st.need, done: st.done, enabled: st.enabled }; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
