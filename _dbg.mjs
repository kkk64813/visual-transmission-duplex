import fs from 'node:fs'; import vm from 'node:vm';
const core = fs.readFileSync('./ultra-core.js','utf8');
const sb={console,setTimeout,clearTimeout,performance,TextEncoder,TextDecoder,Float32Array,Float64Array,Uint8Array,Math,Date}; sb.window=sb; sb.globalThis=sb;
vm.createContext(sb); vm.runInContext(core,sb); const U=sb.Ultra; const SR=U.SR; const MID=U.bandByKey('mid');
function run(k,rounds,label){
  const b={key:'mid',name:'18.1k',f0:MID.f0*k,df:MID.df*k};
  const d=new U.StreamDecoder(SR,MID,24); d.fScale=1; d.forceScale=null;
  const r=U.makeRuler(SR,b,24,rounds);
  const pad=new Float32Array(Math.round(SR*0.3));
  const all=new Float32Array(pad.length+r.length+Math.round(SR*0.3));
  all.set(pad,0); all.set(r,pad.length);
  let cal=null;
  for(let i=0;i<all.length;i+=4096){
    d.push(all.subarray(i,Math.min(all.length,i+4096));
    const c=d.autoCalibrate(420);
    if(c&&c.ok) cal=c;
  }
  console.log(label+'  k='+k+' rounds='+rounds+' -> '+(cal?('scale='+cal.scale.toFixed(4)+' hits='+cal.hits+' measured='+cal.measured.toFixed(4)):'未自校'));
}
for(const rounds of [4,5,6]){ run(1.0,rounds,'r'); run(1.013,rounds,'r'); run(0.99,rounds,'r'); }
