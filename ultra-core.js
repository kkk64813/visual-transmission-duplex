/* ultra-core.js —— 可调频段超声 MFSK 内核（AirBridge 超声信道 2.0）
 *
 * 跟 duplex.js 的关系：
 *  - duplex.js 是「双工控制通道」，固定 20.5k、8 音、16ms，只传 5 字节状态。
 *  - 本文件是「通用超声链路」，频段可换（17.6k / 19.0k / 20.5k），符号长度可换
 *    （16 / 24 / 32ms），能传文字和小文件，自带 CRC 与分块重组。
 *
 * 为什么频段要能换：
 *  20.5 kHz 以上，绝大多数手机扬声器（腔体 + 低通）和笔记本内置麦阵列都会衰减
 *  15–30 dB，很多设备干脆没有响应，于是「怎么都连不上」。19.0 kHz 仍属于超声
 *  （33 岁左右的成年人听阈通常止于 17.5 kHz），设备响应却好得多；17.6 kHz 是兜底。
 *
 * 帧格式（和 duplex.js 一致，方便复用调试经验）：
 *   [哨兵] SYNC(8 符号) 载荷(3 符号/字节) [哨兵]
 * 载荷 = [len u16][payload][crc16]
 * payload 首字节是类型：0 探测 / 1 文字块 / 2 文件块 / 3 文件头
 */
(function (root) {
  'use strict';

  var SR = 48000;
  var TONES = 8;
  var SYNC = [1, 5, 3, 7, 2, 6, 4, 0];

  /* ---------------- 双音（4+4，仿 DTMF） ----------------
   * 把所有可用音（18.1k–19.5k，200 Hz 一格，共 8 个）分成两组：
   *   行 row = 音 0..3（18100/18300/18500/18700）
   *   列 col = 音 4..7（18900/19100/19300/19500）
   * 每个符号同时发「一个行音 + 一个列音」，4×4 = 16 种组合 = 4 bit/符号。
   * 判决必须先各自在组内选出最强，再组合成符号 —— 只有行、列同时对得上才算，
   * 单个杂音再响也不会自己凑出一个符号，误判率比单音低；代价是两个音各分一半幅度。
   * 双音模式的包头用一组「行音和列音都不同」的图案，避免整组同音凑出假同步。 */
  var SYNC2 = [0, 15, 5, 10, 3, 12, 6, 9];
  var MODE = 'single';               // 默认单音（兼容旧测试/旧页面）；页面显式切 'dual' 走双音 4 bit/符号

  function pairTones(sym) {
    var s = sym & 15;
    return [s >> 2, 4 + (s & 3)];
  }
  function setMode(m) {
    MODE = (m === 'single') ? 'single' : 'dual';
    return MODE;
  }
  function getMode() { return MODE; }
  var SHARED_SCALE = 1;      // 上一次锁上时估出的频率缩放，给同设备其它解码器当种子
var FORCED_SCALE = 0;      // 手动校准（0 = 自动）
var GAIN = 0.72;          // 默认标准音量：够响，又不至于让喇叭非线性生出人耳可闻的差频
  var RAMP_MS = 3;
  var GLIDE_MS = 1.5;          // 相邻符号之间的等幅频率滑音长度：消掉跳频折角溅出的可听宽带能量
  var GUARD_MS = 4;            // 判决窗跳过每个符号开头的长度（回声尾巴和滑音都在这段）
  var TWO_PI = Math.PI * 2;

  /* 两档频带（音距 200 Hz，8 音共 1400 Hz 宽；两档中间留 1000 Hz 隔离，避免互串）：
   *  mid 18.1–19.5 kHz：实测 18 kHz 以上就听不见了，而手机扬声器/笔记本麦克风在这段
   *                     响应明显好于 20 k 以上 —— 定为主力。
   *  hi  20.5–21.9 kHz：最安静，但不少设备在这段压根没响应，只当兜底。 */
  var BANDS = [
    { key: 'mid', name: '18.1k', f0: 18100, df: 200, label: '推荐', desc: '人耳听阈之上，且手机扬声器、笔记本麦克风在这段响应最好，日常就用这档' },
    { key: 'hi', name: '20.5k', f0: 20500, df: 200, label: '更静', desc: '喇叭响应明显下降，溅射更小；解不出就往下一档试' },
    { key: 'top', name: '22.3k', f0: 22300, df: 200, label: '最静', desc: '22.3–23.7k：绝大多数喇叭这段几乎没输出，人耳最安静，但很多设备收不到' }
  ];

  function bandByKey(k) {
    for (var i = 0; i < BANDS.length; i++) if (BANDS[i].key === k || BANDS[i].name === k) return BANDS[i];
    return BANDS[0];
  }

  /* ---------------- CRC16-CCITT ---------------- */
  function crc16(u8) {
    var c = 0xffff;
    for (var i = 0; i < u8.length; i++) {
      c ^= (u8[i] << 8);
      for (var k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    return c & 0xffff;
  }

  function crc8(u8) {
    var c = 0;
    for (var i = 0; i < u8.length; i++) {
      c ^= u8[i];
      for (var k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c & 0xff;
  }

  /* ---------------- 组包 / 拆包 ---------------- */
  function buildPacket(payload) {
    var n = payload.length;
    var out = new Uint8Array(2 + n + 2);
    out[0] = n & 0xff;
    out[1] = (n >> 8) & 0xff;
    out.set(payload, 2);
    var c = crc16(payload);
    out[2 + n] = c & 0xff;
    out[3 + n] = (c >> 8) & 0xff;
    return out;
  }

  function parsePacket(bytes) {
    if (bytes.length < 5) return null;
    var n = bytes[0] | (bytes[1] << 8);
    if (n <= 0 || bytes.length < 4 + n) return null;
    var payload = bytes.subarray(2, 2 + n);
    var c = (bytes[2 + n] | (bytes[3 + n] << 8)) & 0xffff;
    if (c !== crc16(payload)) return null;
    return payload;
  }

  /* 回执（反向信道）：接收端用位图告诉发送端「哪些包我已经收到了」。
   * 载荷 = [T_ACK][round][total u8][nbytes][b0..b(n-1)][diagHits][diagMargin]
   * 末两字节是「接收端自己的观测」：数据解码器最好的同步命中数、以及那次的行/列边距。
   * 有了它，发端那一份日志就能同时说清「我发了什么」和「对方听到了什么」，不必再让对方
   * 另贴一份日志。旧版本回执没有这两字节，parseAck 会自动当作没有。 */
  var T_ACK = 4, ACK_MAX = 128;

  function ackPayload(round, total, have, diag) {
    var n = Math.ceil(Math.min(total, ACK_MAX) / 8) || 1;
    var b = new Uint8Array(4 + n + (diag ? 3 : 0));
    b[0] = T_ACK;
    b[1] = round & 0xff;
    b[2] = total & 0xff;
    b[3] = n;
    for (var i = 0; i < total && i < ACK_MAX; i++) {
      if (have(i)) b[4 + (i >> 3)] |= (1 << (i & 7));
    }
    if (diag) {
      var h = Math.max(0, Math.min(15, Math.round(+diag.hits || 0)));
      var mg = Math.max(-16, Math.min(46, +diag.margin || 0));
      var lv = Math.max(-40, Math.min(46, diag.level == null ? -40 : +diag.level));
      b[4 + n] = h;
      b[5 + n] = Math.round((mg + 16) / 2) & 0x1f;        // -16..+46 dB → 0..31，2 dB 一格
      b[6 + n] = Math.round((lv + 40) / 3) & 0x1f;        // -40..+46 dB → 0..31，3 dB 一格
    }
    return b;
  }

  function parseAck(payload) {
    if (!payload || payload[0] !== T_ACK || payload.length < 5) return null;
    var total = payload[2];
    var n = Math.min(payload[3] || 1, 16);
    if (payload.length < 4 + n) return null;
    var bits = payload.subarray(4, 4 + n);
    function has(i) { return i < total && (i >> 3) < n && !!(bits[i >> 3] & (1 << (i & 7))); }
    var diag = null;
    if (payload.length >= 6 + n) {
      diag = { hits: payload[4 + n] & 15, margin: (payload[5 + n] & 31) * 2 - 16, level: -40 };
      if (payload.length >= 7 + n) diag.level = (payload[6 + n] & 31) * 3 - 40;
    }
    return {
      round: payload[1],
      total: total,
      has: has,
      diag: diag,
      missing: function () {
        var out = [];
        for (var i = 0; i < total; i++) if (!has(i)) out.push(i);
        return out;
      }
    };
  }

  /* ---------------- 3 bit / 符号 ---------------- */
  function bytesToSymbols(u8) {
    var out = new Uint8Array(u8.length * 3);
    for (var i = 0; i < u8.length; i++) {
      var b = u8[i];
      out[i * 3] = (b >> 5) & 7;
      out[i * 3 + 1] = (b >> 2) & 7;
      out[i * 3 + 2] = b & 7;
    }
    return out;
  }

  function symbolsToBytes(syms) {
    var out = new Uint8Array(Math.floor(syms.length / 3));
    for (var i = 0; i < out.length; i++) {
      out[i] = ((syms[i * 3] & 7) << 5) | ((syms[i * 3 + 1] & 7) << 2) | (syms[i * 3 + 2] & 7);
    }
    return out;
  }

  function packetSymbols(payloadLen) {
    if (MODE === 'dual') return packetSymbols2(payloadLen);
    return 1 + SYNC.length + 3 * (2 + payloadLen + 2) + 1;
  }

  /* ---------------- 调制 ---------------- */
  function toneFreq(band, sym, scale) { return (band.f0 + sym * band.df) * (scale || 1); }

  /* 双音波形：每个符号同时发一个行音 + 一个列音，两路独立维持相位（等幅、频率滑音过渡）。 */
  function makeWaveformDual(packet, sr, band, symMs) {
    /* 防呆：这里收的必须是「包字节」，不是已经合成好的样点。
     * 如果把样点数组误当包传进来，按 200 字节的规则会合成出几十分钟的音频 ——
     * 真机上的表现就是「按了发送，三分钟没反应」。所以超长直接抛错。 */
    if (!packet || !packet.length) throw new Error('makeWaveformDual: 空包');
    if (packet.length > 220) throw new Error('makeWaveformDual: 这不是包（' + packet.length + ' 字节）');
    var symLen = Math.round(sr * (symMs || 24) / 1000);
    var data = bytesToSymbols2(packet);
    var syms = new Uint8Array(2 + SYNC2.length + data.length);
    syms[0] = SYNC2[0];
    for (var i = 0; i < SYNC2.length; i++) syms[1 + i] = SYNC2[i];
    syms.set(data, 1 + SYNC2.length);
    syms[syms.length - 1] = SYNC2[0];

    var total = syms.length * symLen;
    var x = new Float32Array(total);
    var step = TWO_PI / sr;
    var p1 = 0, p2 = 0, p = 0;
    var amp = GAIN * 0.5;                       // 两音峰值相加不超过 GAIN，避免喇叭削顶生出可听差频
    var glide = Math.max(1, Math.round(sr * GLIDE_MS / 1000));
    var t0 = pairTones(syms[0]);
    var pw1 = step * toneFreq(band, t0[0]), pw2 = step * toneFreq(band, t0[1]);
    for (var s = 0; s < syms.length; s++) {
      var tt = pairTones(syms[s]);
      var tw1 = step * toneFreq(band, tt[0]), tw2 = step * toneFreq(band, tt[1]);
      var gl = Math.min(glide, Math.round(symLen / 4));
      for (var n = 0; n < symLen; n++) {
        var w1 = tw1, w2 = tw2;
        if (gl && n < gl) {
          var u = n / gl;
          w1 = pw1 + (tw1 - pw1) * u;
          w2 = pw2 + (tw2 - pw2) * u;
        }
        x[p++] = (Math.sin(p1) + Math.sin(p2)) * amp;
        p1 += w1; if (p1 > TWO_PI) p1 -= TWO_PI;
        p2 += w2; if (p2 > TWO_PI) p2 -= TWO_PI;
      }
      pw1 = tw1; pw2 = tw2;
    }
    var ramp = Math.max(1, Math.round(sr * RAMP_MS / 1000));
    for (var k = 0; k < ramp && k < total; k++) {
      var g = k / ramp;
      x[k] *= g;
      x[total - 1 - k] *= g;
    }
    return x;
  }

  function makeWaveform(packet, sr, band, symMs, dual) {
    sr = sr || SR;
    band = band || BANDS[2];
    symMs = symMs || 16;
    if (dual === undefined) dual = (MODE === 'dual');
    if (!packet || !packet.length) throw new Error('makeWaveform: 空包');
    if (packet.length > 220) throw new Error('makeWaveform: 这不是包（' + packet.length + ' 字节）');
    if (dual) return makeWaveformDual(packet, sr, band, symMs);
    var symLen = Math.round(sr * symMs / 1000);
    var data = bytesToSymbols(packet);
    var syms = new Uint8Array(2 + SYNC.length + data.length);
    syms[0] = SYNC[0];
    for (var i = 0; i < SYNC.length; i++) syms[1 + i] = SYNC[i];
    syms.set(data, 1 + SYNC.length);
    syms[syms.length - 1] = SYNC[0];

    var total = syms.length * symLen;
    var x = new Float32Array(total);
    var step = TWO_PI / sr;
    var phase = 0, p = 0;
    // 符号之间用 2ms 的频率滑音过渡（等幅、相位连续），而不是突然跳频：
    // 突然跳频在波形上留下一个折角，会在人耳频段里溅出宽带能量，听着就是「嗒嗒」声。
    var glide = Math.max(1, Math.round(sr * GLIDE_MS / 1000));
    var prevW = step * toneFreq(band, syms[0]);
    for (var s = 0; s < syms.length; s++) {
      var tw = step * toneFreq(band, syms[s]);
      // 所有符号一律等幅滑音：硬跳频在波形上留折角，会溅出人耳能听见的宽带“嗒嗒”声。
      // 解码端判决窗只取符号尾部（跳过 GUARD_MS），滑音段本来就不参与判决，所以不影响同步估计。
      var gl = Math.min(glide, Math.round(symLen / 4));
      for (var n = 0; n < symLen; n++) {
        var w = tw;
        if (gl && n < gl) { var t = n / gl; w = prevW + (tw - prevW) * t; }
        x[p++] = Math.sin(phase) * GAIN;
        phase += w;
        if (phase > TWO_PI) phase -= TWO_PI;
      }
      prevW = tw;
    }
    var ramp = Math.max(1, Math.round(sr * RAMP_MS / 1000));
    for (var k = 0; k < ramp && k < total; k++) {
      var g = k / ramp;
      x[k] *= g;
      x[total - 1 - k] *= g;
    }
    return x;
  }

  /* 纯音探测：给「哪一档频段能过」做实测 */
  function makeProbe(sr, band, ms) {
    sr = sr || SR;
    ms = ms || 1200;
    var n = Math.round(sr * ms / 1000);
    var x = new Float32Array(n);
    var step = TWO_PI / sr;
    var w = step * band.f0;
    var phase = 0;
    for (var i = 0; i < n; i++) {
      x[i] = Math.sin(phase) * GAIN;
      phase += w;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    var ramp = Math.max(1, Math.round(sr * 15 / 1000));
    for (var k = 0; k < ramp; k++) {
      var g = k / ramp;
      x[k] *= g;
      x[n - 1 - k] *= g;
    }
    return x;
  }

  /* ---------------- 解调 ---------------- */
  function goertzel(x, off, len, freq, sr) {
    var w = TWO_PI * freq / sr;
    var coeff = 2 * Math.cos(w);
    var s0 = 0, s1 = 0, s2 = 0;
    for (var i = 0; i < len; i++) {
      s0 = x[off + i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  function classify(x, off, len, sr, band, scale) {
    if (off < 0 || off + len > x.length) return -1;
    var mags = new Float64Array(TONES), sum = 0, best = 0;
    for (var t = 0; t < TONES; t++) {
      var m = goertzel(x, off, len, toneFreq(band, t, scale), sr);
      if (!(m >= 0)) m = 0;
      mags[t] = m;
      sum += m;
      if (m > mags[best]) best = t;
    }
    var mean = sum / TONES;
    if (mags[best] <= 0) return -1;
    if (mags[best] < mean * 1.8) return -1;   // 门限比双工版略松，窄带下更容易起解
    return best;
  }

  /* 在音 [lo,hi] 上取最强与次强（次强必须排除最强本身，否则比值始终是 1） */
  function top2(m, lo, hi) {
    var b = -1, bv = -1, ss = -1, sv = -1;
    for (var t = lo; t <= hi; t++) {
      if (m[t] > bv) { sv = bv; ss = b; bv = m[t]; b = t; }
      else if (m[t] > sv) { sv = m[t]; ss = t; }
    }
    return { b: b, v: bv, s: ss, sv: sv };
  }

  /* 双音判决：行组 0..3 选最强、列组 4..7 选最强，直接取 argmax 组合成符号。
   * 【重要】早期版本要求「行、列最强都要 ≥ 组内第二 ×2.2」才算数，真机上这个门限
   * 太硬：喇叭/麦克风对两条音的衰减差一点、房间里多一条反射尾巴，门限就挂，
   * 同步头 8 个符号一个都凑不出（日志里「同步命中 0/8」的根因）。
   * 现在改成分组 argmax：永远给出一个候选符号，靠「8 符号全对」和 CRC 兜错。
   * 误判的代价被 CRC 挡住，而漏判的代价是整包收不到 —— 两害相权取 argmax。 */
  function classifyDual(x, off, len, sr, band, scale) {
    if (off < 0 || off + len > x.length) return -1;
    var m = new Float64Array(TONES), t;
    for (t = 0; t < TONES; t++) {
      var v = goertzel(x, off, len, toneFreq(band, t, scale), sr);
      m[t] = v >= 0 ? v : 0;
    }
    var R = top2(m, 0, 3), C = top2(m, 4, 7);
    if (!(R.v > 0) || !(C.v > 0)) return -1;
    return R.b * 4 + (C.b - 4);
  }

  /* 只给诊断用：返回组合符号与行/列两个边距（dB），真实判决不看它 */
  function dualMargin(x, off, len, sr, band, scale) {
    if (off < 0 || off + len > x.length) return null;
    var m = new Float64Array(TONES), t;
    for (t = 0; t < TONES; t++) {
      var v = goertzel(x, off, len, toneFreq(band, t, scale), sr);
      m[t] = v >= 0 ? v : 0;
    }
    var R = top2(m, 0, 3), C = top2(m, 4, 7);
    return {
      sym: R.b * 4 + (C.b - 4),
      mr: 20 * Math.log10((R.v + 1e-12) / (R.sv + 1e-12)),
      mc: 20 * Math.log10((C.v + 1e-12) / (C.sv + 1e-12))
    };
  }

  /* 双音 + 亚采样精修（跟 classifyBest 同一套「在 ±span 内找边距最大」的思想） */
  function classifyDualBest(x, off, len, sr, band, span, scale) {
    var best = { sym: 0, margin: -99, delta: 0 };
    var step = Math.max(1, Math.round((span || 0) / 2));
    for (var d = -(span || 0); d <= (span || 0); d += step) {
      var o = off + d;
      if (o < 0 || o + len > x.length) continue;
      var m = new Float64Array(TONES), t;
      for (t = 0; t < TONES; t++) {
        var v = goertzel(x, o, len, toneFreq(band, t, scale), sr);
        m[t] = v >= 0 ? v : 0;
      }
      var R = top2(m, 0, 3), C = top2(m, 4, 7);
      var mr = 20 * Math.log10((R.v + 1e-12) / (R.sv + 1e-12));
      var mc = 20 * Math.log10((C.v + 1e-12) / (C.sv + 1e-12));
      var mg = Math.min(mr, mc);
      if (mg > best.margin) best = { sym: R.b * 4 + (C.b - 4), margin: mg, delta: d };
    }
    return best;
  }

  /* 双音编解码：4 bit/符号，一个字节两个符号 */
  function bytesToSymbols2(u8) {
    var out = new Uint8Array(u8.length * 2);
    for (var i = 0; i < u8.length; i++) {
      out[i * 2] = (u8[i] >> 4) & 15;
      out[i * 2 + 1] = u8[i] & 15;
    }
    return out;
  }
  function symbolsToBytes2(syms) {
    var out = new Uint8Array(Math.floor(syms.length / 2));
    for (var i = 0; i < out.length; i++) out[i] = ((syms[i * 2] & 15) << 4) | (syms[i * 2 + 1] & 15);
    return out;
  }
  function packetSymbols2(payloadLen) {
    return 1 + SYNC2.length + 2 * (2 + payloadLen + 2) + 1;
  }

  /* 频带能量：给频谱条和探测结果用，返回 {peak, mean, ratio, freqs[]} */
  function bandEnergy(x, sr, band) {
    var n = Math.min(x.length, Math.round(sr * 0.08));
    var out = [];
    var peak = 0, sum = 0;
    for (var t = 0; t < TONES; t++) {
      var m = goertzel(x, Math.max(0, x.length - n), n, toneFreq(band, t), sr);
      if (!(m >= 0)) m = 0;
      out.push(m);
      sum += m;
      if (m > peak) peak = m;
    }
    var mean = sum / TONES;
    return { peak: peak, mean: mean, ratio: mean > 0 ? peak / mean : 0, freqs: out };
  }

  /* 逐音能量 + 判决 + 边距（边距=最强音比次强音高多少 dB，是“判得准不准”的直接指标）
   * span：在该偏移附近 ±span 个采样内找边距最大的位置，返回 delta 供调用方跟随时钟漂移。 */
  function classifyBest(x, off, len, sr, band, span, scale) {
    var best = { sym: 0, margin: -99, delta: 0, e: null };
    var step = Math.max(1, Math.round((span || 0) / 2));
    for (var d = -(span || 0); d <= (span || 0); d += step) {
      var o = off + d;
      if (o < 0 || o + len > x.length) continue;
      var top = -1, second = -1, topT = 0, es = new Array(TONES);
      for (var t = 0; t < TONES; t++) {
        var m = goertzel(x, o, len, toneFreq(band, t, scale), sr);
        es[t] = m;
        if (m > top) { second = top; top = m; topT = t; }
        else if (m > second) second = m;
      }
      var margin = 20 * Math.log10((top + 1e-12) / (second + 1e-12));
      if (margin > best.margin) best = { sym: topT, margin: margin, delta: d, e: es };
    }
    return best;
  }

  /* 在 [lo,hi] 里扫峰值频率：用来客观回答“实际发/收的到底是几千赫” */
  function peakFreq(x, sr, lo, hi, step) {
    step = step || 60;
    var n = Math.min(x.length, Math.round(sr * 0.045));    // 取最后 45ms，够稳又便宜
    var off = x.length - n;
    var best = { f: 0, v: -1 };
    for (var f = lo; f <= hi; f += step) {
      var m = goertzel(x, off, n, f, sr);
      if (m > best.v) best = { f: f, v: m };
    }
    // 在峰值附近再做一遍细扫（20 Hz 精度）
    var lo2 = Math.max(lo, best.f - step), hi2 = Math.min(hi, best.f + step);
    for (var g = lo2; g <= hi2; g += 20) {
      var m2 = goertzel(x, off, n, g, sr);
      if (m2 > best.v) best = { f: g, v: m2 };
    }
    return best;
  }
  /* ---------------- 一次性频率测量（自动校准的核心） ----------------
   * 旧办法是「猜 scale、盲扫 17 格、每格等 1.2 秒看能不能解出」——既慢又要人按。
   * 这里改成直接量：把音频降采样到 sr/10（8 个音的 200 Hz 间距仍然分得开），
   * 在 ±5% 内扫 scale，对 8 个音的「在音能量 / 半音距处能量」求和，取总能量最大的那个。
   * 一次遍历就给出绝对 scale，耗时几十毫秒，不需要用户点任何东西。 */
  function measureScale(x, sr, band, lo, hi, step) {
    band = band || BANDS[0];
    lo = lo || 0.97; hi = hi || 1.03; step = step || 0.001;
    var D = 10, fmix = band.f0 - 100;         // 混到 100–1500 Hz 的低频平坦区
    var n = Math.min(x.length, Math.round(sr * 1.0));
    n -= n % D;
    if (n < Math.round(sr * 0.08)) return null;
    var off = x.length - n;
    var m = n / D, srd = sr / D;
    var xd = new Float32Array(m);
    var wmix = TWO_PI * fmix / sr;
    for (var i = 0; i < m; i++) {
      var a = 0, base = off + i * D;
      for (var k = 0; k < D; k++) a += x[base + k] * Math.cos(wmix * (base + k));
      xd[i] = a / D;
    }
    /* 加汉宁窗：24ms 一个音，不加窗时频谱是 sinc，边带能到 −13 dB，
     * 拿 ±30 Hz 去积分会让「错 half 个音距」的 scale 也吃到边带而虚高（实测会锁 0.989）。
     * 加窗后边带压到 −31 dB 以下，音位才干净。 */
    for (var w = 0; w < m; w++) xd[w] *= 0.5 - 0.5 * Math.cos(TWO_PI * w / (m - 1 || 1));
    /* 一次性算整段频谱。然后用「谱峰间距」直接推 scale：
     * 8 个音的间距恒为 band.df（200 Hz），量出峰与峰的间隔就等于量出了频率缩放，
     * 和「哪个音被发得多」无关 —— 数据包里音分布不均也不会把结果带偏（拿能量求和就会被带偏）。 */
    var df2 = 2, fLo = 40, fHi = band.df * (TONES - 1) + 700;
    var nb = Math.floor((fHi - fLo) / df2) + 1;
    var S = new Float64Array(nb);
    for (var b = 0; b < nb; b++) S[b] = goertzel(xd, 0, m, fLo + b * df2, srd);
    var smax = 0;
    for (var bi = 0; bi < nb; bi++) if (S[bi] > smax) smax = S[bi];
    if (!(smax > 0)) return null;

    /* 找谱峰：局部极大 + 高于最大值 15%，再做抛物线插值到亚 bin 精度 */
    var peaks = [];
    for (var p = 2; p < nb - 2; p++) {
      if (S[p] < smax * 0.06) continue;
      if (!(S[p] >= S[p - 1] && S[p] >= S[p + 1])) continue;
      var ym = S[p - 1], y0 = S[p], yp = S[p + 1];
      var den = (ym - 2 * y0 + yp), dd = den ? (ym - yp) / (2 * den) : 0;
      if (dd > 1) dd = 1;
      if (dd < -1) dd = -1;
      peaks.push({ f: fLo + (p + dd) * df2, e: y0 });
    }
    peaks.sort(function (a, b) { return a.f - b.f; });
    /* 合并过近的峰：60 Hz 内只留最强的 */
    var merged = [];
    for (var q = 0; q < peaks.length; q++) {
      var last = merged[merged.length - 1];
      if (last && peaks[q].f - last.f < 60) {
        if (peaks[q].e > last.e) { last.f = peaks[q].f; last.e = peaks[q].e; }
      } else merged.push({ f: peaks[q].f, e: peaks[q].e });
    }
    if (merged.length < 4) return null;

    /* 相邻峰间距做聚类：真正的音距是大多数间距所在的那一簇（漏掉一个音会出现 2 倍间距，自然被排除） */
    var diffs = [];
    for (var q2 = 1; q2 < merged.length; q2++) diffs.push(merged[q2].f - merged[q2 - 1].f);
    var bestC = null;
    for (var c1 = 0; c1 < diffs.length; c1++) {
      var group = [];
      for (var c2 = 0; c2 < diffs.length; c2++) {
        if (Math.abs(diffs[c2] - diffs[c1]) <= diffs[c1] * 0.25) group.push(diffs[c2]);
      }
      if (!bestC || group.length > bestC.length) bestC = group;
    }
    if (!bestC || bestC.length < 2) return null;
    var spacing = 0;
    for (var g = 0; g < bestC.length; g++) spacing += bestC[g];
    spacing /= bestC.length;

    var scale = spacing / band.df;
    if (!(scale > lo * 0.9 && scale < hi * 1.1)) return null;

    /* 用峰间距定出 scale 后，再在 ±0.4% 内用「音周围积分能量」微调一次（把边带影响压到最小） */
    function near(f, halfW) {
      var i0 = Math.floor((f - halfW - fLo) / df2), i1 = Math.ceil((f + halfW - fLo) / df2);
      var e = 0;
      for (var k2 = Math.max(0, i0); k2 <= Math.min(nb - 1, i1); k2++) e += S[k2];
      return e;
    }
    function comb(s) {
      var on = 0, off = 0;
      for (var t = 0; t < TONES; t++) {
        var fo = (band.f0 + t * band.df) * s - fmix;
        on += near(fo, 16);
        off += near(fo + band.df * 0.5, 16);
      }
      return { on: on, off: off, ratio: on / (off + 1e-9) };
    }
    var bestS = scale;
    for (var s2 = scale - 0.004; s2 <= scale + 0.0041; s2 += 0.0004) {
      if (comb(s2).ratio > comb(bestS).ratio) bestS = s2;
    }
    var cb = comb(bestS);
    return { scale: bestS, on: cb.on, off: cb.off, ratio: cb.ratio, spacing: spacing, peaks: merged.length };
  }

  /* 绝对频率测量：在一段音频里找最强的单一频率（粗扫 + 局部细扫 + 抛物线插值）。
   * 只用来测「定位音」，所以范围可以很窄，代价很小。 */
  function measureTone(x, sr, fLo, fHi, step) {
    step = step || 10;
    var n = Math.min(x.length, Math.round(sr * 0.3));
    if (n < Math.round(sr * 0.05)) return null;
    var off = x.length - n;
    var best = { f: fLo, v: -1 };
    for (var f = fLo; f <= fHi; f += step) {
      var m = goertzel(x, off, n, f, sr);
      if (m > best.v) best = { f: f, v: m };
    }
    var lo2 = Math.max(fLo, best.f - step), hi2 = Math.min(fHi, best.f + step);
    for (var g = lo2; g <= hi2 + 1e-9; g += Math.max(1, step / 5)) {
      var m2 = goertzel(x, off, n, g, sr);
      if (m2 > best.v) best = { f: g, v: m2 };
    }
    return best;
  }

  /* 发送前的「标尺音」：一段 300ms 的纯定位音（tone0，绝对频率唯一）+ 几轮同步音。
   * 纯定位音让收端可以「直接量频率」而不是「猜缩放」——这是最稳的一步；
   * 后面的同步音轮次用来验节奏（长度对不上时同步头命中数会掉）。 */
  function makeRuler(sr, band, symMs, rounds, locMs, dual) {
    sr = sr || SR; band = band || BANDS[0];
    symMs = symMs || 24; rounds = Math.max(2, rounds || 4);
    if (dual === undefined) dual = (MODE === 'dual');
    var symLen = Math.round(sr * symMs / 1000);
    var locLen = Math.round(sr * (locMs || 300) / 1000);
    var pat = dual ? SYNC2 : SYNC;
    var total = locLen + pat.length * rounds * symLen;
    var x = new Float32Array(total);
    var step = TWO_PI / sr, p = 0, p1 = 0, p2 = 0;
    var amp = dual ? GAIN * 0.5 : GAIN;
    /* 定位音：双音模式同时发「行0 + 列0」（18100 + 18900），两座峰相距 800 Hz；
     * 单音模式发 tone0（18100）。收端量到绝对频率就能直接算缩放，不用猜。 */
    var lt = dual ? pairTones(0) : [0];
    var wl1 = step * toneFreq(band, lt[0]);
    var wl2 = dual ? step * toneFreq(band, lt[1]) : 0;
    for (var q = 0; q < locLen; q++) {
      x[p++] = dual ? (Math.sin(p1) + Math.sin(p2)) * amp : Math.sin(p1) * amp;
      p1 += wl1; if (p1 > TWO_PI) p1 -= TWO_PI;
      if (dual) { p2 += wl2; if (p2 > TWO_PI) p2 -= TWO_PI; }
    }
    var glide = Math.max(1, Math.round(sr * GLIDE_MS / 1000));
    var pw1 = wl1, pw2 = wl2;
    var gl = Math.min(glide, Math.round(symLen / 4));
    for (var r = 0; r < rounds; r++) {
      for (var i = 0; i < pat.length; i++) {
        var tt = dual ? pairTones(pat[i]) : [pat[i]];
        var tw1 = step * toneFreq(band, tt[0]);
        var tw2 = dual ? step * toneFreq(band, tt[1]) : 0;
        for (var n = 0; n < symLen; n++) {
          var u = (gl && n < gl) ? n / gl : 1;
          var w1 = gl && n < gl ? pw1 + (tw1 - pw1) * u : tw1;
          x[p++] = dual
            ? (Math.sin(p1) + Math.sin(p2)) * amp
            : Math.sin(p1) * amp;
          p1 += w1; if (p1 > TWO_PI) p1 -= TWO_PI;
          if (dual) {
            var w2 = gl && n < gl ? pw2 + (tw2 - pw2) * u : tw2;
            p2 += w2; if (p2 > TWO_PI) p2 -= TWO_PI;
          }
        }
        pw1 = tw1; pw2 = tw2;
      }
    }
    var ramp = Math.max(1, Math.round(sr * RAMP_MS / 1000));
    for (var j = 0; j < ramp && j < total; j++) {
      var g = j / ramp;
      x[j] *= g;
      x[total - 1 - j] *= g;
    }
    return x;
  }

  /* ---------------- 流式解码器（每档频带 × 每种符号长度各跑一个） ---------------- */
  function StreamDecoder(sampleRate, band, symMs, dual) {
    this.sr = sampleRate || SR;
    this.band = band || BANDS[2];
    this.symMs = symMs || 16;
    this.symLen = Math.round(this.sr * this.symMs / 1000);
    this.dual = (dual === undefined) ? (MODE === 'dual') : !!dual;
    this.pat = this.dual ? SYNC2 : SYNC;
    this.cap = this.sr * 12;
    this.buf = new Float32Array(this.cap);
    this.fill = 0;
    this.abs0 = 0;
    this.scanAbs = 0;
    this.syncAbs = -1;
    this.totalSyms = 0;
    this.onPacket = null;
    this.onError = null;
    this.packets = 0;
    this.errors = 0;
    this.stat = { sync: 0, crc: 0, pk: 0 };
    this.lastMargin = 0;
    this.lastMinMargin = 0;
    this.lastDrift = 0;
    this.fScale = FORCED_SCALE || SHARED_SCALE;
    this.forceScale = FORCED_SCALE || null;
    this._busy = false;
    this.maxPayload = 200;
  }

  StreamDecoder.prototype.push = function (chunk) {
    if (this._busy) return;
    if (chunk.length >= this.cap) chunk = chunk.subarray(chunk.length - this.cap);
    var overflow = this.fill + chunk.length - this.cap;
    if (overflow > 0) {
      this.buf.copyWithin(0, overflow, this.fill);
      this.fill -= overflow;
      this.abs0 += overflow;
    }
    this.buf.set(chunk, this.fill);
    this.fill += chunk.length;
    this._busy = true;
    try { this._drain(); } finally { this._busy = false; }
  };

  StreamDecoder.prototype._drain = function () {
    var symLen = this.symLen;
    if (this.syncAbs >= 0) {
      var needEnd = this.syncAbs + this.totalSyms * symLen;
      if (needEnd - this.abs0 <= this.fill) { this._decodePacket(); return; }
      /* 数据还没到齐：先把锁放下、继续扫后面的位置。
       * 回声条件下「先锁上的位置」常常是个差半格的位置，锁住等它反而永远等不到，
       * 放下重扫才能抓住真正对齐的那一份。 */
      if (needEnd > this.abs0 + this.fill + 2 * symLen) { this.syncAbs = -1; }
      else return;
    }
    var step = Math.max(1, symLen >> 2);
    var start = Math.max(this.scanAbs, this.abs0);
    var limit = this.abs0 + this.fill - (this.pat.length + 6) * symLen;

    for (var a = start; a <= limit; a += step) {
      var off = a - this.abs0;
      // 锁的条件分两级，且都必须「验过」才算数：
      //  1) 先用当前缩放（种子/上次估出的）数命中，≥5/8 才进候选 —— 只放宽两票，
      //     放到 4/8 会把大量噪声位置也当候选，反而误锁、把真包跳过去；
      //  2) 候选再在种子 ±0.8% 内细扫缩放（偏移不可能比这更大，扫 ±3% 等于给错解开门），
      //     必须扫到 ≥7/8 才认。
      var hits = this._hitCount(off, symLen, this.fScale);
      if (hits > (this.scanBest || 0)) this.scanBest = hits;
      if (hits < this.pat.length - 4) continue;
      var fs = this.fScale;
      if (hits < this.pat.length - 1) {
        var bestHits = hits, seed = this.fScale;
        for (var s = seed - 0.008; s <= seed + 0.0081; s += 0.0008) {
          var h = this._hitCount(off, symLen, s);
          if (h > bestHits) { bestHits = h; fs = s; }
          if (h >= this.pat.length - 1) break;
        }
        if (bestHits < this.pat.length - 1) continue;
        if (bestHits > (this.scanBest || 0)) this.scanBest = bestHits;
      }

      // 同步头对上了，但粗搜的步长是 1/4 符号，窗口可能跨在两个符号之间 ——
      // 这时候每个符号都能“勉强”判对，CRC 却会挂。这里做一次亚符号级精修。
      var refined = this._refine(off, symLen, fs);
      var a2 = this.abs0 + refined;

      // 精修之后再验一遍：这里必须 ≥7/8，否则就只是噪声凑出来的假锁。
      var ver = this._hitCount(refined, symLen, fs);
      if (ver < this.pat.length - 1) continue;

      // 锁上之后再估一次精确偏移（8 个已知同步音当标尺，精度到 0.05%）
      this.fScale = typeof this.forceScale === 'number' ? this.forceScale : this._estimateScale(refined, symLen, fs);

      var lenNs = this.dual ? 4 : 6;
      var lenSyms = new Uint8Array(lenNs);
      var lg = guardOf(symLen, this.sr), lw = symLen - lg;
      var CL = this.dual ? classifyDual : classify;
      for (var k = 0; k < lenNs; k++) lenSyms[k] = CL(this.buf, refined + (this.pat.length + k) * symLen + lg, lw, this.sr, this.band, this.fScale);
      var lb = this.dual ? symbolsToBytes2(lenSyms) : symbolsToBytes(lenSyms);
      var needLen = lb[0] | (lb[1] << 8);
      if (needLen <= 0 || needLen > this.maxPayload) continue;

      this.syncAbs = a2;
      this.totalSyms = this.pat.length + (this.dual ? 2 : 3) * (2 + needLen + 2);
      this.scanAbs = a2;
      this.lastHits = ver;
      this._diag('lock', 'needLen=' + needLen + ' ver=' + ver);
      this._decodePacket();
      return;
    }
    this.scanAbs = Math.max(this.scanAbs, limit + 1);
  };

  /* 数同步头命中几个音（可按频率缩放判断），判决窗同样只取尾部。
   * 双音模式下每个同步符号要用「行音和列音同时对上」才算命中。 */
  StreamDecoder.prototype._hitCount = function (off, symLen, scale) {
    var hits = 0;
    var g = guardOf(symLen, this.sr), wl = symLen - g;
    var CL = this.dual ? classifyDual : classify;
    for (var i = 0; i < this.pat.length; i++) {
      var o = off + i * symLen + g;
      if (o < 0 || o + wl > this.fill) return hits;
      if (CL(this.buf, o, wl, this.sr, this.band, scale) === this.pat[i]) hits++;
      if (this.pat.length - i - 1 + hits < this.pat.length - 4) break;
    }
    return hits;
  };

  /* 判决只取符号的「后半段」：
   * 房间反射和多径会让每个符号的开头混着上一个音的尾巴，滑音段也在这段里。
   * 直接拿整符号判决时，最佳位置搜索会被前半段拽偏 —— 这正是「同步 7/8 命中、
   * 边距 30 dB 很高，载荷却整段错」的成因。跳掉开头一段，只判尾部，稳得多。 */
  function guardOf(symLen, sr) {
    var g = Math.round((sr || SR) * GUARD_MS / 1000) + Math.round(symLen * 0.12);
    return Math.min(g, Math.round(symLen / 3));
  }

  function winOf(symLen, sr) {
    return symLen - guardOf(symLen, sr);
  }

  /* 在 base 附近找让同步头能量最大的子偏移（双音模式把行音+列音的能量都算进来） */
  StreamDecoder.prototype._refine = function (base, symLen, scale) {
    var q = Math.max(1, symLen >> 2);
    var sub = Math.max(1, q >> 2);
    var g = guardOf(symLen, this.sr), wl = symLen - g;
    var best = base, bestScore = -1;
    for (var d = -q; d <= q; d += sub) {
      var o = base + d;
      if (o < 0 || o + (this.pat.length + 1) * symLen > this.fill) continue;
      var score = 0;
      for (var i = 0; i < this.pat.length; i++) {
        var ts = this.dual ? pairTones(this.pat[i]) : [this.pat[i]];
        for (var k = 0; k < ts.length; k++) {
          var m = goertzel(this.buf, o + i * symLen + g, wl, toneFreq(this.band, ts[k], scale), this.sr);
          if (m > 0) score += m;
        }
      }
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  };

  /* 估频率偏移：两端晶振一旦差 1%，18k 上就是 180 Hz —— 差不多一个音距（200 Hz），
   * 判音会“很自信”地判到隔壁音上，边距很漂亮但字节全错、CRC 必挂。
   * 用同步头这 8 个已知音当标尺，在 seed 附近细扫，取匹配最好的那个。 */
  StreamDecoder.prototype._estimateScale = function (base, symLen, seed) {
    seed = seed || 1;
    var best = seed, bestScore = -1;
    var g = guardOf(symLen, this.sr), wl = symLen - g;
    var lo = Math.max(0.95, seed - 0.006), hi = Math.min(1.05, seed + 0.006);
    for (var s = lo; s <= hi + 1e-9; s += 0.0002) {
      var score = 0;
      for (var i = 0; i < this.pat.length; i++) {
        var o = base + i * symLen + g;
        if (o < 0 || o + wl > this.fill) { score = -1; break; }
        var ts = this.dual ? pairTones(this.pat[i]) : [this.pat[i]];
        for (var k = 0; k < ts.length; k++) {
          var m = goertzel(this.buf, o, wl, toneFreq(this.band, ts[k], s), this.sr);
          score += m;
        }
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    this.fScale = best;
    if (!FORCED_SCALE) SHARED_SCALE = best;
    return best;
  };

  /* 在窗口里找「对得最齐的一处同步头」命中几个音（8 个音为一组，按 1/4 符号步长滑） */
  StreamDecoder.prototype._syncHitsInWindow = function (winStart, winLen, scale) {
    var symLen = this.symLen, span = this.pat.length * symLen, best = 0;
    var step = Math.max(1, Math.round(symLen / 4));
    for (var o = 0; o + span <= winLen; o += step) {
      var h = this._hitCount(winStart + o, symLen, scale);
      if (h > best) best = h;
      if (best >= this.pat.length) break;
    }
    return best;
  };

  /* 定位校准（首选）：直接从音频里量「绝对频率」，不猜缩放。
   *  1) 在 band.f0 的 ±6% 内找最强单频（定位音 tone0，或数据里最强的某个音）；
   *  2) 最强音可能是 8 个音里的任意一个，所以把「峰频率 / 每个可能音」都当候选缩放；
   *  3) 每个候选都拿「同步头命中数」验 —— 只有真能对上同步头（≥6/8）的那个才算。
   * 这一步不依赖当前 fScale，所以上一轮被写歪了也能自己拉回来。 */
  StreamDecoder.prototype.locateScale = function (winMs) {
    var need = Math.round(this.sr * (winMs || 420) / 1000);
    if (this.fill < need + 32) return null;
    var ws = this.fill - need;
    var win = this.buf.subarray(ws, this.fill);
    var pk = measureTone(win, this.sr, this.band.f0 * 0.94, this.band.f0 * 1.06, 10);
    if (!pk || !(pk.v > 0)) return null;
    var cands = [];
    for (var t = 0; t < TONES; t++) cands.push(pk.f / (this.band.f0 + t * this.band.df));
    var best = { scale: this.fScale, hits: 0 };
    for (var i = 0; i < cands.length; i++) {
      var s = cands[i];
      if (s < 0.94 || s > 1.06) continue;
      var h = this._syncHitsInWindow(ws, need, s);
      if (h >= best.hits) best = { scale: s, hits: h };
      if (h >= this.pat.length) break;
    }
    var ok = best.hits >= 6;
    if (ok) {
      var changed = Math.abs(best.scale - this.fScale) > 1.5e-4;
      this.fScale = best.scale;
      if (!FORCED_SCALE) SHARED_SCALE = best.scale;
      if (changed) { this.syncAbs = -1; }
    }
    this.lastCal = {
      mode: 'locate', scale: ok ? best.scale : this.fScale, ok: ok, hits: best.hits,
      measured: pk.f / this.band.f0, toneF: pk.f, ratio: 0,
      at: (typeof performance !== 'undefined' ? performance.now() : Date.now())
    };
    return this.lastCal;
  };

  /* 自动校准：不需要用户点按钮，也不需要盲扫等 20 秒。
   * 两步走：
   *  1) measureScale 从频谱粗测一个 scale（一次遍历，几十毫秒）；
   *  2) 在粗测值附近 ±3% 用「同步头真命中数」逐格验 —— 命中数才是硬指标，
   *     谁的 scale 能把 8 个同步音对上 5 个以上，谁就是对的。命中数不够就不改，
   *     绝不用噪声去「校」出一个越校越偏的偏移。 */
  StreamDecoder.prototype.autoCalibrate = function (msLen) {
    var need = Math.round(this.sr * (msLen || 420) / 1000);
    if (this.fill < need + 32) return null;
    var ws = this.fill - need;
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    /* 第一优先：绝对频率定位（不依赖当前 fScale，被写歪也能救回来）。 */
    var loc = this.locateScale(msLen);
    if (loc && loc.ok) return loc;
    var r = measureScale(this.buf.subarray(ws, this.fill), this.sr, this.band, 0.94, 1.06, 0.001);
    var seed = r ? r.scale : this.fScale;
    var best = { hits: 0, scale: seed };
    var hitsNow = this._syncHitsInWindow(ws, need, this.fScale);
    for (var k = -15; k <= 15; k++) {
      var s = seed + k * 0.002;
      if (s < 0.94 || s > 1.06) continue;
      var h = this._syncHitsInWindow(ws, need, s);
      if (h > best.hits || (h === best.hits && Math.abs(s - this.fScale) < Math.abs(best.scale - this.fScale))) {
        best = { hits: h, scale: s };
      }
      if (h >= this.pat.length) break;
    }
    /* 门槛：必须能对到 7/8 以上，而且必须明显好于当前值。
     * 以前是 6/8，实测在标尺上会把 0.9958 这种错值也「验证通过」，一旦写进去就再也锁不上。 */
    var ok = best.hits >= this.pat.length - 1 && best.hits > hitsNow;
    if (ok) {
      var changed = Math.abs(best.scale - this.fScale) > 2e-4;
      this.fScale = best.scale;
      if (!FORCED_SCALE) SHARED_SCALE = best.scale;
      if (changed) this.syncAbs = -1;              // 缩放大改后，原来锁的位置作废，重扫
    }
    this.lastCal = { mode: 'comb', scale: this.fScale, ok: ok, hits: best.hits, measured: seed, ratio: r ? r.ratio : 0, at: now };
    return this.lastCal;
  };

  /* 诊断输出：把每次「锁上 / CRC 失败 / 收到包」摊平成一行文本，页面直接落日志，
   * 出问题时把这份日志整段拷出来就能定位（不用靠猜）。 */
  StreamDecoder.prototype._diag = function (type, extra) {
    if (!this.onDiag) return;
    this.onDiag({
      t: type,
      band: this.band && this.band.name,
      sym: this.symMs,
      hits: this.lastHits,
      scale: this.fScale,
      margin: this.lastMargin,
      minMargin: this.lastMinMargin,
      drift: this.lastDrift,
      info: extra || ''
    });
  };

  StreamDecoder.prototype._decodePacket = function () {
    var symLen = this.symLen;
    var base = this.syncAbs - this.abs0;
    var need = this.totalSyms * symLen;
    if (base < 0 || base + need > this.fill) return;

    // 逐符号跟随时钟：手机的 DAC 和电脑的 ADC 各走各的晶振，几百 ppm 的偏差
    // 摊到 2 秒的包上就是几毫秒 —— 后半段的窗口会跨到隔壁符号，CRC 必挂。
    // 所以每个符号都在 ±1/12 符号内重新找一次最佳位置，把偏差带进下一个符号。
    // 窗口只取符号尾部（跳过回声与滑音），偏差必须钳住，否则会自己越拽越偏。
    var g = guardOf(symLen, this.sr), wl = symLen - g;
    var span = Math.max(2, Math.round(symLen / 12));
    var clamp = Math.max(2, Math.round(symLen / 20));
    var syms = new Uint8Array(this.totalSyms);
    var cur = base, drift = 0, sumMargin = 0, minMargin = 99;
    for (var i = 0; i < this.totalSyms; i++) {
      var r = (this.dual ? classifyDualBest : classifyBest)(this.buf, Math.round(cur) + g, wl, this.sr, this.band, span, this.fScale);
      syms[i] = r.sym;
      sumMargin += r.margin;
      if (r.margin < minMargin) minMargin = r.margin;
      drift = drift * 0.7 + r.delta * 0.3;
      if (drift > clamp) drift = clamp;
      if (drift < -clamp) drift = -clamp;
      cur += symLen + drift;
    }
    this.lastMargin = this.totalSyms ? sumMargin / this.totalSyms : 0;
    this.lastMinMargin = minMargin;
    this.lastDrift = drift;

    var syncOk = true, hits = 0;
    for (var j = 0; j < this.pat.length; j++) if (syms[j] === this.pat[j]) hits++;
    this.lastHits = hits;
    if (hits < this.pat.length - 2) syncOk = false;
    if (!syncOk) {
      this.errors++;
      this.stat.sync++;
      this._diag('sync', 'hits=' + hits + '/8 包内复检不过');
      if (this.onError) this.onError('sync', this.lastMargin);
      this.syncAbs = -1;
      this.scanAbs = Math.max(this.scanAbs, base + this.abs0 + symLen);
      return;
    }
    var body = this.dual ? symbolsToBytes2(syms.subarray(this.pat.length)) : symbolsToBytes(syms.subarray(this.pat.length));
    var payload = parsePacket(body);
    if (!payload) {
      this.errors++;
      this.stat.crc++;
      this._diag('crc', 'len=' + (body[0] | (body[1] << 8)) + ' crc=' + (body[2] | (body[3] << 8)) +
        ' sym0..3=' + syms[this.pat.length] + ',' + syms[this.pat.length + 1] + ',' + syms[this.pat.length + 2] + ',' + syms[this.pat.length + 3]);
      if (this.onError) this.onError('crc', this.lastMargin);
      // 失败只往后挪一个符号：回声里「差一点对齐」的位置常常是下一个才对得上的，整包跳过会把机会丢掉
      this.syncAbs = -1;
      this.scanAbs = Math.max(this.scanAbs, base + this.abs0 + symLen);
      return;
    }
    this.packets++;
    this.stat.pk++;
    this._diag('ok', 'type=' + payload[0] + ' seq=' + payload[1] + '/' + payload[2] + ' n=' + payload.length);
    if (this.onPacket) this.onPacket(payload, this.lastMargin);
    this.syncAbs = -1;
    /* 解成功的包，整段跳过。
     * 以前只跳同步头，结果同一个包会顺着扫描被反复「重新锁上、重新解出」：
     * 真机日志里就是同一个包连着 100 多条 OK、后面几包一个都进不来，
     * 接收端因此永远处于「在收包」状态，连回执都不发，发端只能一直重发。 */
    this.scanAbs = Math.max(this.scanAbs, base + this.abs0 + this.totalSyms * symLen);
  };

  /* ---------------- 载荷类型与分块 ---------------- */
  var T_PROBE = 0, T_TEXT = 1, T_FILE_HEAD = 2, T_FILE_CHUNK = 3;

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new Uint8Array(new TextEncoder().encode(str));
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function fromUtf8(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /* 文字分块：每块 ≤ 64 字节，块头 [T_TEXT][seq][total][data] */
  function chunkText(text, chunkBytes) {
    chunkBytes = chunkBytes || 64;
    var bytes = utf8(text);
    var total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
    var out = [];
    for (var i = 0; i < total; i++) {
      var slice = bytes.subarray(i * chunkBytes, Math.min(bytes.length, (i + 1) * chunkBytes));
      var p = new Uint8Array(3 + slice.length);
      p[0] = T_TEXT; p[1] = i; p[2] = total;
      p.set(slice, 3);
      out.push(p);
    }
    return out;
  }

  function joinText(parts, total) {
    var all = [];
    for (var i = 0; i < total; i++) {
      if (!parts[i]) return null;
      for (var k = 0; k < parts[i].length; k++) all.push(parts[i][k]);
    }
    return fromUtf8(new Uint8Array(all));
  }

  /* 文件分块：头 [T_FILE_HEAD][seq 0][总块][名长][名][大小 u32] */
  function fileHead(name, size, totalChunks) {
    var nb = utf8(name).subarray(0, 60);
    var p = new Uint8Array(5 + nb.length + 4);
    p[0] = T_FILE_HEAD; p[1] = 0; p[2] = totalChunks;
    p[3] = nb.length;
    p.set(nb, 4);
    p[4 + nb.length] = size & 0xff;
    p[5 + nb.length] = (size >>> 8) & 0xff;
    p[6 + nb.length] = (size >>> 16) & 0xff;
    p[7 + nb.length] = (size >>> 24) & 0xff;
    return p;
  }

  function fileChunk(bytes, index, total, chunkBytes) {
    chunkBytes = chunkBytes || 64;
    var slice = bytes.subarray(index * chunkBytes, Math.min(bytes.length, (index + 1) * chunkBytes));
    var p = new Uint8Array(4 + slice.length);
    p[0] = T_FILE_CHUNK; p[1] = index & 0xff; p[2] = total & 0xff; p[3] = slice.length;
    p.set(slice, 4);
    return p;
  }

  function parsePayload(p) {
    if (!p || !p.length) return null;
    var t = p[0];
    if (t === T_TEXT) return { type: 'text', seq: p[1], total: p[2], data: p.subarray(3) };
    if (t === T_FILE_HEAD) {
      var nl = p[3];
      return {
        type: 'fileHead', total: p[2], name: fromUtf8(p.subarray(4, 4 + nl)),
        size: (p[4 + nl] | (p[5 + nl] << 8) | (p[6 + nl] << 16) | (p[7 + nl] << 24)) >>> 0
      };
    }
    if (t === T_FILE_CHUNK) return { type: 'fileChunk', seq: p[1], total: p[2], data: p.subarray(4) };
    if (t === T_PROBE) return { type: 'probe' };
    if (t === T_ACK) {
      var a = parseAck(p);
      if (a) return { type: 'ack', round: a.round, total: a.total, has: a.has, missing: a.missing, diag: a.diag };
      return null;
    }
    return null;
  }

  /* ---------------- 发送器 ---------------- */
  function Tx(ctx) {
    this.ctx = ctx;
    this.busy = false;
    this.out = null;          // 可插一个 AnalyserNode 做自检
  }

  Tx.prototype.play = function (samples, onDone) {
    var self = this;
    var buf = self.ctx.createBuffer(1, samples.length, self.ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    var src = self.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(self.out || self.ctx.destination);
    self.busy = true;
    self._src = src;
    var done = function () {
      if (fired) return;          // onended 和兜底 setTimeout 都会来，只能算一次
      fired = true;
      self.busy = false;
      if (self._src === src) self._src = null;
      if (onDone) onDone();
    };
    var fired = false;
    src.onended = done;
    src.start();
    var ms = samples.length / self.ctx.sampleRate * 1000 + 300;
    setTimeout(done, ms);
    return src;
  };

  /* 硬停：把正在放的那一段直接掐掉，不等它自然结束。
   * 循环发/长包发送时用户按「停」，必须真的立刻没声音。 */
  Tx.prototype.stop = function () {
    if (this._src) {
      try { this._src.onended = null; } catch (e) {}
      try { this._src.stop(); } catch (e) {}
      try { this._src.disconnect(); } catch (e) {}
      this._src = null;
    }
    this.busy = false;
  };

  Tx.prototype.send = function (packet, band, symMs, onDone) {
    var wave = makeWaveform(packet, this.ctx.sampleRate, band, symMs);
    return this.play(wave, onDone);
  };

  /* 每次发送前自动校准：先播一段标尺音（8 个同步音轮流几遍），紧接着才是数据。
   * 收端只要听到标尺，就能在一段音频里量出本链路的频率缩放 —— 不用人点「校正」。 */
  Tx.prototype.sendCal = function (packet, band, symMs, rounds, onDone) {
    var sr = this.ctx.sampleRate;
    var ruler = makeRuler(sr, band, symMs, rounds || 5);
    var wave = makeWaveform(packet, sr, band, symMs);
    var all = new Float32Array(ruler.length + wave.length);
    all.set(ruler, 0);
    all.set(wave, ruler.length);
    return this.play(all, onDone);
  };

  Tx.prototype.ruler = function (band, symMs, rounds) {
    return makeRuler(this.ctx.sampleRate, band, symMs, rounds || 5);
  };

  Tx.prototype.probe = function (band, ms, onDone) {
    return this.play(makeProbe(this.ctx.sampleRate, band, ms), onDone);
  };

  function openMic() {
    var audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    return navigator.mediaDevices.getUserMedia({ audio: audio, video: false })
      .catch(function () { return navigator.mediaDevices.getUserMedia({ audio: true }); });
  }

  function makeCtx() {
    var C = window.AudioContext || window.webkitAudioContext;
    try { return new C({ sampleRate: SR }); } catch (e) { return new C(); }
  }

  function bytesPerSecond(symMs) { return Math.floor(3 / 3 * 1000 / symMs); }   // 3 bit/符号

  var Ultra = {
    SR: SR, TONES: TONES, SYNC: SYNC, BANDS: BANDS,
    bandByKey: bandByKey, toneFreq: toneFreq,
    crc16: crc16, crc8: crc8,
    buildPacket: buildPacket, parsePacket: parsePacket,
    bytesToSymbols: bytesToSymbols, symbolsToBytes: symbolsToBytes,
    bytesToSymbols2: bytesToSymbols2, symbolsToBytes2: symbolsToBytes2,
    packetSymbols2: packetSymbols2, SYNC2: SYNC2, pairTones: pairTones,
    classifyDual: classifyDual, classifyDualBest: classifyDualBest, dualMargin: dualMargin,
    setMode: setMode, getMode: getMode,
    makeWaveformDual: makeWaveformDual,
    packetSymbols: packetSymbols,
    makeWaveform: makeWaveform, makeProbe: makeProbe,
    goertzel: goertzel, classify: classify, bandEnergy: bandEnergy,
    classifyBest: classifyBest, peakFreq: peakFreq,
    measureScale: measureScale, makeRuler: makeRuler,
    getGain: function () { return GAIN; },
    getScale: function () { return FORCED_SCALE || SHARED_SCALE; },
    setForcedScale: function (v) { FORCED_SCALE = (+v && Math.abs(+v - 1) > 1e-6) ? +v : 0; return FORCED_SCALE; },
    setGain: function (g) { GAIN = Math.max(0.1, Math.min(0.98, +g || 0.7)); return GAIN; },
    StreamDecoder: StreamDecoder, Tx: Tx, openMic: openMic, makeCtx: makeCtx,
    utf8: utf8, fromUtf8: fromUtf8,
    chunkText: chunkText, joinText: joinText,
    ackPayload: ackPayload, parseAck: parseAck,
    fileHead: fileHead, fileChunk: fileChunk, parsePayload: parsePayload,
    T_PROBE: T_PROBE, T_TEXT: T_TEXT, T_FILE_HEAD: T_FILE_HEAD, T_FILE_CHUNK: T_FILE_CHUNK,
    bytesPerSecond: bytesPerSecond
  };

  root.Ultra = Ultra;
  if (typeof module !== 'undefined' && module.exports) module.exports = Ultra;
})(typeof globalThis !== 'undefined' ? globalThis : this);
