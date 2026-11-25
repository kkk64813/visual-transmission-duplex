/* 双音（4+4，4 bit/符号）合成回环测试 */
import fs from 'node:fs';
import vm from 'node:vm';

const core = fs.readFileSync(new URL('./ultra-core.js', import.meta.url), 'utf8');
const sandbox = { console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder, Float32Array, Float64Array, Uint8Array, Math, Date };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(core, sandbox);
const U = sandbox.Ultra;
const MID = U.bandByKey('mid');
U.setMode('dual');

const payload = new Uint8Array([1, 0, 1, 0x41, 0x42, 0x43, 0x44, 0x45]);
const pkt = U.buildPacket(payload);
const shifted = (k) => ({ key: 'mid', name: '18.1k', f0: MID.f0 * k, df: MID.df * k });

let pass = 0, fail = 0;
const t = (n, ok, x) => { if (ok) { pass++; console.log('  ok   ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  FAIL ' + n + (x ? '  ' + x : '')); } };

function run(o) {
  const sr = o.sr || 48000, k = o.k || 1;
  const b = shifted(k);
  const d = new U.StreamDecoder(sr, b, 24, true);
  d.forceScale = null;
  const lead = new Float32Array(Math.round(sr * 0.4));
  const ruler = o.ruler ? U.makeRuler(sr, b, 24, 4) : new Float32Array(0);
  const wave = U.makeWaveform(pkt, sr, b, 24, true);
  const tail = new Float32Array(Math.round(sr * 0.5));
  const total = lead.length + ruler.length + wave.length + tail.length;
  const all = new Float32Array(total);
  all.set(lead, 0); all.set(ruler, lead.length);
  const off = lead.length + ruler.length;
  all.set(wave, off);
  const g = o.gain == null ? 1 : o.gain;
  for (let i = 0; i < all.length; i++) all[i] *= g;
  let got = null, cal = null, maxHits = 0;
  d.onPacket = (p) => { if (!got) got = p; };
  d.onDiag = (e) => { if (e.hits) maxHits = Math.max(maxHits, e.hits); };
  const block = 8192;
  for (let i = 0; i < total; i += block) {
    d.push(all.subarray(i, Math.min(total, i + block)));
    if (o.autocal && d.fill > sr * 0.42) { const c = d.autoCalibrate(420); if (c && c.ok) cal = c; }
  }
  return { got, cal, d, maxHits, locks: d.stat };
}

console.log('[1] 双音 无偏移');
{
  const r = run({});
  t('解出包', !!r.got, r.got ? 'len=' + r.got.length : '未解出');
  t('载荷内容正确', r.got && r.got[3] === 0x41 && r.got[7] === 0x45);
}
console.log('[2] 双音 偏移 +1.2% + 标尺 + 低增益');
{
  const r = run({ k: 1.012, ruler: true, gain: 0.3 });
  t('标尺+低增益下解出', !!r.got, 'fScale=' + r.d.fScale.toFixed(4));
}
console.log('[3] 双音 偏移 −1.5% 且 fScale 初值被写歪成 1.03');
{
  const r = run({ k: 0.985, gain: 0.4, autocal: true });
  t('自校后解出', !!r.got, r.cal ? 'locate hits=' + r.cal.hits : '无校准');
}
console.log('[4] 双音 44100 Hz');
{
  const r = run({ sr: 44100, gain: 0.5 });
  t('44100 解出', !!r.got, r.got ? 'ok' : 'fScale=' + r.d.fScale.toFixed(4));
}
console.log('[5] 双音 无标尺、只有数据包');
{
  const r = run({ k: 1.008, gain: 0.4, autocal: true });
  t('无标尺也解出', !!r.got);
}
console.log('[6] ACK 位图包（双音）');
{
  const d = new U.StreamDecoder(48000, MID, 24, true);
  const ack = U.buildPacket(U.ackPayload(1, 8, (i) => i !== 2 && i !== 5));
  const w = U.makeWaveform(ack, 48000, MID, 24, true);
  let gotAck = null;
  d.onPacket = (p) => { if (!gotAck && U.parseAck(p)) gotAck = U.parseAck(p); };
  for (let i = 0; i < w.length; i += 8192) d.push(w.subarray(i, Math.min(w.length, i + 8192)));
  t('回执解出', !!gotAck, gotAck ? '缺失=' + gotAck.missing().join(',') : '未解出');
  t('回执位图正确', gotAck && gotAck.missing().join(',') === '2,5');
}
console.log('[7] 单音模式仍在（切换回 single 能解 3bit 包）');
{
  U.setMode('single');
  const d = new U.StreamDecoder(48000, MID, 24, false);
  const w = U.makeWaveform(pkt, 48000, MID, 24, false);
  let got = null;
  d.onPacket = (p) => { if (!got) got = p; };
  for (let i = 0; i < w.length; i += 8192) d.push(w.subarray(i, Math.min(w.length, i + 8192)));
  t('单音模式解出', !!got);
  U.setMode('dual');
}
console.log('[8] 速率：16 字节花的符号数');
{
  t('双音 16B 符号数 = 1+8+2*20+1 = 50', U.packetSymbols(16) === 50, 'n=' + U.packetSymbols(16));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
