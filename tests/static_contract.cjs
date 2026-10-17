// Execute the static adapter without a browser; never contacts a network service.
const fs=require('node:fs'),vm=require('node:vm');
const source=JSON.parse(fs.readFileSync('site/demo-data.json','utf8'));
const context={window:{fetch:async()=>new Response(JSON.stringify(source))},location:{href:'https://example.test/portfolio/',origin:'https://example.test'},URL,URLSearchParams,Response,ReadableStream,TextEncoder,DOMException,setTimeout,clearTimeout,performance,console};
vm.createContext(context);vm.runInContext(fs.readFileSync('web/static-runtime.js','utf8'),context);
(async()=>{
  const inputs=JSON.parse(fs.readFileSync(0,'utf8')),results=[];
  for(const input of inputs){const response=await context.window.fetch(input.url,input.options||{});results.push(input.text?await response.text():await response.json());}
  process.stdout.write(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exit(1)});
