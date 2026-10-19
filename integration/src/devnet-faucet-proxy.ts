// Public restaurant routes proxy only the fixed private faucet API. The bearer
// never enters browser config, URLs or response headers; no redirects are followed.
export type FaucetProxy = { request(path:string,method:'GET'|'POST',body?:unknown):Promise<Response> };
export type FaucetPeerIdentity={profileHash:string;mint:string;network:string;treasury:string;pool:string;amountAtomic:string};
export function devnetFaucetProxy(url:string,bearerToken:string,expected?:FaucetPeerIdentity):FaucetProxy {
  const base=new URL(url);
  if(base.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname!=='/')throw Error('faucet gateway must stay on trusted loopback');
  const send=(path:string,method:'GET'|'POST',body?:string)=>fetch(new URL(`/faucet${path}`,base),{
    method,headers:{Authorization:`Bearer ${bearerToken}`,...(body?{'Content-Type':'application/json'}:{})},
    body,redirect:'error',signal:AbortSignal.timeout(30_000)});
  const verifyPeer=async(response:Response)=>{
    const identity=await response.clone().json() as Record<string,unknown>;
    if(!response.ok || Object.entries(expected!).some(([key,value])=>identity[key]!==value))throw Error('faucet peer differs from approved Circle profile');
  };
  return {async request(path,method,body) {
    if(!['/health','/status','/challenge','/claim'].includes(path) && !/^\/status\?recipient=[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(path) && !/^\/claims\/[a-f0-9]{64}$/.test(path))throw Error('unapproved faucet route');
    if((['/challenge','/claim'].includes(path))!==(method==='POST') || method==='GET' && body!==undefined)throw Error('unapproved faucet method');
    const encoded=body===undefined?undefined:JSON.stringify(body);
    if(encoded!==undefined && Buffer.byteLength(encoded)>4096)throw Error('faucet request too large');
    if(expected && ['/challenge','/claim','/status'].some(route=>path===route||path.startsWith(route+'?')))await verifyPeer(await send('/health','GET'));
    const response=await send(path,method,encoded);
    if(expected && path==='/health')await verifyPeer(response);
    return response;
  }};
}
