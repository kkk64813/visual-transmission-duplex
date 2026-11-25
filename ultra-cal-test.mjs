/* 自动校准的合成回环测试（不点按钮、不盲扫）：
 * 1) 无偏移：初始 scale 故意给 1.0，必须解出包
 * 2) 偏移 +1.3%：初始 scale 给错的 1.0，autoCalibrate 必须把它拉回来并解出
 * 3) 偏移 −1.0% / +2.0%：同样要能自校并解出
 * 4) 每次发送前自动播的标尺音（5 轮）：只听标尺也要自校成功
 * 5) 纯噪声：不得改 fScale
 */
import fs from 'node:fs';
import vm from 'node:vm';

const core = fs.readFileSync(new URL('./ultra-core.js', import.meta.url), 'utf8');
const sandbox = { console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder, Float32Array, Float64Array, Uint8Array, Math, Date };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(core, sandbox);
const U = sandbox.Ultra;
const SR = U.SR;
const MID = U.bandByKey('mid');

const payload = new Uint8Array([1, 0, 1, 0x41, 0x42, 0x43]);
const pkt = U.buildPacket(payload);
const shifted = (k) => ({ key: 'mid', name: '18.1k', f0: MID.f0 * k, df: MID.df * k });

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

function feed(d, samples, onBlock) {
  const block = 4096;
  for (let i = 0; i < samples.length; i += block) {
    d.push(samples.subarray(i, Math.min(samples.length, i + block)));
    if (onBlock) onBlock(d);
  }
}

/* 模拟真机：0.5 秒静音 → 标尺音（可选）→ 数据包 → 1 秒尾巴 */
function runOnce(k, opts) {
  opts = opts || {};
  const d = new U.StreamDecoder(SR, MID, 24);
  d.fScale = opts.fScale == null ? 1 : opts.fScale;
  d.forceScale = null;
  let got = null, cal = null, calOnRuler = null;
  d.onPacket = (p) => { if (!got) got = p; };
  const b = shifted(k);
  const lead = new Float32Array(Math.round(SR * 0.5));
  const ruler = opts.ruler ? U.makeRuler(SR, b, 24, opts.ruler) : new Float32Array(0);
  const wave = U.makeWaveform(pkt, SR, b, 24);
  const all = new Float32Array(lead.length + ruler.length + wave.length + SR);
  all.set(lead, 0);
  all.set(ruler, lead.length);
  all.set(wave, lead.length + ruler.length);
  const rulerEnd = lead.length + ruler.length;
  feed(d, all, (dd) => {
    if (dd.fill > SR * 0.4) {
      const c = dd.autoCalibrate(420);
      if (c) {
        if (c.ok) cal = c;
        if (dd.abs0 + dd.fill <= rulerEnd + 4096 && c.ok) calOnRuler = c;
      }
    }
  });
  return { got, cal, calOnRuler, d };
}

/* 只听标尺（不带数据包）的自校 */
function rulerOnly(k) {
  const d = new U.StreamDecoder(SR, MID, 24);
  d.fScale = 1; d.forceScale = null;
  const b = shifted(k);
  const pad = new Float32Array(Math.round(SR * 0.3));
  const ruler = U.makeRuler(SR, b, 24, 5);
  const all = new Float32Array(pad.length + ruler.length + Math.round(SR * 0.4));
  all.set(pad, 0); all.set(ruler, pad.length);
  let cal = null;
  feed(d, all, (dd) => {
    const c = dd.autoCalibrate(420);
    if (c && c.ok) cal = c;
  });
  return cal;
}

console.log('[1] 无偏移（fScale 初始 1.0）');
{
  const r = runOnce(1.0);
  t('解出包', !!r.got, r.got ? 'type=' + r.got[0] : '未解出');
}

console.log('[2] 偏移 +1.3%（初始 fScale 仍是错的 1.0）');
{
  const r = runOnce(1.013);
  t('自校后解出包', !!r.got, r.cal ? 'scale=' + r.cal.scale.toFixed(4) + ' hits=' + r.cal.hits : '未自校');
  t('校准结果贴近 1.013（±0.004）', r.cal && Math.abs(r.cal.scale - 1.013) <= 0.004, r.cal ? r.cal.scale.toFixed(4) : 'null');
}

console.log('[3] 偏移 −1.0% 与 +2.0%');
{
  const a = runOnce(0.99);
  t('−1.0% 自校后解出', !!a.got, a.cal ? 'scale=' + a.cal.scale.toFixed(4) : '未自校');
  const b = runOnce(1.02);
  t('+2.0% 自校后解出', !!b.got, b.cal ? 'scale=' + b.cal.scale.toFixed(4) : '未自校');
}

console.log('[4] 只听标尺音（每次发送前自动播 5 轮，约 0.96 秒）');
{
  const a = rulerOnly(1.0);
  t('标尺自校成功', !!a, a ? 'scale=' + a.scale.toFixed(4) + ' hits=' + a.hits : '未自校');
  t('结果贴近 1.000（±0.006）', a && Math.abs(a.scale - 1) <= 0.006, a ? a.scale.toFixed(4) : 'null');
  const b = rulerOnly(1.013);
  t('标尺（+1.3%）自校成功', !!b, b ? 'scale=' + b.scale.toFixed(4) + ' hits=' + b.hits : '未自校');
  t('结果贴近 1.013（±0.006）', b && Math.abs(b.scale - 1.013) <= 0.006, b ? b.scale.toFixed(4) : 'null');
}

console.log('[5] 纯噪声不得乱改');
{
  const d = new U.StreamDecoder(SR, MID, 24);
  d.fScale = 1; d.forceScale = null;
  const noise = new Float32Array(SR);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.02;
  d.push(noise);
  const cal = d.autoCalibrate(420);
  t('噪声 ok=false', !cal || cal.ok === false, cal ? 'hits=' + cal.hits : 'null');
  t('fScale 保持 1', Math.abs(d.fScale - 1) < 1e-6, 'fScale=' + d.fScale);
}

console.log('\n结果：' + pass + '/' + (pass + fail) + (fail ? '（有失败）' : ' 全部通过'));
process.exit(fail ? 1 : 0);
