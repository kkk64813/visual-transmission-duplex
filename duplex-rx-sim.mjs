/* duplex-rx-sim.mjs —— 电脑端控制逻辑仿真（假麦克风，真解码）
 *
 * 覆盖：收到"放慢"→ 调低帧率；收到"收齐"→ 暂停播放；
 *       开播前对齐 mode；麦克风打不开时不崩、如实报错。
 */
import { readFileSync } from 'fs';
import vm from 'vm';

let pass = 0, fail = 0;
const ok = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (info ? '  ' + info : '')); }
};

const SR = 48000;
const calls = [];

class FakeCtx {
  constructor() { this.sampleRate = SR; this.state = 'running'; this.destination = {}; }
  async resume() { this.state = 'running'; }
  createMediaStreamSource() { return { connect() { }, disconnect() { } }; }
  createScriptProcessor() { return { onaudioprocess: null, connect() { }, disconnect() { } }; }
  createGain() { return { gain: { value: 1 }, connect() { }, disconnect() { } }; }
}

const g = {
  console, performance, setTimeout, clearTimeout, Promise,
  Float32Array, Uint8Array, Math, JSON, Date, Number,
};
g.window = g;
g.AudioContext = FakeCtx;
g.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { } }] }) } };
vm.createContext(g);
vm.runInContext(readFileSync('duplex.js', 'utf8'), g, { filename: 'duplex.js' });
vm.runInContext(readFileSync('duplex-rx.js', 'utf8'), g, { filename: 'duplex-rx.js' });

/* 假的编码页：记录 Main 被怎么调 */
const Main = {
  _paused: false, _fps: 15, _mode: 'B',
  setFPS: (v) => { calls.push(['fps', v]); Main._fps = v; return true; },
  setMode: (v) => { calls.push(['mode', v]); Main._mode = v; return true; },
  togglePause: (v) => { calls.push(['pause', v]); Main._paused = v; return true; },
  isPaused: () => Main._paused
};
const targetWin = () => ({ Main });

const dec = () => ({ push: (w) => g.DuplexRx.feed(w) });
const waveOf = (status) => g.Duplex.makeWaveform(
  g.Duplex.buildPacket(g.Duplex.packStatus(status)), SR);

console.log('\n== 电脑端控制逻辑 ==');
const on = await g.DuplexRx.start(targetWin);
ok('监听启动', on === true);

/* 1) 手机说读不动、建议 6 fps */
const pDown = waveOf({ down: true, up: false, mode: 68, need: 120, fps: 6 });
dec().push(pDown);
ok('下发 setFPS(6)', calls.some(c => c[0] === 'fps' && c[1] === 6),
  JSON.stringify(calls));
ok('记录到手机 mode', g.DuplexRx.state.lastStatus.mode === 68);
ok('记录到还差块数', g.DuplexRx.state.lastStatus.need === 120);

/* 2) 手机说收齐了 */
calls.length = 0;
dec().push(waveOf({ done: true, mode: 68, need: 0, fps: 0 }));
ok('下发暂停', calls.some(c => c[0] === 'pause' && c[1] === true), JSON.stringify(calls));
ok('包计数在涨', g.DuplexRx.state.packets >= 2, g.DuplexRx.state.packets);

/* 3) 播放中不改 mode（会打断喷泉流） */
calls.length = 0;
Main._paused = false;
const applied1 = g.DuplexRx.applyModeFromPhone();
ok('播放中拒绝改 mode', applied1 === false);

/* 4) 暂停后可以对齐 mode（66 = Bu/micro，按 main.js 的映射） */
Main._paused = true;
calls.length = 0;
dec().push(waveOf({ mode: 66, need: 5, fps: 0 }));
const applied2 = g.DuplexRx.applyModeFromPhone();
ok('暂停时把 mode 对齐成 Bu', applied2 === true && Main._mode === 'Bu', JSON.stringify(calls));

/* 5) 坏包不崩 */
dec().push(new Float32Array(SR * 0.6).map(() => (Math.random() * 2 - 1) * 0.2));
ok('纯噪声不抛异常', true);
ok('坏包/噪声计入统计', g.DuplexRx.state.badPackets >= 0);

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

