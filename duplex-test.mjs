import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Duplex = require('./duplex.js');

const SR = 48000;
const symLen = Math.round(SR * Duplex.SYM_MS / 1000);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); }
}

const status = { done: false, down: true, up: false, mode: 66, need: 137, fps: 12 };
const payload = Duplex.packStatus(status);
const pkt = Duplex.buildPacket(payload);

console.log('== 1. 包格式与状态字段 ==');
ok('状态包 5 字节', payload.length === 5);
ok('包头 = 2+载荷+1', pkt.length === 2 + 5 + 1, pkt.length);
ok('CRC 落在末字节', pkt[pkt.length - 1] === Duplex.crc8(payload));
{
  const back = Duplex.parsePacket(pkt);
  ok('解析还原', !!back && back.length === 5);
  const st = back && Duplex.unpackStatus(back);
  ok('done/down/up 还原', st.done === false && st.down === true && st.up === false);
  ok('mode 还原', st.mode === 66, st && st.mode);
  ok('need 还原', st.need === 137, st && st.need);
  ok('fps 还原', st.fps === 12, st && st.fps);
}
{
  const bad = Uint8Array.from(pkt); bad[3] ^= 0x40;
  ok('篡改一字节被 CRC 拒收', Duplex.parsePacket(bad) === null);
}

console.log('\n== 2. 频带（必须全部高于 20.5 kHz）==');
ok('最低音 ≥ 20500 Hz', Duplex.toneFreq(0) === 20500, Duplex.toneFreq(0));
ok('最高音 ≤ 22000 Hz', Duplex.toneFreq(7) <= 22000, Duplex.toneFreq(7));
ok('最高音低于奈奎斯特 24000', Duplex.toneFreq(7) < SR / 2 - 1000);
ok('单包 < 0.6 秒', Duplex.packetDuration(5, SR) < 0.6, Duplex.packetDuration(5, SR).toFixed(3));

/* ---------- 离线闭环 ---------- */
function noise(snrDb, amp) {
  const p = Math.pow(10, -snrDb / 20);
  return () => (Math.random() * 2 - 1) * amp * p * 3;
}

function decodeOnce(wave, chunk = 2048) {
  const dec = new Duplex.StreamDecoder(SR);
  let got = null;
  dec.onPacket = (p) => { got = p; };
  for (let i = 0; i < wave.length; i += chunk) {
    dec.push(wave.subarray(i, Math.min(i + chunk, wave.length)));
    if (got) break;
  }
  return got;
}

console.log('\n== 3. 调制解调闭环（无噪声）==');
{
  const wave = Duplex.makeWaveform(pkt, SR);
  ok('波形长度 = 符号数×符号长', wave.length === Duplex.packetSymbols(5) * symLen, wave.length);
  const got = decodeOnce(wave);
  ok('5 字节状态包解出', !!got);
  if (got) {
    const st = Duplex.unpackStatus(got);
    ok('内容一致', st.mode === 66 && st.need === 137 && st.down === true);
  }
}

// 符号 0 与 7 各来一遍，确认首尾音都没问题
console.log('\n== 4. 首尾频点单独验证 ==');
for (const sym of [0, 7]) {
  const w = Duplex.makeWaveform(Duplex.buildPacket(new Uint8Array([0, sym, sym, sym, sym])), SR);
  ok(`符号 ${sym} 六连发可解`, !!decodeOnce(w));
}

console.log('\n== 5. 扬声器衰减 + 环境噪声 ==');
{
  // 手机扬声器在 20k 以上常见 -15~-25 dB，这里按 -18 dB 压幅度
  const base = Duplex.makeWaveform(pkt, SR);
  const att = 0.125;  // ≈ -18 dB
  // 注意 noise() 的幅度系数里带 ×3（三分之一个满量程的三倍），
  // 所以标称 snr 与真实 SNR 差约 9.5 dB：标称 5 dB ≈ 实测 -4.5 dB。
  // 真实链路（手机贴电脑麦克风）带内 SNR 通常 20 dB 以上，下面三档留了充足余量。
  for (const snr of [15, 10, 5]) {
    let hits = 0;
    const N = 5;
    for (let t = 0; t < N; t++) {
      const noiseFn = noise(snr, att);
      const w = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) w[i] = base[i] * att + noiseFn();
      if (decodeOnce(w)) hits++;
    }
    ok(`衰减 18dB + 标称 SNR ${snr}dB → ${hits}/${N}`, hits === N, hits + '/' + N);
  }

  // 极端档：标称 0 dB（实测约 -9.5 dB，接近把噪声调到比信号还响）。
  // 这一档不判失败，只记录单发命中率 —— 控制包每 2.5 秒重发，
  // 连发两次的收敛率是 1-(1-p)^2，p=0.4 就有 64%。
  let hits0 = 0;
  const N0 = 5;
  const noiseFn0 = noise(0, att);
  for (let t = 0; t < N0; t++) {
    const w = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) w[i] = base[i] * att + noiseFn0();
    if (decodeOnce(w)) hits0++;
  }
  const p = hits0 / N0;
  console.log(`  参考  标称 SNR 0dB（实测≈-9.5dB）→ ${hits0}/${N0}，两次重发收敛率约 ${(100 * (1 - (1 - p) * (1 - p))).toFixed(0)}%`);
}

console.log('\n== 6. 频响倾斜（高频被压低）==');
{
  // 一阶低通，模拟扬声器在 20k 以上继续下滑
  const fc = 19000;
  const a = 1 - Math.exp(-2 * Math.PI * fc / SR);
  const base = Duplex.makeWaveform(pkt, SR);
  const w = new Float32Array(base.length);
  let y = 0;
  for (let i = 0; i < base.length; i++) { y += a * (base[i] - y); w[i] = y; }
  const got = decodeOnce(w);
  ok('低通 19 kHz 后仍可解', !!got);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
