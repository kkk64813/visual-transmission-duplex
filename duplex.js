/* duplex.js —— 20.5~22.0 kHz 超声反向控制通道（AirBridge 双工内核）
 *
 * 设计要点（跟旧版 17.5 kHz 那套的区别）：
 *  1. 频带整体上移到 20.5–22.0 kHz，落在人耳上限之上，正常环境听不见。
 *  2. 符号 16ms（187.5 bps）。手机扬声器在 20k 以上普遍衰减 15–25 dB，
 *     用更长的符号换信噪比，这条不能省。
 *  3. 符号之间保持相位连续，只在包首尾做 2ms 斜坡 —— 高频突变会产生宽带咔哒声，
 *     既刺耳又会污染相邻音。首尾各加一个哨兵符号，专门吸收这段斜坡。
 *  4. 包长极短：5 字节状态 → 8 字节 → 24 符号 → 加哨兵共 34 符号 ≈ 0.54 秒。
 *     （旧方案 75 字节位图要 3.1 秒，这里轻了 6 倍，因为 cimbar 用喷泉码不需要点名。）
 *
 * 采样率必须锁 48000。44.1k 设备奈奎斯特只有 22.05 kHz，22k 音压在边缘会失真。
 */
(function (root) {
  'use strict';

  var SR = 48000;
  var F0 = 20500;          // 首音
  var DF = 214;            // 音距：20500..21998，7 段
  var TONES = 8;
  var SYM_MS = 16;         // 187.5 bps
  var SYNC = [1, 5, 3, 7, 2, 6, 4, 0];   // 8 个互不相同的符号，避免连续同音
  var GAIN = 0.55;         // 20k+ 衰减大，幅度给足
  var RAMP_MS = 2;         // 仅包首尾斜坡

  var TWO_PI = Math.PI * 2;

  /* ---------------- CRC8 (poly 0x07) ---------------- */
  function crc8(u8) {
    var c = 0;
    for (var i = 0; i < u8.length; i++) {
      c ^= u8[i];
      for (var k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c & 0xff;
  }

  /* ---------------- 包格式：[u16 长度][载荷][crc8] ---------------- */
  function buildPacket(payload) {
    var n = payload.length;
    var out = new Uint8Array(2 + n + 1);
    out[0] = n & 0xff;
    out[1] = (n >> 8) & 0xff;
    out.set(payload, 2);
    out[2 + n] = crc8(payload);
    return out;
  }

  function parsePacket(bytes) {
    if (bytes.length < 3) return null;
    var n = bytes[0] | (bytes[1] << 8);
    if (n <= 0 || bytes.length < 3 + n) return null;
    var payload = bytes.subarray(2, 2 + n);
    if (bytes[2 + n] !== crc8(payload)) return null;
    return payload;
  }

  /* ---------------- 3 bit / 符号，3 符号 / 字节 ---------------- */
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

  // 一个包占多少符号：哨兵 + 同步头 + 3×(2+载荷+1) + 哨兵
  function packetSymbols(payloadLen) {
    return 1 + SYNC.length + 3 * (2 + payloadLen + 1) + 1;
  }

  function packetDuration(payloadLen, sr) {
    var symLen = Math.round((sr || SR) * SYM_MS / 1000);
    return packetSymbols(payloadLen) * symLen / (sr || SR);
  }

  function bitrate() { return Math.round(1000 / SYM_MS * 3); }   // 187

  function toneFreq(sym) { return F0 + sym * DF; }

  /* ---------------- 调制：相位连续 ---------------- */
  function makeWaveform(packet, sr) {
    sr = sr || SR;
    var symLen = Math.round(sr * SYM_MS / 1000);
    var data = bytesToSymbols(packet);
    // 构造符号序列：[哨兵] SYNC 载荷 [哨兵]
    var syms = new Uint8Array(2 + SYNC.length + data.length);
    syms[0] = SYNC[0];
    for (var i = 0; i < SYNC.length; i++) syms[1 + i] = SYNC[i];
    syms.set(data, 1 + SYNC.length);
    syms[syms.length - 1] = SYNC[0];

    var total = syms.length * symLen;
    var x = new Float32Array(total);
    var step = TWO_PI / sr;
    var phase = 0;
    var p = 0;
    for (var s = 0; s < syms.length; s++) {
      var w = step * toneFreq(syms[s]);
      for (var n = 0; n < symLen; n++) {
        x[p++] = Math.sin(phase) * GAIN;
        phase += w;
        if (phase > TWO_PI) phase -= TWO_PI;
      }
    }
    // 只在整个波形首尾做斜坡，符号交界处幅度不变（相位连续不会产生咔哒）
    var ramp = Math.round(sr * RAMP_MS / 1000);
    if (ramp < 1) ramp = 1;
    for (var k = 0; k < ramp && k < total; k++) {
      var g = k / ramp;
      x[k] *= g;
      x[total - 1 - k] *= g;
    }
    return x;
  }

  /* ---------------- 解调：Goertzel ---------------- */
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

  function classify(x, off, len, sr) {
    if (off < 0 || off + len > x.length) return -1;
    var mags = new Float64Array(TONES);
    var sum = 0, best = 0;
    for (var t = 0; t < TONES; t++) {
      var m = goertzel(x, off, len, toneFreq(t), sr);
      if (!(m >= 0)) m = 0;                  // NaN/负值一律当 0，别让它污染判决
      mags[t] = m;
      sum += m;
      if (m > mags[best]) best = t;
    }
    var mean = sum / TONES;
    if (mags[best] <= 0) return -1;
    if (mags[best] < mean * 2.5) return -1;  // 没有明显峰，判为噪声
    return best;
  }

  /* ---------------- 流式解码器 ---------------- */
  function StreamDecoder(sampleRate) {
    this.sr = sampleRate || SR;
    this.symLen = Math.round(this.sr * SYM_MS / 1000);
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
    this._busy = false;
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

    // 1) 已同步：等整包齐
    if (this.syncAbs >= 0) {
      var needEnd = this.syncAbs + this.totalSyms * symLen;
      if (needEnd - this.abs0 <= this.fill) { this._decodePacket(); return; }
      if (needEnd > this.abs0 + this.fill + 2 * symLen) { this.syncAbs = -1; }
      else return;
    }

    // 2) 搜同步头。
    //    上限必须留出「同步头 + 6 个长度符号」的余量，否则读长度会越界读到缓冲外，
    //    Goertzel 拿到 undefined 算出 NaN，被误判成音 0，进而跳过真正的同步位置。
    var step = Math.max(1, symLen >> 2);
    var start = Math.max(this.scanAbs, this.abs0);
    var limit = this.abs0 + this.fill - (SYNC.length + 6) * symLen;

    for (var a = start; a <= limit; a += step) {
      var off = a - this.abs0;
      if (classify(this.buf, off, symLen, this.sr) !== SYNC[0]) continue;
      var ok = true;
      for (var i = 1; i < SYNC.length; i++) {
        if (classify(this.buf, off + i * symLen, symLen, this.sr) !== SYNC[i]) { ok = false; break; }
      }
      if (!ok) continue;

      // 读长度字段
      var lenSym = new Uint8Array(6);
      var lb = symbolsToBytes(new Uint8Array([
        classify(this.buf, off + (SYNC.length) * symLen, symLen, this.sr),
        classify(this.buf, off + (SYNC.length + 1) * symLen, symLen, this.sr),
        classify(this.buf, off + (SYNC.length + 2) * symLen, symLen, this.sr),
        classify(this.buf, off + (SYNC.length + 3) * symLen, symLen, this.sr),
        classify(this.buf, off + (SYNC.length + 4) * symLen, symLen, this.sr),
        classify(this.buf, off + (SYNC.length + 5) * symLen, symLen, this.sr)
      ]));
      var needLen = lb[0] | (lb[1] << 8);
      if (needLen <= 0 || needLen > 64) continue;   // 状态包只有 5 字节，超过 64 一律当误判

      this.syncAbs = a;
      this.totalSyms = SYNC.length + 3 * (2 + needLen + 1);
      this.scanAbs = a;
      this._decodePacket();
      return;
    }
    this.scanAbs = Math.max(this.scanAbs, limit + 1);
  };

  StreamDecoder.prototype._decodePacket = function () {
    var symLen = this.symLen;
    var base = this.syncAbs - this.abs0;
    var need = this.totalSyms * symLen;
    if (base < 0 || base + need > this.fill) return;

    var syms = new Uint8Array(this.totalSyms);
    for (var i = 0; i < this.totalSyms; i++) {
      syms[i] = classify(this.buf, base + i * symLen, symLen, this.sr);
    }

    // 校验同步头：a 就是 SYNC[0] 的绝对位置，所以从 0 开始比
    var syncOk = true;
    for (var j = 0; j < SYNC.length; j++) {
      if (syms[j] !== SYNC[j]) { syncOk = false; break; }
    }
    if (!syncOk) {
      this.errors++;
      if (this.onError) this.onError('sync');
      this.syncAbs = -1;
      this.scanAbs = Math.max(this.scanAbs, base + this.abs0 + 1);
      return;
    }

    var body = symbolsToBytes(syms.subarray(SYNC.length));
    var payload = parsePacket(body);
    if (!payload) {
      this.errors++;
      if (this.onError) this.onError('crc');
    } else {
      this.packets++;
      if (this.onPacket) this.onPacket(payload);
    }
    this.syncAbs = -1;
    this.scanAbs = Math.max(this.scanAbs, base + this.abs0 + need - symLen);
  };

  /* ---------------- 发送器 ---------------- */
  function Tx(ctx) {
    this.ctx = ctx;
    this.busy = false;
  }

  Tx.prototype.send = function (packet) {
    var self = this;
    var wave = makeWaveform(packet, self.ctx.sampleRate);
    var buf = self.ctx.createBuffer(1, wave.length, self.ctx.sampleRate);
    buf.getChannelData(0).set(wave);
    var src = self.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(self.ctx.destination);
    src.onended = function () { self.busy = false; };
    self.busy = true;
    src.start();
    // 兜底：个别 WebView 的 onended 偶尔不触发，卡住 busy 会让状态包彻底断流。
    // 按波形时长 + 400ms 强制解锁，宁可重叠一包也不断流。
    var ms = wave.length / self.ctx.sampleRate * 1000 + 400;
    setTimeout(function () { self.busy = false; }, ms);
    return src;
  };

  /* ---------------- 麦克风（必须关 DSP） ---------------- */
  function openMic() {
    var audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    return navigator.mediaDevices.getUserMedia({ audio: audio, video: false })
      .catch(function () { return navigator.mediaDevices.getUserMedia({ audio: true }); });
  }

  function makeCtx() {
    var C = window.AudioContext || window.webkitAudioContext;
    try { return new C({ sampleRate: SR }); } catch (e) { return new C(); }
  }

  /* ---------------- 状态包：[flags][mode][needLo][needHi][fps] ---------------- */
  var F_DONE = 1, F_DOWN = 2, F_UP = 4;

  function packStatus(s) {
    var out = new Uint8Array(5);
    out[0] = (s.done ? F_DONE : 0) | (s.down ? F_DOWN : 0) | (s.up ? F_UP : 0);
    out[1] = s.mode & 0xff;
    var need = Math.max(0, Math.min(65535, s.need | 0));
    out[2] = need & 0xff;
    out[3] = (need >> 8) & 0xff;
    out[4] = s.fps & 0xff;
    return out;
  }

  function unpackStatus(u8) {
    if (!u8 || u8.length < 5) return null;
    return {
      done: !!(u8[0] & F_DONE),
      down: !!(u8[0] & F_DOWN),
      up: !!(u8[0] & F_UP),
      mode: u8[1],
      need: (u8[2] | (u8[3] << 8)) >>> 0,
      fps: u8[4]
    };
  }

  var Duplex = {
    SR: SR, F0: F0, DF: DF, TONES: TONES, SYM_MS: SYM_MS, SYNC: SYNC,
    F_DONE: F_DONE, F_DOWN: F_DOWN, F_UP: F_UP,
    bitrate: bitrate, toneFreq: toneFreq, packetSymbols: packetSymbols,
    packetDuration: packetDuration,
    crc8: crc8, buildPacket: buildPacket, parsePacket: parsePacket,
    bytesToSymbols: bytesToSymbols, symbolsToBytes: symbolsToBytes,
    makeWaveform: makeWaveform, goertzel: goertzel, classify: classify,
    StreamDecoder: StreamDecoder, Tx: Tx, openMic: openMic, makeCtx: makeCtx,
    packStatus: packStatus, unpackStatus: unpackStatus
  };

  root.Duplex = Duplex;
  if (typeof module !== 'undefined' && module.exports) module.exports = Duplex;
})(typeof globalThis !== 'undefined' ? globalThis : this);
