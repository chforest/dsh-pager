import test from 'node:test'
import assert from 'node:assert/strict'
import {createHostFetch,authorizeHostOwner} from '../host-http.mjs'
test('host authentication is private, loopback bound and never replays a rejected write',async()=>{
 const calls=[],ctx={webServer:{port:1234},connection:{authenticatedUrl:u=>u+'?token=fixture'}}
 const fetcher=async(url,options)=>{calls.push({url:String(url),options});return String(url).includes('?token=')?new Response(null,{status:302,headers:{'set-cookie':'fixture-cookie=value; HttpOnly; Path=/'}}):new Response('{}',{status:401})}
 const request=createHostFetch(ctx,{fetcher})
 await assert.rejects(request('https://elsewhere.invalid/api'),/restricted/)
 const result=await request('http://127.0.0.1:1234/api/test',{method:'POST',body:'{}'})
 assert.equal(result.status,401);assert.equal(calls.length,2)
 assert.equal(calls[1].options.headers.get('cookie'),'fixture-cookie=value')
 assert.equal(calls[1].options.redirect,'error')
 assert.ok(!calls[1].url.includes('token'))
})
test('mobile host gate rejects anonymous and non-owner without disabling legacy deployment',()=>{
 assert.equal(authorizeHostOwner({},{}),undefined)
 assert.equal(authorizeHostOwner({connection:{requestRejection:()=>401}},{}),401)
 const ctx={connection:{requestRejection:()=>undefined,admit:()=>({peer:{principal:{kind:'guest'}}})}}
 assert.equal(authorizeHostOwner(ctx,{}),403)
 ctx.connection.admit=()=>({peer:{principal:{kind:'owner'}}})
 assert.equal(authorizeHostOwner(ctx,{}),undefined)
})
