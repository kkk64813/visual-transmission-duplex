// ultra-test.mjs —— 超声信道 2.0 自测（node ultra-test.mjs）
// 覆盖：包格式/CRC16、文字分块与重组、三档频带 × 两档符号长度在噪声下的解出率、探测音能量
import Ultra from './ultra-core.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}

const SR = 48000;

/* 复数噪声：给定 SNR(dB)，以信号 RMS 为基准 */
function addNoise(sig, snrDb) {
  let sum = 0;
  for (let i = 0; i < sig.length; i++) sum += sig[i] * sig[i];
  const rms = Math.sqrt(sum / sig.length);
  const nRms = rms / Math.pow(10, snrDb / 20);
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    // Box-Muller
    const u = Math.random() || 1e-9, v = Math.random();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    out[i] = sig[i] + g * nRms;
  }
  return out;
}

function decodeOnce(samples, band, symMs, chunk = 2048, delayMs = 120) {
  const dec = new Ultra.StreamDecoder(SR, band, symMs);
  const got = [];
  dec.onPacket = p => got.push(Array.from(p));
  // 前置一段静音模拟“麦克风刚开”
  const pre = new Float32Array(Math.round(SR * delayMs / 1000));
  const all = new Float32Array(pre.length + samples.length);
  all.set(pre, 0); all.set(samples, pre.length);
  for (let i = 0; i < all.length; i += chunk) dec.push(all.subarray(i, Math.min(all.length, i + chunk)));
  return { got, dec };
}

console.log('== 包格式 ==');
{
  const payload = Ultra.chunkText('hello 超声')[0];
  const pkt = Ultra.buildPacket(payload);
  const back = Ultra.parsePacket(pkt);
  ok('组包/拆包闭环', back && Array.from(back).join() === Array.from(payload).join());
  const bad = Uint8Array.from(pkt); bad[3] ^= 0xff;
  ok('CRC16 能识别翻位', Ultra.parsePacket(bad) === null);
  ok('空载荷被拒', Ultra.parsePacket(new Uint8Array([0, 0, 0, 0])) === null);
}

console.log('== 文字分块 ==');
{
  const text = '空气隙传输测试 ABC 123 今天天气不错';
  const parts = Ultra.chunkText(text, 20);
  ok('块数 = ceil(len/20)', parts.length === Math.ceil(Ultra.utf8(text).length / 20), `parts=${parts.length}`);
  const map = {};
  parts.forEach(p => { map[p[1]] = p.subarray(3); });
  ok('重组回原文', Ultra.joinText(map, parts.length) === text);
  ok('缺块时返回 null', Ultra.joinText({ 0: parts[0].subarray(3) }, 3) === null);
}

console.log('== 三档频带 × 两档符号，15 dB SNR ==');
for (const b of Ultra.BANDS) {
  for (const sp of [16, 24]) {
    const ptxt = Ultra.chunkText('链路测试 okay', 40)[0];
    const wave = Ultra.makeWaveform(Ultra.buildPacket(ptxt), SR, b, sp);
    const noisy = addNoise(wave, 15);
    const { got } = decodeOnce(noisy, b, sp);
    ok(`${b.name}/${sp}ms 15dB 解出`, got.length === 1 && Array.from(got[0]).join() === Array.from(ptxt).join(),
      `包数=${got.length}`);
  }
}

console.log('== 5 dB SNR（贴近真实弱信号）==');
for (const b of [Ultra.BANDS[0], Ultra.BANDS[1]]) {
  const ptxt = Ultra.chunkText('弱信号', 40)[0];
  const wave = Ultra.makeWaveform(Ultra.buildPacket(ptxt), SR, b, 24);
  const noisy = addNoise(wave, 5);
  const { got } = decodeOnce(noisy, b, 24);
  ok(`${b.name}/24ms 5dB 解出`, got.length >= 1 && Array.from(got[0]).join() === Array.from(ptxt).join(),
    `包数=${got.length}`);
}

console.log('== 跨频带串扰（mid 波形用 hi 解）==');
{
  const payload = Ultra.buildPacket(Ultra.chunkText('串扰', 8)[0]);
  const wave = Ultra.makeWaveform(payload, SR, Ultra.BANDS[0], 16);
  const { got } = decodeOnce(wave, Ultra.BANDS[1], 16);
  ok('错频解码不出包（说明频带选择是真的在起作用）', got.length === 0, `包数=${got.length}`);
}

console.log('== 探测音能量 ==');
{
  const probe = Ultra.makeProbe(SR, Ultra.BANDS[1], 800);
  const e = Ultra.bandEnergy(probe, SR, Ultra.BANDS[1]);
  const eNo = Ultra.bandEnergy(new Float32Array(SR * 0.08).map(() => (Math.random() - 0.5) * 0.002), SR, Ultra.BANDS[1]);
  ok('探测音峰显著高于噪声', e.peak > eNo.peak * 10, `sig=${e.peak.toFixed(1)} noise=${eNo.peak.toFixed(1)}`);
}

console.log('== 时长/速率换算 ==');
{
  const bytes = 30;
  const payloadLen = bytes + 3;
  const syms = Ultra.packetSymbols(payloadLen);
  const sec = syms * 24 / 1000;
  ok('30 字节一包在 24ms 下 2–4 秒', sec > 2 && sec < 4, `${syms} 符号 ≈ ${sec.toFixed(1)}s`);
  const sec16 = syms * 16 / 1000;
  ok('同包 16ms 下 1.5–2.5 秒', sec16 > 1.5 && sec16 < 2.5, `≈ ${sec16.toFixed(1)}s`);
}

console.log('== 采样率错配 → 频率整体走形（这是“人耳能听见”的机制）==');
{
  const payload = Ultra.buildPacket(Ultra.chunkText('rate', 8)[0]);
  const wave = Ultra.makeWaveform(payload, SR, Ultra.BANDS[0], 16);
  const pk = Ultra.peakFreq(wave, SR, 16000, 22000, 60);
  ok('48k 生成时峰值就是 18.1–19.5k', pk.f >= 18000 && pk.f <= 19600, `peak=${pk.f} Hz`);

  // 把 48k 生成的波形按 44.1k 播出去 ≈ 频率乘 44.1/48
  const heard = 18100 * 44100 / 48000;
  ok('44.1k 播放会把它压到人耳可闻区', heard < 18000, `18100 → ${heard.toFixed(0)} Hz`);

  // 用 48k 波形喂 44.1k 解码器：频率对不上，应当一个包都解不出
  const dec = new Ultra.StreamDecoder(44100, Ultra.BANDS[0], 16);
  const got = [];
  dec.onPacket = p => got.push(p);
  for (let i = 0; i < wave.length; i += 2048) dec.push(wave.subarray(i, Math.min(wave.length, i + 2048)));
  ok('采样率不匹配时必然解不出（说明这个数必须两端一致）', got.length === 0, `包数=${got.length}`);
}

console.log('== 两端晶振漂移（500 ppm）==');
{
  // 发送端按 48000 采样，接收端采样时钟快 500 ppm → 收到的信号在时间轴上被压缩
  const payload = Ultra.buildPacket(Ultra.chunkText('漂移测试 drift 500ppm', 8)[0]);
  const wave = Ultra.makeWaveform(payload, SR, Ultra.BANDS[0], 16);
  const k = 1.0005;
  const n = Math.floor(wave.length / k);
  const drift = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * k, i0 = Math.floor(s), f = s - i0;
    drift[i] = wave[i0] * (1 - f) + (wave[i0 + 1] || 0) * f;
  }
  const dec = new Ultra.StreamDecoder(SR, Ultra.BANDS[0], 16);
  const got = [];
  dec.onPacket = p => got.push(p);
  for (let i = 0; i < drift.length; i += 2048) dec.push(drift.subarray(i, Math.min(drift.length, i + 2048)));
  ok('500 ppm 漂移下仍能解出（逐符号跟随生效）', got.length >= 1, `包数=${got.length} 漂移=${dec.lastDrift.toFixed(1)} 采样`);
  ok('边距是正数（判决有把握）', dec.lastMargin > 0, `${dec.lastMargin.toFixed(1)} dB`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
