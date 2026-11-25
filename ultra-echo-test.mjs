/* 回声/多径场景自测：真机上「同步 7/8、边距 30 dB，载荷却整段错」的最可能原因
 * 是房间反射让每个符号开头混着上一个音的尾巴。这里给信号叠几路延迟回声再解，
 * 验证「只判符号尾部」的判决窗能不能扛住。 */
import fs from 'fs';
import vm from 'vm';

const core = fs.readFileSync('ultra-core.js', 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(core + '\n;globalThis.__Ultra = (window.Ultra || globalThis.Ultra);', sandbox);
const Ultra = sandbox.__Ultra || sandbox.window.Ultra;
if (!Ultra) throw new Error('内核没挂到 Ultra');

const SR = 48000;

function addEcho(x, taps) {
  // taps: [{delayMs, gain}]，模拟桌面反射、墙面反射
  const out = new Float32Array(x.length + Math.round(SR * 0.06));
  out.set(x);
  for (const t of taps) {
    const d = Math.round(SR * t.delayMs / 1000);
    for (let i = 0; i < x.length; i++) out[i + d] += x[i] * t.gain;
  }
  return out;
}

function addNoise(x, snrDb) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p += x[i] * x[i];
  p /= x.length;
  const np = p / Math.pow(10, snrDb / 10);
  const sd = Math.sqrt(np);
  const out = new Float32Array(x.length);
  let s = 12345;
  for (let i = 0; i < x.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = (s / 0x7fffffff) * 2 - 1;
    out[i] = x[i] + n * sd;
  }
  return out;
}

function decode(sig, band, symMs) {
  const d = new Ultra.StreamDecoder(SR, band, symMs);
  let got = 0;
  d.onPacket = () => got++;
  const step = 1024;
  for (let i = 0; i < sig.length; i += step) d.push(sig.subarray(i, i + step));
  return got;
}

const cases = [
  { name: '无回声 15 dB', taps: [], snr: 15 },
  { name: '单反射 8ms/-6dB 15 dB', taps: [{ delayMs: 8, gain: 0.5 }], snr: 15 },
  { name: '双层反射 8ms/20ms 15 dB', taps: [{ delayMs: 8, gain: 0.5 }, { delayMs: 20, gain: 0.3 }], snr: 15 },
  { name: '强反射 12ms/-1.5dB 15 dB', taps: [{ delayMs: 12, gain: 0.85 }], snr: 15 }
];

let pass = 0, fail = 0;
for (const band of Ultra.BANDS) {
  for (const sp of [16, 24, 32]) {
    for (const c of cases) {
      const pkt = Ultra.buildPacket(new Uint8Array([1, 0, 1, 84, 101, 115, 116])); // 文字 "Test"
      const raw = Ultra.makeWaveform(pkt, SR, band, sp);
      let sig = c.taps.length ? addEcho(raw, c.taps) : raw;
      sig = addNoise(sig, c.snr);
      const got = decode(sig, band, sp);
      const ok = got >= 1;
      ok ? pass++ : fail++;
      console.log(`  ${ok ? '✓' : '✗'} ${band.name}/${sp}ms ${c.name}  包数=${got}`);
    }
  }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
