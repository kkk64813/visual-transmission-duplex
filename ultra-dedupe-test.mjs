// 回归测试：解码器不许把「同一个包」反复解出。
// 真机日志里的症状是同一个包连着 100+ 条 OK、后面几包一个都进不来，
// 根因是解完之后只跳过了同步头、没跳过整包，扫描又锁回同一个位置。
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = { console, navigator: {}, TextEncoder, TextDecoder };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('./ultra-core.js', import.meta.url), 'utf8'), sandbox);
const U = sandbox.window.Ultra;

const SR = 48000;
const TEXT = '重复解出回归：中文短包四包一轮两轮';
const chunkBytes = 16;
const packets = U.chunkText(TEXT, chunkBytes);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + '  ' + detail); }
  else { fail++; console.log('  ✗ ' + name + '  ' + detail); }
}

for (const band of U.BANDS) {
  for (const sp of [16, 24, 32]) {
    // 连续流：两轮，每包之间 150ms 缝
    const gap = Math.round(SR * 0.15);
    const parts = [];
    for (let r = 0; r < 2; r++) {
      for (const p of packets) {
        parts.push(U.makeWaveform(U.buildPacket(p), SR, band, sp));
        parts.push(new Float32Array(gap));
      }
    }
    const all = new Float32Array(parts.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }

    const d = new U.StreamDecoder(SR, band, sp);
    const seen = {};
    let n = 0;
    d.onPacket = (pl) => {
      const x = U.parsePayload(pl);
      if (x && x.type === 'text') { n++; seen[x.seq] = (seen[x.seq] || 0) + 1; }
    };
    for (let i = 0; i < all.length; i += 4096) d.push(all.subarray(i, i + 4096));

    const counts = packets.map((_, i) => seen[i] || 0);
    const dup = counts.some((c) => c > 2);
    const allSeen = counts.every((c) => c >= 1);
    const totalOk = n === packets.length * 2;
    check(band.name + '/' + sp + 'ms 每包最多解出 2 次（2 轮）',
      !dup && allSeen && totalOk,
      '各包=' + counts.join(',') + ' 总=' + n);
  }
}
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
