const BASE="http://127.0.0.1:8546";
const ALICE="fd412033", BOB="de442902";
import { keccak_256 } from "@noble/hashes/sha3.js";
const USDT="0x55d398326f99059fF775485246999027B3197955";
const W="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const pad=(h:string)=>h.replace(/^0x/,"").toLowerCase().padStart(64,"0");
const slot="0x"+Buffer.from(keccak_256(Buffer.from(pad(W)+pad("1"),"hex"))).toString("hex");
const q=async(env:string,m:string,p:unknown[]=[])=>{
  const r=await fetch(`${BASE}/${env}`,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})}).then(x=>x.json()) as any;
  if(r.error) throw new Error(`${m}: ${r.error.message}`); return r.result;
};
const tok=(h:string)=>h&&h!=="0x"?(BigInt(h)/10n**18n).toString():"0";
const bal=(env:string)=>q(env,"eth_call",[{to:USDT,data:"0x70a08231"+pad(W)},"latest"]).then(tok);

console.log("  shuru me  alice",await bal(ALICE)," bob",await bal(BOB));
await q(ALICE,"anvil_setStorageAt",[USDT,slot,"0x"+pad((10n**24n).toString(16))]);
console.log("  alice patch ke baad  alice",await bal(ALICE)," bob",await bal(BOB),"  ← bob par koi asar nahi");
await q(ALICE,"eth_sendTransaction",[{from:W,to:USDT,data:"0xa9059cbb"+pad("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")+pad((250n*10n**18n).toString(16))}]);
console.log("  alice me tx ke baad  alice",await bal(ALICE)," bob",await bal(BOB));
const info=await q(ALICE,"forkstate_info");
console.log("  alice ka size       ",JSON.stringify(info.size),"blocks",info.blockNumber-Number(BigInt(info.forkBlock)));
