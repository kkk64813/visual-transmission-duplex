'use strict';
/* 硬件边界 · 扫频探测
 * 只做一件事：把一台设备的「输出上限 / 实测频响 / 输入上限」量成数字。
 * 不依赖任何服务端，不上传数据，全部在本机 Web Audio 里完成。
 */
(function () {

  var $ = function (s) { return document.querySelector(s); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var S = {
    ctx: null, master: null, env: null, osc: null,
    analyser: null, micStream: null, micSrc: null, buf: null,
    micSettings: null,
    sr: 0, nyq: 0,
    running: false, abort: false,
    mode: 'loop',
    amp: 0.6,
    points: [], rel: [], baseFreq: 0,
    measured: false,
    curFreq: 0, peakHz: 0, peakDb: -140,
    raf: 0
  };

  /* ---------------- 小工具 ---------------- */

  function fmtHz(f) {
    if (!isFinite(f)) return '—';
    if (f >= 1000) {
      var k = f / 1000;
      return (k >= 10 ? k.toFixed(1) : k.toFixed(2)) + ' kHz';
    }
    return Math.round(f) + ' Hz';
  }
  function fmtDb(v) { return (v > -900 && isFinite(v)) ? v.toFixed(1) + ' dB' : '—'; }

  var toastTimer = 0;
  function toast(msg, isErr) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }


  function median(list) {
    var a = list.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function smooth(arr, w) {
    w = w || 1;
    var out = arr.slice();
    for (var i = 0; i < arr.length; i++) {
      var s = 0, n = 0;
      for (var k = -w; k <= w; k++) {
        var j = i + k;
        if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
      }
      out[i] = s / n;
    }
    return out;
  }

  function shortUA(ua) {    var m = ua.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/);
    var name = m ? m[0] : ua.slice(0, 40);
    var a = ua.match(/Android\s([\d.]+)/);
    var w = /Windows NT 10/.test(ua) ? 'Windows 10/11'
      : /Windows NT/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'macOS'
      : a ? 'Android ' + a[1]
      : /iPhone|iPad/.test(ua) ? 'iOS'
      : '-';
    return w + ' · ' + name;
  }

  /* ---------------- ① 环境自检 ---------------- */

  function renderEnv(rows) {
    $('#envTable').innerHTML = rows.map(function (r) {
      return '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>';
    }).join('');
  }

  function probeEnv() {
    var rows = [];
    var ua = navigator.userAgent;
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '未知';
    rows.push(['平台', plat]);
    rows.push(['系统 / 浏览器', shortUA(ua)]);
    var isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname);
    var secure = location.isSecureContext || isLocal;
    rows.push(['安全上下文', secure
      ? '是（' + (location.protocol === 'https:' ? 'https' : location.hostname) + '）：麦克风可用'
      : '否（' + location.protocol + '）：浏览器会拒绝麦克风，请改用 https 或 localhost']);

    var AC = window.AudioContext || window.webkitAudioContext;
    rows.push(['Web Audio', AC ? '支持' : '不支持']);

    // 试建上下文读采样率（不推进时间，不会出声）
    var sr = 0, baseLat = null, outLat = null, hiOK = false, hiSr = 0;
    if (AC) {
      try {
        var c = new AC();
        sr = c.sampleRate;
        baseLat = (typeof c.baseLatency === 'number') ? c.baseLatency : null;
        outLat = (typeof c.outputLatency === 'number') ? c.outputLatency : null;
        try { c.close(); } catch (e) { }
      } catch (e) { sr = 0; }
      try {
        var c2 = new AC({ sampleRate: 96000 });
        hiOK = c2.sampleRate >= 90000;
        hiSr = c2.sampleRate;
        try { c2.close(); } catch (e) { }
      } catch (e) { hiOK = false; }
    }

    rows.push(['音频上下文采样率', sr ? sr.toLocaleString() + ' Hz' : '未取到']);
    rows.push(['理论输出天花板（sr/2）', sr ? fmtHz(sr / 2) + '（' + (sr / 2).toFixed(0) + ' Hz）' : '—']);
    rows.push(['96 kHz 上下文', hiOK ? '可建（' + hiSr + ' Hz），但硬件多半仍按 48 kHz 重采样，不代表真能发出 24 kHz 以上' : '不可建']);

    rows.push(['输入延迟 baseLatency', baseLat == null ? '未提供' : (baseLat * 1000).toFixed(1) + ' ms']);
    rows.push(['输出延迟 outputLatency', outLat == null ? '未提供' : (outLat * 1000).toFixed(1) + ' ms']);

    rows.push(['音频设备', '<span id="devCell">枚举中…</span>']);

    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(function (list) {
        var inputs = list.filter(function (d) { return d.kind === 'audioinput'; });
        var outs = list.filter(function (d) { return d.kind === 'audiooutput'; });
        var cell = $('#devCell');
        if (!cell) return;
        var named = inputs.some(function (d) { return !!d.label; });
        cell.textContent = inputs.length + ' 个输入 / ' + outs.length + ' 个输出' +
          (named ? '：' + inputs.map(function (d) { return d.label; }).join(' · ')
                 : '（未授权，系统隐藏了设备名）');
      }).catch(function () { });
    }

    renderEnv(rows);
    $('#initMeta').textContent = S.ctx
      ? ('音频上下文已启动 · ' + S.sr + ' Hz · 天花板 ' + fmtHz(S.sr / 2))
      : '音频上下文未启动（按「启用音频」后才会出声）';
  }

  /* ---------------- ② 音频图 ---------------- */

  // resume() 在没有音频后端的环境（无头、部分虚拟机）可能永远不 resolve，必须给它上上限
  function resumeSafe() {
    if (!S.ctx) return Promise.resolve();
    var p;
    try { p = S.ctx.resume(); } catch (e) { p = Promise.resolve(); }
    return Promise.race([Promise.resolve(p).catch(function () { }), sleep(900)]);
  }

  function ensureCtx() {
    if (!S.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('浏览器不支持 Web Audio');
      S.ctx = new AC();
      S.sr = S.ctx.sampleRate;
      S.nyq = S.sr / 2;

      S.master = S.ctx.createGain();
      S.master.gain.value = 1;
      S.master.connect(S.ctx.destination);

      S.env = S.ctx.createGain();
      S.env.gain.value = 0;
      S.env.connect(S.master);

      S.osc = S.ctx.createOscillator();
      S.osc.type = 'sine';
      S.osc.frequency.value = 1000;
      S.osc.connect(S.env);
      S.osc.start();
    }
    if (S.ctx.state !== 'running') resumeSafe();
    S.sr = S.ctx.sampleRate;
    S.nyq = S.sr / 2;

    var rng = $('#inFreq');
    if (rng) {
      rng.max = String(Math.floor(S.nyq * 0.98));
      if (+rng.value > +rng.max) rng.value = rng.max;
    }
    return S.ctx;
  }

  async function openMic() {
    if (S.analyser) return;
    var want = {
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false
    };
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(want);
    } catch (e) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    S.micStream = stream;
    S.micSrc = S.ctx.createMediaStreamSource(stream);
    S.analyser = S.ctx.createAnalyser();
    S.analyser.fftSize = 8192;
    S.analyser.smoothingTimeConstant = 0.2;
    S.analyser.minDecibels = -140;
    S.analyser.maxDecibels = 0;
    S.micSrc.connect(S.analyser);
    S.buf = new Float32Array(S.analyser.frequencyBinCount);

    var tr = stream.getAudioTracks()[0];
    if (tr && tr.getSettings) {
      S.micSettings = tr.getSettings();
      var st = S.micSettings;
      $('#initMeta').textContent = '音频已启动 · 输出 ' + S.sr + ' Hz（上限 ' + fmtHz(S.nyq) +
        '）· 麦克风 ' + (st.sampleRate || '?') + ' Hz（上限 ' + (st.sampleRate ? fmtHz(st.sampleRate / 2) : '?') + '）';
    }
  }

  function closeMic() {
    if (S.micStream) {
      S.micStream.getTracks().forEach(function (t) { t.stop(); });
      S.micStream = null;
    }
    if (S.micSrc) { try { S.micSrc.disconnect(); } catch (e) { } S.micSrc = null; }
    S.analyser = null;
  }

  /* ---------------- 播放原语 ---------------- */

  function setTone(freq, amp, ms) {
    var t = S.ctx.currentTime;
    S.osc.frequency.setValueAtTime(Math.min(freq, S.nyq * 0.995), t);
    S.env.gain.cancelScheduledValues(t);
    S.env.gain.setValueAtTime(S.env.gain.value, t);
    S.env.gain.linearRampToValueAtTime(amp, t + 0.012);
    if (ms && ms > 0) {
      S.env.gain.setValueAtTime(amp, t + ms / 1000 - 0.02);
      S.env.gain.linearRampToValueAtTime(0, t + ms / 1000);
    }
  }

  function stopTone() {
    if (!S.ctx) return;
    var t = S.ctx.currentTime;
    S.env.gain.cancelScheduledValues(t);
    S.env.gain.setValueAtTime(S.env.gain.value, t);
    S.env.gain.linearRampToValueAtTime(0, t + 0.02);
  }

  /* ---------------- 频谱读取 ---------------- */

  function readSpec() { S.analyser.getFloatFrequencyData(S.buf); }

  function binHz() { return S.ctx.sampleRate / S.analyser.fftSize; }

  // 在目标频率 ±5 bins 内取最大值（抗房间梳状起伏）
  function peakNear(freq) {
    var bh = binHz();
    var c = Math.round(freq / bh);
    var half = 5, best = -Infinity;
    var lo = Math.max(1, c - half), hi = Math.min(S.buf.length - 2, c + half);
    for (var k = lo; k <= hi; k++) if (S.buf[k] > best) best = S.buf[k];
    return best;
  }

  // 全局峰值（用于 RX 模式与频谱标注）
  function globalPeak(minHz) {
    var bh = binHz();
    var start = Math.max(1, Math.round((minHz || 0) / bh));
    var best = -Infinity, idx = start;
    for (var k = start; k < S.buf.length - 1; k++) {
      if (S.buf[k] > best) { best = S.buf[k]; idx = k; }
    }
    return { hz: idx * bh, db: best };
  }

  /* ---------------- 校准（防削波） ---------------- */

  async function calibrate() {
    var amp = S.amp;
    for (var i = 0; i < 3; i++) {
      readSpec();
      var t0 = S.ctx.currentTime;
      setTone(1000, amp, 320);
      await sleep(190);
      var db = peakNear(1000);
      stopTone();
      await sleep(60);
      if (db > -14) { amp = Math.max(0.05, amp * 0.5); continue; }
      if (db < -55) { amp = Math.min(1, amp * 1.8); continue; }
      break;
    }
    S.amp = amp;
    return amp;
  }

  /* ---------------- 闭环扫描 ---------------- */

  function buildPoints(f0, f1, n) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var r = n === 1 ? 0 : i / (n - 1);
      pts.push(f0 * Math.pow(f1 / f0, r));
    }
    return pts;
  }

  async function runSweep() {
    if (S.running) return;
    await ensureCtx();
    await openMic();
    if (S.ctx.state !== 'running') await resumeSafe();
    if (S.ctx.state !== 'running') {
      toast('音频引擎没起来（这台设备没有可用的音频输出？），测出来的电平会是空的。', true);
    }

    var f0 = Math.max(60, +$('#inF0').value || 400);
    var n = Math.min(96, Math.max(12, +$('#inN').value || 36));
    var f1 = Math.min(S.nyq * 0.94, 24000);
    if (f0 > f1 - 200) f0 = Math.max(60, f1 / 12);

    var pts = buildPoints(f0, f1, n);
    S.running = true;
    S.abort = false;
    S.measured = false;
    $('#btnRun').disabled = true;
    $('#btnStop').disabled = false;
    $('#progText').textContent = '校准输入电平…';

    var amp = await calibrate();
    if (S.abort) { finishSweep(true); return; }

    var raws = [];
    var dwell = 460;
    for (var i = 0; i < pts.length; i++) {
      if (S.abort) break;
      var f = pts[i];
      S.curFreq = f;

      var t = S.ctx.currentTime;
      S.osc.frequency.setValueAtTime(f, t);
      S.env.gain.cancelScheduledValues(t);
      S.env.gain.setValueAtTime(0, t);
      S.env.gain.linearRampToValueAtTime(amp, t + 0.012);
      S.env.gain.setValueAtTime(amp, t + dwell / 1000 - 0.03);
      S.env.gain.linearRampToValueAtTime(0, t + dwell / 1000 - 0.01);

      await sleep(dwell * 0.45);

      var vals = [];
      for (var k = 0; k < 7; k++) {
        readSpec();
        vals.push(peakNear(f));
        await sleep(13);
      }
      raws.push(median(vals));

      stopTone();
      await sleep(40);

      var pct = (i + 1) / pts.length;
      $('#progBar').style.width = (pct * 100).toFixed(1) + '%';
      $('#progText').textContent = '第 ' + (i + 1) + '/' + pts.length + ' 点 · ' + fmtHz(f) + ' · ' + fmtDb(raws[raws.length - 1]);
    }

    if (S.abort) { finishSweep(true); return; }

    // 归一化：以 3 kHz 以下的最大电平为 0 dB（喇叭效率峰一般在这里）
    var low = [];
    for (var j = 0; j < pts.length; j++) if (pts[j] < 3000 && isFinite(raws[j])) low.push(raws[j]);
    var base = low.length ? Math.max.apply(null, low) : Math.max.apply(null, raws);

    var rel = raws.map(function (v) { return v - base; });
    rel = smooth(rel, 1);

    S.points = pts.slice();
    S.rel = rel;
    S.measured = true;
    S.lastRaw = raws.slice();
    S.baseDb = base;

    finishSweep(false);
    renderResult();
  }

  function finishSweep(aborted) {
    S.running = false;
    S.abort = false;
    S.curFreq = 0;
    $('#btnRun').disabled = false;
    $('#btnStop').disabled = true;
    stopTone();
    if (aborted) {
      $('#progText').textContent = '已中止（已测到的点不保存）';
      $('#progBar').style.width = '0%';
      return;
    }
    $('#progText').textContent = '完成：' + S.points.length + ' 点，基准 0 dB 取自 3 kHz 以下最强点';
    $('#progBar').style.width = '100%';
  }

  /* ---------------- 判定 ---------------- */

  function cutoffAt(thr) {
    if (!S.measured) return null;
    for (var i = S.points.length - 1; i >= 0; i--) {
      if (S.rel[i] > thr) return S.points[i];
    }
    return null;
  }
  function dropAt(thr) { // 从低往高第一次跌破
    if (!S.measured) return null;
    for (var i = 1; i < S.points.length; i++) {
      if (S.points[i] > 3000 && S.rel[i] <= thr) return S.points[i];
    }
    return null;
  }

  function verdict() {
    if (!S.measured) {
      $('#verdict').className = 'verdict';
      $('#verdict').innerHTML = '还没测。先点「启用音频」，再点「开始闭环扫描」。';
      $('#tblResult').innerHTML = '';
      return;
    }
    var f6 = cutoffAt(-6), f12 = cutoffAt(-12), f30 = cutoffAt(-30);
    var firstDrop = dropAt(-6);
    var tier, cls, text;

    var upper = f6 || firstDrop || 0;
    if (upper >= 21000) {
      tier = '宽'; cls = 'verdict';
      text = '这台设备的声学链路能撑到 <b>' + fmtHz(upper) + '</b> 以上，直接用它跑 19 kHz 段超声信道没问题，20 kHz 以上也还有余量。';
    } else if (upper >= 18000) {
      tier = '够用'; cls = 'verdict';
      var hi = Math.min(Math.max(17000, upper - 300), 19500);
      text = '有效带宽到 <b>' + fmtHz(upper) + '</b>。18.1–19.5 kHz 这条信道可以用，但已经贴着边了：窗口建议取 <b>17.0 kHz – ' + fmtHz(hi) + '</b>，再往上只会白耗功率。';
    } else if (upper >= 15000) {
      tier = '偏窄'; cls = 'verdict warn';
      text = '只到 <b>' + fmtHz(upper) + '</b>。18 kHz 段发出来也是蚊子叫，超声信道要么降到 15–17 kHz（环境噪声更脏），要么换外置喇叭/换设备。';
    } else {
      tier = '不够'; cls = 'verdict warn';
      text = '只到 <b>' + fmtHz(upper) + '</b>，高频段基本躺平。这台设备做不了超声信道，也别指望它能激励任何 MEMS 谐振。';
    }

    var extra = '';
    if (upper < 20000) {
      extra = '另外，手机 IMU 的谐振多在 20–30 kHz，这台设备连门都进不去；' +
        '少数器件谐振在 15–19 kHz，理论上能被扫到，但喇叭声压远低于论文里的 90–140 dB，只能观察到轻微串扰，谈不上操控。';
    } else {
      extra = '已越过 20 kHz，理论上能覆盖一部分 IMU 谐振区；但声压级仍远低于论文实验用的 90–140 dB，实际能看到的只是轻微伪角速度。';
    }

    $('#verdict').className = cls;
    $('#verdict').innerHTML = '判定：<b>' + tier + '</b>。' + text + '<br>' + extra;

    var rows = [
      ['输出天花板（sr/2）', fmtHz(S.nyq)],
      ['基准 0 dB 参考', '3 kHz 以下最强点（' + fmtDb(S.baseDb || 0) + ' dBFS）'],
      ['-6 dB 上限', f6 ? fmtHz(f6) : '未出现（全程高于 -6 dB）'],
      ['-12 dB 上限', f12 ? fmtHz(f12) : '未出现'],
      ['-30 dB 上限（基本听不见）', f30 ? fmtHz(f30) : '未出现'],
      ['首次跌破 -6 dB', firstDrop ? fmtHz(firstDrop) : '—'],
      ['窄带凹陷', narrowNotch()],
      ['测点数', S.points.length + ' 点 / 对数分布'],
      ['麦克风采样率', S.micSettings && S.micSettings.sampleRate ? S.micSettings.sampleRate + ' Hz（上限 ' + fmtHz(S.micSettings.sampleRate / 2) + '）' : '未取到'],
      ['注意', '闭环曲线 = 喇叭 + 麦克风的组合结果，二者都会限制上限；要拆开看就切「只发射 / 只接收」交叉测。']
    ];
    $('#tblResult').innerHTML = rows.map(function (r) {
      return '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>';
    }).join('');
  }

  function narrowNotch() {
    if (!S.measured) return '—';
    var worst = 0, at = 0;
    for (var i = 1; i < S.points.length - 1; i++) {
      var nb = (S.rel[i - 1] + S.rel[i + 1]) / 2;
      var d = nb - S.rel[i];
      if (d > worst) { worst = d; at = S.points[i]; }
    }
    if (worst < 6) return '无明显凹陷';
    return fmtHz(at) + ' 附近掉 ' + worst.toFixed(1) + ' dB（典型是喇叭分频点或机身腔体共振）';
  }

  /* ---------------- 绘图 ---------------- */

  function prep(cv, h) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(280, cv.clientWidth);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    cv.style.height = h + 'px';
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }

  function xLog(f, fmin, fmax, w, pad) {
    var t = Math.log(f / fmin) / Math.log(fmax / fmin);
    return pad + t * (w - pad * 2);
  }

  function drawSpectrum() {
    var cv = $('#cvSpec');
    var p = prep(cv, 220), g = p.g, w = p.w, h = p.h;
    var pad = 34;
    var fmin = 20, fmax = S.nyq || 24000;

    // 网格
    g.strokeStyle = '#eef3f0'; g.lineWidth = 1;
    g.fillStyle = '#93a49e'; g.font = '10px ui-monospace,Menlo,monospace';
    var ticks = [20, 100, 300, 1000, 3000, 6000, 10000, 14000, 18000, 21000, 24000];
    ticks.forEach(function (f) {
      if (f < fmin || f > fmax) return;
      var x = xLog(f, fmin, fmax, w, pad);
      g.beginPath(); g.moveTo(x, 8); g.lineTo(x, h - 18); g.stroke();
      g.fillText(f >= 1000 ? (f / 1000) + 'k' : f, x - 8, h - 4);
    });
    for (var db = 0; db >= -100; db -= 20) {
      var y = 8 + (-db / 100) * (h - 30);
      g.beginPath(); g.moveTo(pad, y); g.lineTo(w - pad, y); g.stroke();
      g.fillText(db + ' dB', 2, y + 3);
    }

    if (S.analyser) {
      readSpec();
      g.beginPath();
      g.strokeStyle = '#0e7c66'; g.lineWidth = 1.6;
      var started = false;
      for (var i = 1; i < S.buf.length; i++) {
        var f = i * binHz();
        if (f < fmin || f > fmax) continue;
        var dbv = Math.max(-100, Math.min(0, S.buf[i]));
        var x = xLog(f, fmin, fmax, w, pad);
        var y = 8 + (-dbv / 100) * (h - 30);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();

      var pk = globalPeak(8000);
      S.peakHz = pk.hz; S.peakDb = pk.db;
      if (isFinite(pk.db) && pk.db > -100) {
        var px = xLog(Math.min(fmax, pk.hz), fmin, fmax, w, pad);
        g.strokeStyle = 'rgba(180,66,58,.75)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(px, 8); g.lineTo(px, h - 18); g.stroke();
        if ((S.textTick = ((S.textTick || 0) + 1) % 5) === 0) {
          $('#specMeta').textContent = '全频峰值 ' + fmtHz(pk.hz) + ' · ' + fmtDb(pk.db) +
            '　|　8 kHz 以上峰值 ' + fmtHz(S.peakHz) + ' · ' + fmtDb(S.peakDb) +
            (S.curFreq ? '　|　当前播放 ' + fmtHz(S.curFreq) : '');
        }
      } else {
        $('#specMeta').textContent = '没有信号（麦克风未授权或静音）';
      }
    } else {
      g.fillStyle = '#9db0aa'; g.font = '13px system-ui';
      g.fillText('麦克风未启动 · 切到「闭环自测」或「只接收」', pad + 6, h / 2);
      $('#specMeta').textContent = '—';
    }
  }

  function drawResponse() {
    var cv = $('#cvResp');
    var p = prep(cv, 240), g = p.g, w = p.w, h = p.h;
    var pad = 40;
    var fmin = 300, fmax = S.nyq || 24000;
    var dbMin = -45, dbMax = 6;

    g.strokeStyle = '#eef3f0';
    g.fillStyle = '#93a49e'; g.font = '10px ui-monospace,Menlo,monospace';

    [300, 1000, 3000, 6000, 10000, 14000, 18000, 21000, 24000].forEach(function (f) {
      if (f < fmin || f > fmax) return;
      var x = xLog(f, fmin, fmax, w, pad);
      g.beginPath(); g.moveTo(x, 10); g.lineTo(x, h - 20); g.stroke();
      g.fillText(f >= 1000 ? (f / 1000) + 'k' : f, x - 8, h - 6);
    });
    [6, 0, -6, -12, -24, -36].forEach(function (d) {
      var y = 10 + ((dbMax - d) / (dbMax - dbMin)) * (h - 32);
      g.beginPath(); g.moveTo(pad, y); g.lineTo(w - pad, y); g.stroke();
      g.fillText(d + ' dB', 2, y + 3);
    });

    // -6 dB 参考线
    var y6 = 10 + ((dbMax - (-6)) / (dbMax - dbMin)) * (h - 32);
    g.strokeStyle = '#f0d9a8'; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(pad, y6); g.lineTo(w - pad, y6); g.stroke();
    g.setLineDash([]);

    if (!S.measured) {
      g.fillStyle = '#9db0aa'; g.font = '13px system-ui';
      g.fillText('还没有数据', pad + 8, h / 2);
      return;
    }

    // 曲线
    g.beginPath();
    g.strokeStyle = '#0e7c66'; g.lineWidth = 2;
    for (var i = 0; i < S.points.length; i++) {
      var x = xLog(Math.max(fmin, S.points[i]), fmin, fmax, w, pad);
      var d = Math.max(dbMin, Math.min(dbMax, S.rel[i]));
      var y = 10 + ((dbMax - d) / (dbMax - dbMin)) * (h - 32);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();

    // 数据点
    g.fillStyle = '#0e7c66';
    for (var j = 0; j < S.points.length; j += 1) {
      var xx = xLog(Math.max(fmin, S.points[j]), fmin, fmax, w, pad);
      var dd = Math.max(dbMin, Math.min(dbMax, S.rel[j]));
      var yy = 10 + ((dbMax - dd) / (dbMax - dbMin)) * (h - 32);
      g.beginPath(); g.arc(xx, yy, 1.8, 0, Math.PI * 2); g.fill();
    }

    // 截止点标注
    var f6 = cutoffAt(-6);
    if (f6) {
      var cx = xLog(Math.max(fmin, f6), fmin, fmax, w, pad);
      g.strokeStyle = 'rgba(180,66,58,.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx, 10); g.lineTo(cx, h - 20); g.stroke();
      g.fillStyle = '#b4423a'; g.font = '11px system-ui';
      g.fillText('-6 dB @ ' + fmtHz(f6), Math.min(w - 96, cx + 4), 22);
    }
  }

  function loopDraw() {
    drawSpectrum();
    drawResponse();
    S.raf = requestAnimationFrame(loopDraw);
  }

  /* ---------------- 导出 ---------------- */

  function payload() {
    var pts = S.points.map(function (f, i) {
      return { f: Math.round(f), db: +(S.lastRaw ? S.lastRaw[i] : 0).toFixed(2), rel: +(S.rel[i] || 0).toFixed(2) };
    });
    return {
      tool: 'hardware-boundary-sweep',
      at: new Date().toISOString(),
      platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
      ua: navigator.userAgent,
      secure: location.isSecureContext,
      sampleRate: S.sr,
      nyquist: S.nyq,
      micSampleRate: S.micSettings ? S.micSettings.sampleRate : null,
      baseDb: S.baseDb || null,
      cutoff: {
        m6: cutoffAt(-6), m12: cutoffAt(-12), m30: cutoffAt(-30)
      },
      points: pts
    };
  }

  function exportJson() {
    if (!S.measured) { alert('先跑一遍闭环扫描再导出。'); return; }
    var text = JSON.stringify(payload(), null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'dev')
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
    var d = new Date();
    a.href = url;
    a.download = 'sweep-' + plat + '-' + d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  function copyVerdict() {
    var t = ($('#verdict').innerText || '').trim();
    if (!t) return;
    var sr = S.sr || 0;
    var lines = [
      '【硬件边界 · 扫频】' + new Date().toLocaleString(),
      '平台：' + ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''),
      '输出采样率：' + sr + ' Hz（天花板 ' + fmtHz(sr / 2) + '）',
      t
    ].join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines).then(function () {
        $('#btnCopy').textContent = '已复制';
        setTimeout(function () { $('#btnCopy').textContent = '复制结论'; }, 1500);
      }).catch(function () { alert(lines); });
    } else {
      alert(lines);
    }
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    $('#btnInit').addEventListener('click', async function () {
      try {
        await ensureCtx();
        if (S.ctx.state !== 'running') await S.ctx.resume();
        $('#initMeta').textContent = '音频上下文已启动 · ' + S.sr + ' Hz · 天花板 ' + fmtHz(S.nyq);
        $('#btnInit').disabled = true;
        $('#btnInit').textContent = '音频已启用';
      } catch (e) { alert('音频启动失败：' + e.message); }
    });

    $('#btnRecheck').addEventListener('click', probeEnv);

    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]');
      if (!b) return;
      Array.prototype.forEach.call($('#tabs').children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      S.mode = b.dataset.mode;
      $('#panelLoop').hidden = S.mode !== 'loop';
      $('#panelTx').hidden = S.mode !== 'tx';
      $('#panelRx').hidden = S.mode !== 'rx';
      if (S.mode === 'rx' || S.mode === 'loop') {
        ensureCtx();
        openMic().catch(function () { });
      } else {
        closeMic();
      }
    });

    $('#btnRun').addEventListener('click', function () { runSweep().catch(function (e) { alert(e.message); finishSweep(true); }); });
    $('#btnStop').addEventListener('click', function () { S.abort = true; });

    // TX
    var rng = $('#inFreq');
    rng.addEventListener('input', function () { $('#txFreqLabel').textContent = rng.value; });

    $('#btnTone').addEventListener('click', async function () {
      try {
        await ensureCtx();
        var f = +rng.value, amp = +$('#inAmp').value;
        setTone(f, amp);
        S.curFreq = f;
      } catch (e) { alert(e.message); }
    });
    $('#btnToneOff').addEventListener('click', function () { stopTone(); S.curFreq = 0; });

    $('#btnChirp').addEventListener('click', async function () {
      await ensureCtx();
      var f0 = 2000, f1 = S.nyq * 0.94, dur = 8000;
      var amp = +$('#inAmp').value;
      var t0 = S.ctx.currentTime + 0.05;
      S.osc.frequency.setValueAtTime(f0, t0);
      S.osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur / 1000);
      S.env.gain.setValueAtTime(0, t0);
      S.env.gain.linearRampToValueAtTime(amp, t0 + 0.05);
      S.env.gain.setValueAtTime(amp, t0 + dur / 1000 - 0.05);
      S.env.gain.linearRampToValueAtTime(0, t0 + dur / 1000);
      var startAt = S.ctx.currentTime;
      var tick = setInterval(function () {
        var pr = Math.min(1, (S.ctx.currentTime - startAt) / (dur / 1000));
        S.curFreq = f0 * Math.pow(f1 / f0, pr);
        if (pr >= 1) clearInterval(tick);
      }, 60);
      setTimeout(function () { S.curFreq = 0; }, dur + 120);
    });

    // RX
    $('#btnRxStart').addEventListener('click', async function () {
      try {
        await ensureCtx(); await openMic();
        $('#rxMeta').textContent = '监听中…看实时频谱';
      } catch (e) { alert('麦克风启动失败：' + e.message); }
    });
    $('#btnRxStop').addEventListener('click', function () {
      closeMic(); $('#rxMeta').textContent = '已停止';
    });
    $('#btnPeak').addEventListener('click', async function () {
      try {
        await ensureCtx(); await openMic();
      } catch (e) { alert('麦克风启动失败：' + e.message); return; }
      var best = { hz: 0, db: -Infinity };
      var t0 = Date.now();
      var iv = setInterval(function () {
        readSpec();
        var pk = globalPeak(6000);
        if (pk.db > best.db) best = pk;
        if (Date.now() - t0 > 5000) {
          clearInterval(iv);
          $('#rxMeta').textContent = best.db > -100
            ? ('5 秒内最强：' + fmtHz(best.hz) + ' · ' + fmtDb(best.db) + '（已忽略 6 kHz 以下）')
            : '5 秒内没抓到有效信号（麦克风静音或声源太弱）';
        }
      }, 120);
    });

    $('#btnExport').addEventListener('click', exportJson);
    $('#btnCopy').addEventListener('click', copyVerdict);

    window.addEventListener('resize', function () { drawSpectrum(); drawResponse(); });
  }

  /* ---------------- 启动 ---------------- */

  probeEnv();
  bind();
  loopDraw();

})();
