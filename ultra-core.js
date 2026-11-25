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
  var GAIN = 0.85;          // 超声段衰减大，幅度给足（0.85 仍不削顶）
  var RAMP_MS = 3;
  var TWO_PI = Math.PI * 2;

  /* 两档频带（音距 200 Hz，8 音共 1400 Hz 宽；两档中间留 1000 Hz 隔离，避免互串）：
   *  mid 18.1–19.5 kHz：实测 18 kHz 以上就听不见了，而手机扬声器/笔记本麦克风在这段
   *                     响应明显好于 20 k 以上 —— 定为主力。
   *  hi  20.5–21.9 kHz：最安静，但不少设备在这段压根没响应，只当兜底。 */
  var BANDS = [
    { key: 'mid', name: '18.1k', f0: 18100, df: 200, label: '推荐', desc: '人耳听阈之上，且手机扬声器、笔记本麦克风在这段响应最好，日常就用这档' },
    { key: 'hi', name: '20.5k', f0: 20500, df: 200, label: '最静', desc: '几乎不可能听到，但不少设备在这段没有响应，作为兜底' }
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
    return 1 + SYNC.length + 3 * (2 + payloadLen + 2) + 1;
  }

  /* ---------------- 调制 ---------------- */
  function toneFreq(band, sym) { return band.f0 + sym * band.df; }

  function makeWaveform(packet, sr, band, symMs) {
    sr = sr || SR;
    band = band || BANDS[2];
    symMs = symMs || 16;
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
    for (var s = 0; s < syms.length; s++) {
      var w = step * toneFreq(band, syms[s]);
      for (var n = 0; n < symLen; n++) {
        x[p++] = Math.sin(phase) * GAIN;
        phase += w;
        if (phase > TWO_PI) phase -= TWO_PI;
      }
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

  function classify(x, off, len, sr, band) {
    if (off < 0 || off + len > x.length) return -1;
    var mags = new Float64Array(TONES), sum = 0, best = 0;
    for (var t = 0; t < TONES; t++) {
      var m = goertzel(x, off, len, toneFreq(band, t), sr);
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

  /* ---------------- 流式解码器（每档频带各跑一个） ---------------- */
  function StreamDecoder(sampleRate, band, symMs) {
    this.sr = sampleRate || SR;
    this.band = band || BANDS[2];
    this.symMs = symMs || 16;
    this.symLen = Math.round(this.sr * this.symMs / 1000);
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
      if (needEnd > this.abs0 + this.fill + 2 * symLen) { this.syncAbs = -1; }
      else return;
    }
    var step = Math.max(1, symLen >> 2);
    var start = Math.max(this.scanAbs, this.abs0);
    var limit = this.abs0 + this.fill - (SYNC.length + 6) * symLen;

    for (var a = start; a <= limit; a += step) {
      var off = a - this.abs0;
      if (classify(this.buf, off, symLen, this.sr, this.band) !== SYNC[0]) continue;
      var ok = true;
      for (var i = 1; i < SYNC.length; i++) {
        if (classify(this.buf, off + i * symLen, symLen, this.sr, this.band) !== SYNC[i]) { ok = false; break; }
      }
      if (!ok) continue;

      // 同步头对上了，但粗搜的步长是 1/4 符号，窗口可能跨在两个符号之间 ——
      // 这时候每个符号都能“勉强”判对，CRC 却会挂。这里做一次亚符号级精修：
      // 在 ±1/4 符号内试若干偏移，取「同步头 8 个符号在各自目标频率上的能量和」最大的那个。
      var refined = this._refine(off, symLen);
      var a2 = this.abs0 + refined;

      var lenSyms = new Uint8Array(6);
      for (var k = 0; k < 6; k++) lenSyms[k] = classify(this.buf, refined + (SYNC.length + k) * symLen, symLen, this.sr, this.band);
      var lb = symbolsToBytes(lenSyms);
      var needLen = lb[0] | (lb[1] << 8);
      if (needLen <= 0 || needLen > this.maxPayload) continue;

      this.syncAbs = a2;
      this.totalSyms = SYNC.length + 3 * (2 + needLen + 2);
      this.scanAbs = a2;
      this._decodePacket();
      return;
    }
    this.scanAbs = Math.max(this.scanAbs, limit + 1);
  };

  /* 在 base 附近找让同步头能量最大的子偏移 */
  StreamDecoder.prototype._refine = function (base, symLen) {
    var q = Math.max(1, symLen >> 2);
    var sub = Math.max(1, q >> 2);
    var best = base, bestScore = -1;
    for (var d = -q; d <= q; d += sub) {
      var o = base + d;
      if (o < 0 || o + (SYNC.length + 1) * symLen > this.fill) continue;
      var score = 0;
      for (var i = 0; i < SYNC.length; i++) {
        var m = goertzel(this.buf, o + i * symLen, symLen, toneFreq(this.band, SYNC[i]), this.sr);
        if (m > 0) score += m;
      }
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  };

  StreamDecoder.prototype._decodePacket = function () {
    var symLen = this.symLen;
    var base = this.syncAbs - this.abs0;
    var need = this.totalSyms * symLen;
    if (base < 0 || base + need > this.fill) return;

    var syms = new Uint8Array(this.totalSyms);
    for (var i = 0; i < this.totalSyms; i++) {
      syms[i] = classify(this.buf, base + i * symLen, symLen, this.sr, this.band);
    }
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
    return null;
  }

  /* ---------------- 发送器 ---------------- */
  function Tx(ctx) {
    this.ctx = ctx;
    this.busy = false;
  }

  Tx.prototype.play = function (samples, onDone) {
    var self = this;
    var buf = self.ctx.createBuffer(1, samples.length, self.ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    var src = self.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(self.ctx.destination);
    self.busy = true;
    var done = function () { self.busy = false; if (onDone) onDone(); };
    src.onended = done;
    src.start();
    var ms = samples.length / self.ctx.sampleRate * 1000 + 300;
    setTimeout(done, ms);
    return src;
  };

  Tx.prototype.send = function (packet, band, symMs, onDone) {
    var wave = makeWaveform(packet, this.ctx.sampleRate, band, symMs);
    return this.play(wave, onDone);
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
    packetSymbols: packetSymbols,
    makeWaveform: makeWaveform, makeProbe: makeProbe,
    goertzel: goertzel, classify: classify, bandEnergy: bandEnergy,
    StreamDecoder: StreamDecoder, Tx: Tx, openMic: openMic, makeCtx: makeCtx,
    utf8: utf8, fromUtf8: fromUtf8,
    chunkText: chunkText, joinText: joinText,
    fileHead: fileHead, fileChunk: fileChunk, parsePayload: parsePayload,
    T_PROBE: T_PROBE, T_TEXT: T_TEXT, T_FILE_HEAD: T_FILE_HEAD, T_FILE_CHUNK: T_FILE_CHUNK,
    bytesPerSecond: bytesPerSecond
  };

  root.Ultra = Ultra;
  if (typeof module !== 'undefined' && module.exports) module.exports = Ultra;
})(typeof globalThis !== 'undefined' ? globalThis : this);
