// 双工回执（ARQ）端到端仿真：发端只补「回执位图里缺的那几包」，不足就继续补，直到收齐。
// 不依赖浏览器：只用 ultra-core 的编解码 + 页面里的协议约定（ACK 载荷格式）。
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = { console, navigator: {}, TextEncoder, TextDecoder };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('./ultra-core.js', import.meta.url), 'utf8'), sandbox);
const U = sandbox.window.Ultra;

const SR = 48000;
const BAND = U.bandByKey('mid');
const SP = 24;

// —— 信道：把一段波形推进一个解码器，返回解出的载荷列表 ——
function decode(wave, band = BAND, sp = SP) {
  const d = new U.StreamDecoder(SR, band, sp);
  const out = [];
  d.onPacket = (p) => out.push(U.parsePayload(p));
  for (let i = 0; i < wave.length; i += 4096) d.push(wave.subarray(i, i + 4096));
  return out;
}

const TEXT = '这是一段中文测试，一个字三字节，短包才收得到。ABC';
const chunkBytes = 16;
const packets = U.chunkText(TEXT, chunkBytes);
const total = packets.length;

// 每次都从「干净起点」重新解码，和真机上每包独立发送的情形一致
function trySend(idx) {
  const wave = U.makeWaveform(U.buildPacket(packets[idx]), SR, BAND, SP);
  const got = decode(wave).filter((p) => p && p.type === 'text');
  return got.length ? got[got.length - 1] : null;
}

// —— 收端 ——
const parts = {};
let lastBandKey = 'mid';

// —— 发端：第 1 轮发全部，之后只发回执里缺的 ——
let pending = packets.map((_, i) => i);
const DROP = new Set([1, 4]);          // 第 2、5 包在空气里丢了
let round = 0, log = [];
const MAX_ROUNDS = 6;

while (pending.length && round < MAX_ROUNDS) {
  round++;
  log.push(`第 ${round} 轮发送 ${pending.length} 包`);
  const lost = round === 1 ? DROP : new Set();
  for (const i of pending) {
    if (lost.has(i)) continue;
    const p = trySend(i);
    if (!p) continue;
    parts[p.seq] = p.data;
    lastBandKey = BAND.key;
  }
  if (Object.keys(parts).length === total) break;

  // 收端回执：位图告诉发端哪些已收到
  const ack = U.ackPayload(round, total, (k) => !!parts[k]);
  const ackWave = U.makeWaveform(U.buildPacket(ack), SR, U.bandByKey(lastBandKey), 16);
  const acked = decode(ackWave, U.bandByKey(lastBandKey), 16).filter((p) => p && p.type === 'ack');
  if (!acked.length) { log.push('  回执没解出来 → 全部重发'); continue; }
  const a = acked[acked.length - 1];
  const miss = a.missing();
  log.push(`  回执 #${a.round}：已收 ${a.total - miss.length}/${a.total}，缺 ${miss.map((x) => x + 1).join('、')}`);
  pending = miss;
}

const joined = U.joinText(parts, total);
console.log('内容：', TEXT);
console.log('分片：', total, '包（每包', chunkBytes, 'B）');
log.forEach((l) => console.log(' ', l));
console.log('重组成：', joined);

const ok = joined === TEXT && round === 2;
console.log(ok
  ? `✓ ARQ 生效：第 1 轮丢 2 包，第 2 轮只补这 2 包，${round} 轮收齐`
  : `✗ 失败：轮数=${round}，一致=${joined === TEXT}`);
console.log(ok ? '结果：1 通过 / 0 失败' : '结果：0 通过 / 1 失败');
process.exit(ok ? 0 : 1);
