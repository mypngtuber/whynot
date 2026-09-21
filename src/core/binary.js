'use strict';
// SHA-256, no Node/native dependency in the UXP runtime. Inputs are byte arrays.
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rot=(n,b)=>(n>>>b)|(n<<(32-b));
function sha256(bytes) {
  const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const blocks=Math.ceil((bytes.length+9)/64), w=new Uint32Array(64);
  for(let block=0;block<blocks;block++) {
    w.fill(0);
    for(let j=0;j<64;j++) {
      const p=block*64+j;
      let b=p<bytes.length?bytes[p]:p===bytes.length?128:0;
      const tail=blocks*64-p;
      if(tail<=8) b=tail>4?Math.floor(bytes.length*8/2**((tail-1)*8))&255:(bytes.length*8/2**((tail-1)*8))&255;
      w[j>>>2]|=b<<(24-(j%4)*8);
    }
    for(let i=16;i<64;i++) {
      const a=w[i-15],b=w[i-2];
      w[i]=(w[i-16]+(rot(a,7)^rot(a,18)^(a>>>3))+w[i-7]+(rot(b,17)^rot(b,19)^(b>>>10)))>>>0;
    }
    let [a,b,c,d,e,f,g,z]=h;
    for(let i=0;i<64;i++) {
      const t1=(z+(rot(e,6)^rot(e,11)^rot(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;
      const t2=((rot(a,2)^rot(a,13)^rot(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,z].forEach((x,i)=>h[i]=(h[i]+x)>>>0);
  }
  return h.map(x=>x.toString(16).padStart(8,'0')).join('');
}
const hashJSON=value=>sha256(new TextEncoder().encode(JSON.stringify(value)));
function base64(bytes) {
  const abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out=[];
  for(let i=0;i<bytes.length;i+=3) {
    const n=(bytes[i]<<16)|((bytes[i+1]||0)<<8)|(bytes[i+2]||0);
    out.push(abc[(n>>>18)&63]+abc[(n>>>12)&63]+(i+1<bytes.length?abc[(n>>>6)&63]:'=')+(i+2<bytes.length?abc[n&63]:'='));
  }
  return out.join('');
}
function parseWav(buffer) {
  const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const tag=i=>String.fromCharCode(...bytes.subarray(i,i+4));
  if(bytes.length<44 || tag(0)!=='RIFF' || tag(8)!=='WAVE') throw new Error('اختر WAV PCM 16-bit mono 16000 Hz، وليس MP3 أو فيديو.');
  if(v.getUint32(4,true)+8!==bytes.length) throw new Error('ملف WAV غير مكتمل أو تالف.');
  let format=null,data=null;
  for(let p=12;p+8<=bytes.length;) {
    const size=v.getUint32(p+4,true),end=p+8+size;
    if(end>bytes.length) throw new Error('WAV غير مكتمل.');
    if(tag(p)==='fmt ' && size>=16) format={code:v.getUint16(p+8,true),channels:v.getUint16(p+10,true),rate:v.getUint32(p+12,true),align:v.getUint16(p+20,true),bits:v.getUint16(p+22,true)};
    if(tag(p)==='data') { if(data) throw new Error('WAV متعدد كتل الصوت غير مدعوم.'); data=bytes.subarray(p+8,end); }
    p=end+(size%2);
  }
  if(!format || !data || !data.length || format.code!==1 || format.channels!==1 || format.rate!==16000 || format.bits!==16 || format.align!==2 || data.length%2)
    throw new Error('يلزم WAV: PCM غير مضغوط، mono، 16000 Hz، 16-bit. أنشئ Audio-only preset في Premiere.');
  return {data,rate:format.rate,duration:data.length/(format.rate*2)};
}
function wavChunk(wav,start,end) {
  const from=Math.floor(start*wav.rate)*2,to=Math.min(wav.data.length,Math.floor(end*wav.rate)*2);
  if(from<0 || to<=from) throw new Error('نطاق WAV غير صالح.');
  const out=new Uint8Array(44+to-from),v=new DataView(out.buffer);
  const put=(p,s)=>{for(let i=0;i<s.length;i++)out[p+i]=s.charCodeAt(i);};
  put(0,'RIFF');v.setUint32(4,out.length-8,true);put(8,'WAVE');put(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,wav.rate,true);v.setUint32(28,wav.rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);put(36,'data');v.setUint32(40,to-from,true);out.set(wav.data.subarray(from,to),44);
  return out;
}
module.exports={sha256,hashJSON,base64,parseWav,wavChunk};
