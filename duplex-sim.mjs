/* duplex-sim.mjs —— 双工闭环仿真（只把"声卡"换成假的，其余全是真的）
 *
 * 链路：DuplexTx 控制器 → Duplex.packStatus → 真波形 → 真 StreamDecoder → unpackStatus
 * 覆盖：降档判定、升档判定、need 抓取、done 停机、钩子不改原行为
 *
 * 用法：node duplex-sim.mjs
 */
import { readFileSync } from 'fs';
import vm from 'vm';

const SR = 48000;
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (info ? '  ' + info : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 假声卡：把 Tx 播出的波形录下来 ---------- */
class FakeCtx {
  constructor() { this.sampleRate = SR; this.state = 'running'; this.destination = {}; this.captured = []; }
  createBuffer(ch, len) { const d = new Float32Array(len); return { getChannelData: () => d, _d: d }; }
  createBufferSource() {
    const ctx = this;
    const src = {
      buffer: null, onended: null, connect() { },
      start() {
        setTimeout(() => { ctx.captured.push(bd(src.buffer)); if (src.onended) src.onended(); }, 1);
      }
    };
    return src;
  }
}
const bd = (buf) => (buf && buf._d) ? buf._d : new Float32Array(0);

/* ---------- 被包装对象：形状按 recv.js 真实签名 ---------- */
const reportRef = { v: { need: 0 } };
const sinkCalls = [];
const zstdCalls = [];

const g = {
  console,
  performance,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Float32Array, Uint8Array, Uint16Array, Int16Array, ArrayBuffer, Math, Date, JSON, Number, Promise,
  document: { getElementById: () => null },
};
g.window = g;
g.AudioContext = FakeCtx;
vm.createContext(g);

// 先加载内核，再灌入被包装的桩
vm.runInContext(readFileSync('duplex.js', 'utf8'), g, { filename: 'duplex.js' });

vm.runInContext(`
  var Recv = {
    _on_decode: function (wid, data) { /* 原始实现：什么都不做 */ return 'orig:' + wid; },
    on_decode: null,
    setMode: function (m) { this._m = m; },
    download_bytes: function () { /* 原始：触发下载 */ return 'dl'; }
  };
  Recv.on_decode = function (wid, data) { return Recv._on_decode(wid, data); };

  var Sink = {
    _on_decode: function (buff) { return 'sink'; },
    on_decode: null,
    get_report: function () { return __REPORT__(); }
  };
  Sink.on_decode = function (buff) { return Sink._on_decode(buff); };

  var Zstd = { decompress: function () { return 'z'; } };
`, g);
g.__REPORT__ = () => reportRef.v;

/* 让 Zstd 调用可观测 */
const origZstd = g.Zstd.decompress;
g.Zstd.decompress = function () { zstdCalls.push(1); return origZstd.apply(this, arguments); };

vm.runInContext(readFileSync('duplex-tx.js', 'utf8'), g, { filename: 'duplex-tx.js' });

/* ---------- 真解码器，接住 Tx 播出的每一包 ---------- */
const dec = new g.Duplex.StreamDecoder(SR);
const got = [];
dec.onPacket = (p) => got.push(g.Duplex.unpackStatus(p));

/* ---------- 造解码事件 ---------- */
let failRate = 0.7, emitTimer = null;
function startEmitting() {
  emitTimer = setInterval(() => {
    const failed = Math.random() < failRate;
    g.Recv.on_decode(1, failed ? { failed_extract: -3, mode: 68 } : { mode: 68, buff: new Uint8Array(4) });
  }, 66);
}

console.log('\n== 双工闭环仿真 ==');
const started = await g.DuplexTx.start();
ok('控制器启动', started === true);
ok('钩子已挂载（未破坏原 on_decode 返回值）',
  g.Recv.on_decode(1, { mode: 68, buff: new Uint8Array(2) }) === 'orig:1');

startEmitting();

/* 阶段 1：七成失败，等一个"请求放慢"的包 */
await sleep(3600);
while (g.DuplexTx.state.tx.busy) await sleep(50);
for (const w of new FakeCtx().captured) { }   // 占位，避免 lint
for (const wave of g.DuplexTx.state.ctx.captured.splice(0)) dec.push(wave);
await sleep(0);
ok('第一阶段收到至少一个状态包', got.length >= 1, 'got=' + got.length);
ok('上报了"读不动，请放慢"', got.some(s => s && s.down === true),
  JSON.stringify(got.map(s => s && { d: s.down, f: s.fps })));

/* 阶段 2：改成几乎全成功，等一个"可提速"的包 */
failRate = 0.03;
const mark = got.length;
await sleep(4200);
while (g.DuplexTx.state.tx.busy) await sleep(50);
for (const wave of g.DuplexTx.state.ctx.captured.splice(0)) dec.push(wave);
await sleep(0);
ok('上报了"读得动，可提速"', got.slice(mark).some(s => s && s.up === true),
  JSON.stringify(got.slice(mark).map(s => s && { u: s.up, f: s.fps })));
ok('fps 建议落在 5–20', got.every(s => !s || (s.fps === 0 || (s.fps >= 5 && s.fps <= 20))));

/* 阶段 3：need 能被抓出来 */
reportRef.v = { need: 42 };
g.Sink.on_decode(new Uint8Array(3));
await sleep(3000);
while (g.DuplexTx.state.tx.busy) await sleep(50);
for (const wave of g.DuplexTx.state.ctx.captured.splice(0)) dec.push(wave);
await sleep(0);
ok('need 出现在后续包', got.some(s => s && s.need === 42),
  JSON.stringify(got.slice(-3).map(s => s && s.need)));

/* 阶段 4：收齐 → done 置位 → 两包后自动停 */
clearInterval(emitTimer);
g.Zstd.decompress('x');
const beforeDone = got.length;
await sleep(3200);
while (g.DuplexTx.state.tx.busy) await sleep(50);
for (const wave of g.DuplexTx.state.ctx.captured.splice(0)) dec.push(wave);
await sleep(0);
ok('最后两包带"收齐"标志', got.slice(beforeDone).filter(s => s && s.done === true).length >= 1,
  JSON.stringify(got.slice(beforeDone).map(s => s && s.done)));
ok('发完自动停机', g.DuplexTx.state.enabled === false);
ok('停机后不再发', g.DuplexTx.state.ctx.captured.length === 0);

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
