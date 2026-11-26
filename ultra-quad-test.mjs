// ultra-quad-test.mjs —— 4 音 2bit（quad）闭环自测：符号映射、波形、同步、噪声下的包成功率
import Ultra from './ultra-core.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}

const SR = 48000;
const QB = Ultra.bandByKey('quad');

function addNoise(sig, snrDb) {
  let sum = 0;
  for (let i = 0; i < sig.length; i++) sum += sig[i] * sig[i];
  const rms = Math.sqrt(sum / sig.length);
  const nRms = rms / Math.pow(10, snrDb / 20);
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    const u = Math.random() || 1e-9, v = Math.random();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    out[i] = sig[i] + g * nRms;
  }
  return out;
}

function decodeOnce(samples, symMs, chunk = 2048, delayMs = 120) {
  const dec = new Ultra.StreamDecoder(SR, QB, symMs, 'quad');
  const got = [];
  dec.onPacket = p => got.push(Array.from(p));
  const pre = new Float32Array(Math.round(SR * delayMs / 1000));
  const all = new Float32Array(pre.length + samples.length);
  all.set(pre, 0); all.set(samples, pre.length);
  for (let i = 0; i < all.length; i += chunk) dec.push(all.subarray(i, Math.min(all.length, i + chunk)));
  return { got, dec };
}

console.log('== 符号映射 ==');
{
  const u8 = new Uint8Array([0x1b, 0xff, 0x00, 0x5a]);
  const syms = Ultra.bytesToSymbols4(u8);
  ok('1 字节 → 4 个 2bit 符号', syms.length === 16);
  const back = Ultra.symbolsToBytes4(syms);
  ok('往返一致', Array.from(back).join(',') === Array.from(u8).join(','));
  ok('packetSymbols4(16) = 1+8+4×20+1 = 90', Ultra.packetSymbols4(16) === 90, '得到 ' + Ultra.packetSymbols4(16));
}

console.log('== 波形 ==');
{
  const pkt = Ultra.buildPacket(new Uint8Array(16).fill(0x5a));
  const w = Ultra.makeWaveformQuad(pkt, SR, QB, 24);
  const should = Ultra.packetSymbols4(16) - 1;      // 末位收尾符号不计入 decoder 的方向
  ok('波形长度 ≈ 符号数 × 24ms', Math.abs(w.length - (Ultra.packetSymbols4(16) - 1) * 1152) < 2 * 1152,
    '样本 ' + w.length);
  let peak = 0;
  for (let i = 0; i < w.length; i++) peak = Math.max(peak, Math.abs(w[i]));
  ok('峰值 ≈ GAIN（单音吃满幅度）', peak > 0.5 && peak < 0.85, 'peak=' + peak.toFixed(3));
}

console.log('== 解出率 ==');
for (const symMs of [24, 48]) {
  for (const snr of [30, 20, 14]) {
    let okN = 0;
    const trials = 8;
    for (let t = 0; t < trials; t++) {
      const payload = new Uint8Array(16);
      for (let k = 0; k < 16; k++) payload[k] = (t * 41 + k * 17) & 0xff;
      const pkt = Ultra.buildPacket(payload);
      const w = addNoise(Ultra.makeWaveformQuad(pkt, SR, QB, symMs), snr);
      const r = decodeOnce(w, symMs);
      if (r.got.length && r.got[0].join(',') === Array.from(payload).join(',')) okN++;
    }
    ok(`quad ${symMs}ms / SNR ${snr}dB 解出 ${okN}/${trials}`, okN >= trials - 1);
  }
}

console.log('== 反射（4 条早期反射）下的解出率 ==');
for (const symMs of [24, 48]) {
  let okN = 0;
  const trials = 8;
  for (let t = 0; t < trials; t++) {
    const payload = new Uint8Array(16);
    for (let k = 0; k < 16; k++) payload[k] = (t * 29 + k * 53) & 0xff;
    const pkt = Ultra.buildPacket(payload);
    const w = Ultra.makeWaveformQuad(pkt, SR, QB, symMs);
    const taps = [[Math.round(SR * 0.008), 0.7], [Math.round(SR * 0.020), 0.5], [Math.round(SR * 0.045), 0.35], [Math.round(SR * 0.090), 0.2]];
    const y = new Float32Array(w.length + Math.round(SR * 0.1));
    for (let i = 0; i < y.length; i++) {
      let v = i < w.length ? w[i] : 0;
      for (const [d, a] of taps) { const j = i - d; if (j >= 0 && j < w.length) v += w[j] * a; }
      y[i] = v;
    }
    const r = decodeOnce(addNoise(y, 24), symMs);
    if (r.got.length && r.got[0].join(',') === Array.from(payload).join(',')) okN++;
  }
  ok(`quad ${symMs}ms + 反射 解出 ${okN}/${trials}`, okN >= trials - 2);
}

console.log('== 链路闭环：数据 → 回执 → 发端解出 ==');
{
  let okN = 0;
  const trials = 6;
  for (let t = 0; t < trials; t++) {
    const payload = Ultra.chunkText('四音鏈路測試第 ' + t + ' 包，內容長度剛好夠 16 字節左右')[0];
    const pkt = Ultra.buildPacket(payload);
    const ruler = Ultra.makeRuler(SR, QB, 24, 2, 300, 'quad');
    const data = Ultra.makeWaveformQuad(pkt, SR, QB, 24);
    const w = new Float32Array(ruler.length + data.length);
    w.set(ruler, 0); w.set(data, ruler.length);
    /* 房间反射 + 白噪 */
    const taps = [[384, 0.7], [960, 0.5], [2160, 0.35]];
    const y = new Float32Array(w.length + 4800);
    for (let i = 0; i < y.length; i++) {
      let v = i < w.length ? w[i] : 0;
      for (const [d, a] of taps) { const j = i - d; if (j >= 0 && j < w.length) v += w[j] * a; }
      y[i] = v;
    }
    const r = decodeOnce(addNoise(y, 22), 24);
    if (!r.got.length) continue;
    const pl = Ultra.parsePayload(new Uint8Array(r.got[0]));
    if (!pl || pl.type !== 'text') continue;
    /* 收端回执（同 18.1k / quad / 24ms）→ 发端解出 */
    const ack = Ultra.ackPayload(1, 1, function () { return true; }, { hits: r.dec.lastHits, margin: Math.round(r.dec.lastMargin || 0), level: 10, flags: 0 });
    const aw = Ultra.makeWaveformQuad(Ultra.buildPacket(ack), SR, QB, 24);
    const ar = decodeOnce(addNoise(aw, 22), 24);
    if (!ar.got.length) continue;
    const ap = Ultra.parsePayload(new Uint8Array(ar.got[0]));
    const pa = (ap && ap.type === 'ack') ? ap : null;
    if (pa && pa.round === 1 && pa.total === 1) okN++;
  }
  ok(`資料+回執整條鏈路走通 ${okN}/${trials}`, okN >= trials - 1);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
