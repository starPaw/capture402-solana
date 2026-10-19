// Operator calls require an explicit approved private provider; there is no public fallback.
export function requiredRpcEndpoint():string {
  const value=process.env.SOLANA_RPC_URL;
  if(!value || /\s/.test(value))throw Error('configured HTTPS Helius or QuickNode RPC endpoint required');
  const url=new URL(value),host=url.hostname;
  if(url.protocol!=='https:' || url.username || url.password || url.hash || !(host.endsWith('.helius-rpc.com') || host.endsWith('.helius.xyz') || host.endsWith('.quiknode.pro')))throw Error('configured HTTPS Helius or QuickNode RPC endpoint required');
  return value;
}
