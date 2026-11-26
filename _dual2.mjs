// 双音真机化仿真：把内核放进「频响凹陷 + 噪声 + 采样率失配 + 房间回声」里跑
import { readFileSync } from 'fs';
import vm from 'vm';

const src = readFileSync(new URL('./ultra-core.js', import.meta.url), 'utf8');
const root = {};
vm.createContext(root);
vm.runInContext(src, root);
const U = root.Ultra;
const SR = 48000;
const band = U.BANDS[0];   // 18.1k
const SYM = 24;

let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function noise(n, amp) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-9, rnd()), u2 = rnd();
    a[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * amp;
  }
  return a;
}

// RBJ 峰值均衡器：模拟喇叭/麦克风在某个音上的凹陷
function peakEQ(x, sr, f0, dB, Q) {
  const A = Math.pow(10, dB / 40), w0 = 2 * Math.PI * f0 / sr;
  const alpha = Math.sin(w0) / (2 * Q), cw = Math.cos(w0);
  const b0 = 1 + alpha * A, b1 = -2 * cw, b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A, a1 = -2 * cw, a2 = 1 - alpha / A;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
  }
  return y;
}

function reverb(x, sr, delaysMs, gains) {
  const out = new Float32Array(x.length);
  out.set(x);
  for (let d = 0; d < delaysMs.length; d++) {
    const off = Math.round(sr * delaysMs[d] / 1000);
    const g = gains[d];
    for (let i = off; i < out.length; i++) out[i] += out[i - off] * g;
  }
  return out;
}

function resample(x, k) {          // 采样率失配 k（相对）
  const n = Math.floor(x.length / (1 + k));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * (1 + k), i0 = Math.floor(p), f = p - i0;
    out[i] = x[i0] * (1 - f) + (x[i0 + 1] || 0) * f;
  }
  return out;
}

function trial(name, opt = {}) {
  const payload = new TextEncoder().encode('UltraLink dual 4bit test');
  const pkt = U.buildPacket(payload);
  let wav = U.makeWaveformDual(pkt, SR, band, SYM);
  for (const [f, dB] of (opt.eq || [])) wav = peakEQ(wav, SR, f, dB, 1.6);
  if (opt.reverb) wav = reverb(wav, SR, opt.reverb, opt.revGain || []);
  if (opt.rate) wav = resample(wav, opt.rate);

  const pad = Math.round(SR * (opt.pad || 0.25));
  const sig = new Float32Array(wav.length + pad * 2);
  sig.set(wav, pad);
  const floor = opt.floor === undefined ? 2e-4 : opt.floor;
  if (floor) { const nz = noise(sig.length, floor); for (let i = 0; i < sig.length; i++) sig[i] += nz[i]; }

  const dec = new U.StreamDecoder(SR, band, SYM, true);
  let got = null;
  dec.onPacket = (b) => { got = b; };
  const CH = 8192;
  for (let i = 0; i < sig.length; i += CH) dec.push(sig.subarray(i, Math.min(i + CH, sig.length)));
  const ok = got && got.length === payload.length && Buffer.compare(Buffer.from(got), Buffer.from(payload)) === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  sync=${dec.stat.sync} crc=${dec.stat.crc} pk=${dec.stat.pk} hits=${dec.lastHits}`);
  return ok;
}

const cases = [
  ['纯信号', {}],
  ['底噪 -20dB', { floor: 2e-3 }],
  ['底噪 -14dB', { floor: 4e-3 }],
  ['列音(19.2k)凹陷 12dB', { eq: [[19200, -12]] }],
  ['行音(18.4k)凹陷 12dB', { eq: [[18400, -12]] }],
  ['喇叭整体 18.5k 以上掉 18dB', { eq: [[19000, -18]] }],
  ['凹陷 12dB + 底噪 -20dB', { eq: [[19200, -12]], floor: 2e-3 }],
  ['回声 3 路', { reverb: [18, 41, 70], revGain: [0.5, 0.3, 0.15] }],
  ['采样率 +0.4%', { rate: 0.004 }],
  ['采样率 -0.4% + 底噪', { rate: -0.004, floor: 2e-3 }],
  ['总合', { eq: [[19300, -14]], floor: 3e-3, reverb: [20, 45], revGain: [0.35, 0.18], rate: 0.003 }]
];
let pass = 0;
for (const [n, o] of cases) if (trial(n, o)) pass++;
console.log(`\n${pass}/${cases.length}`);
