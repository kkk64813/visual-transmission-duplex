// 标尺 + 采样率失配：验证 autoCalibrate 能把 -0.4%/+0.4% 拉回来
import { readFileSync } from 'fs';
import vm from 'vm';
const src = readFileSync(new URL('./ultra-core.js', import.meta.url), 'utf8');
const root = {}; vm.createContext(root); vm.runInContext(src, root);
const U = root.Ultra, SR = 48000, band = U.BANDS[0], SYM = 24;

let seed = 1;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function noise(n, amp) { const a = new Float32Array(n); for (let i = 0; i < n; i++) { const u1 = Math.max(1e-9, rnd()), u2 = rnd(); a[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * amp; } return a; }
function resample(x, k) { const n = Math.floor(x.length / (1 + k)); const o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * (1 + k), i0 = Math.floor(p), f = p - i0; o[i] = x[i0] * (1 - f) + (x[i0 + 1] || 0) * f; } return o; }

function run(name, rate, withRuler) {
  const payload = new TextEncoder().encode('UltraLink dual 4bit test');
  const pkt = U.buildPacket(payload);
  const ruler = U.makeRuler(SR, band, SYM, 4, 300, true);
  let wav = new Float32Array(ruler.length + pkt.length * 0);
  const body = U.makeWaveformDual(pkt, SR, band, SYM);
  wav = new Float32Array(ruler.length + Math.round(SR * 0.15) + body.length);
  wav.set(ruler, 0); wav.set(body, ruler.length + Math.round(SR * 0.15));
  if (rate) wav = resample(wav, rate);
  const pad = Math.round(SR * 0.2);
  const sig = new Float32Array(wav.length + pad * 2); sig.set(wav, pad);
  const nz = noise(sig.length, 2e-3); for (let i = 0; i < sig.length; i++) sig[i] += nz[i];

  const dec = new U.StreamDecoder(SR, band, SYM, true);
  let got = null; dec.onPacket = (b) => { got = b; };
  const CH = 8192;
  const pushTo = (end) => { for (let i = 0; i < end; i += CH) dec.push(sig.subarray(i, Math.min(i + CH, end))); };
  const rulerEnd = pad + ruler.length + Math.round(SR * 0.10);
  pushTo(rulerEnd);
  if (withRuler) { const c = dec.autoCalibrate(420); console.log('   cal:', c && c.mode, c && c.ok, c && c.scale.toFixed(4), 'hits', c && c.hits); }
  pushTo(sig.length);
  const ok = got && got.length === payload.length && Buffer.compare(Buffer.from(got), Buffer.from(payload)) === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  scale=${dec.fScale.toFixed(4)} pk=${dec.stat.pk}`);
}

for (const r of [0, 0.004, -0.004, 0.008, -0.008]) {
  run(`rate=${(r * 100).toFixed(1)}% 无标尺`, r, false);
  run(`rate=${(r * 100).toFixed(1)}% 有标尺`, r, true);
}
