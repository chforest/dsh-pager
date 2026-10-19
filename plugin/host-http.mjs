// Host-only loopback transport. Never expose the launch token or cookie to clients.

/**
 * The origin this process serves from. `dsh web --host 10.181.64.56` binds one
 * concrete interface, so 127.0.0.1 is not listening at all and every internal
 * call to it fails with ECONNREFUSED — which the mobile UI could only report as
 * "家里电脑暂时连不上". Follow the configured bind address instead.
 */
export function hostOrigin(ctx){
 const host=typeof ctx?.webServer?.host==='string'&&ctx.webServer.host?ctx.webServer.host:'127.0.0.1'
 const authority=host.includes(':')&&!host.startsWith('[')?`[${host}]`:host
 return `http://${authority}:${ctx.webServer.port}`
}
export function authorizeHostOwner(ctx,req){
 const connection=ctx.connection
 if(typeof connection?.requestRejection!=='function')return undefined
 const rejection=connection.requestRejection(req);if(rejection)return rejection
 const admitted=connection.admit(req)
 return admitted.rejection || (admitted.peer?.principal?.kind==='owner'?undefined:403)
}
export function createHostFetch(ctx,{fetcher=fetch}={}){
 let cookiePromise
 const origin=()=>hostOrigin(ctx)
 async function cookie(){
  if(typeof ctx.connection?.authenticatedUrl!=='function')return ''
  if(!cookiePromise)cookiePromise=(async()=>{
   const url=new URL(ctx.connection.authenticatedUrl(origin()+'/'))
   if(url.origin!==origin())throw Error('Unexpected host authentication authority')
   const response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(10000)})
   if(![200,301,302,303,307,308].includes(response.status))throw Error('Host authentication failed')
   const values=response.headers.getSetCookie?.()||[]
   const value=values.map(v=>v.split(';')[0]).filter(Boolean).join('; ')
   await response.body?.cancel()
   if(!value)throw Error('Host authentication did not issue a cookie')
   return value
  })().catch(error=>{cookiePromise=undefined;throw error})
  return cookiePromise
 }
 return async(input,options={})=>{
  const url=new URL(String(input))
  if(url.origin!==origin()||url.username||url.password)throw Error('Host fetch is restricted to its own loopback listener')
  const headers=new Headers(options.headers),value=await cookie()
  if(value)headers.set('cookie',value)
  const result=await fetcher(url,{...options,headers,redirect:'error'})
  // Invalidate for the NEXT call only. Never replay a possibly accepted write.
  if(result.status===401)cookiePromise=undefined
  return result
 }
}
