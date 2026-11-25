import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { TextEncoder, TextDecoder, console, setTimeout, Math, Float32Array, Float64Array,
  Uint8Array, ArrayBuffer, DataView, performance, window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('./ultra-core.js', 'utf8'), ctx);
const Ultra = ctx.Ultra || ctx.window.Ultra;

const SR = 48000, SP = 32, BAND = Ultra.bandByKey('mid');
const payload = Ultra.ackPayload(1, 1, () => false);   // 真机自检用的那种极短回执
const pkt = Ultra.buildPacket(payload);
console.log('回执包字节数', pkt.length, '符号数', pkt.length * 3 + 8, '时长(ms)', (pkt.length * 3 + 8) * SP);

// 铺成连续波形：两遍回执 + 200ms 间隔
const gap = Math.round(SR * 0.2);
function silence(n) { const a = new Float32Array(n); return a; }
const w1 = Ultra.makeWaveform(pkt, SR, BAND, SP);
const wave = new Float32Array(w1.length * 2 + gap);
wave.set(w1, 0);
wave.set(w1, w1.length + gap);

const d = new Ultra.StreamDecoder(SR, BAND, SP);
let got = null;
d.onPacket = (p) => { const pl = Ultra.parsePayload(p); if (pl && pl.type === 'ack') got = pl; };
d.onError = (k) => console.log('err', k, 'hits', d.lastHits);
for (let i = 0; i < wave.length; i += 2048) d.push(wave.subarray(i, Math.min(i + 2048, wave.length)));

console.log(got ? `解出回执 round=${got.round} total=${got.total} 缺=${got.missing().length}` : '未解出');
console.log('stat', JSON.stringify(d.stat), 'hits', d.lastHits);
process.exit(got ? 0 : 1);
