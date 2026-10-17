/* Static portfolio adapter. All inputs are independently generated synthetic data.
 * No server, model credentials, external calls or arbitrary SQL execution.
 * API-compatible in-browser aggregations preserve the original dashboard UI.
 */
(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  const data = nativeFetch('./demo-data.json').then(r => {
    if (!r.ok) throw new Error('模拟数据加载失败');
    return r.json();
  }).then(d => {
    if (d.summary.data_kind !== 'synthetic') throw new Error('只允许模拟数据');
    d.facts = d.rows.map(row => Object.fromEntries(d.columns.map((key, i) => [key, d.dictionaries?.[key] ? d.dictionaries[key][row[i]] : row[i]])));
    delete d.rows;
    return d;
  });
  const filterMap = {store:'store', projectDepartment:'project_department', bookSeries:'book_series', contentType:'content_type', sourceType:'source_type', sourceDepartment:'source_department', sourceManager:'source_manager', sourceGroup:'source_group', sourceDetail:'source_detail', segment:'segment'};
  const tableFields = {
    series:['book_series','project_department','project_owner','segment','subject'],
    source:['source_type','store','source_department','source_manager','source_group','source_detail','content_type','traffic_channel'],
    product:['merchant_code','product_name','book_series','project_department','project_owner','match_method'],
    influencer:['influencer_id','influencer_name','source_owner','source_type','source_department','source_manager','source_group']
  };
  const day = (date, offset) => new Date(Date.parse(date+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
  const round = value => Math.round((value+Number.EPSILON)*100)/100;
  const sum = (rows, key) => round(rows.reduce((a,r) => a+Number(r[key]||0),0));
  const between = (rows,start,end) => rows.filter(r=>(!start||r.date>=start)&&(!end||r.date<=end));
  function group(rows, fields) {
    const result = new Map();
    for (const r of rows) {
      const key=JSON.stringify(fields.map(f=>r[f]??''));
      let g=result.get(key);
      if (!g) {g=Object.fromEntries(fields.map(f=>[f,r[f]??''])); Object.assign(g,{sales_qty:0,sales_amount:0,order_count:0,highlight_qty:0}); result.set(key,g);}
      for(const metric of ['sales_qty','sales_amount','order_count','highlight_qty']) g[metric]+=Number(r[metric]||0);
    }
    return [...result.values()].map(g=>({...g,sales_amount:round(g.sales_amount)})).sort((a,b)=>b.sales_qty-a.sales_qty);
  }
  function scoped(rows,filters) {
    return rows.filter(r=>Object.entries(filters).every(([key,values])=>!values.length||values.includes(r[key])));
  }
  function paramsFilters(params) {
    const result={};
    for(const [key,column] of Object.entries(filterMap)) {
      const selected=(params.get(key)||params.get(column)||'').split(',').filter(v=>v&&v!=='__all__');
      if(selected.length) result[column]=selected;
    }
    return result;
  }
  function dashboard(d,params) {
    const end=params.get('date_end')||d.summary.date_max;
    const start=params.get('date_start')||day(end,-6);
    const current=between(d.facts,start,end), selected=scoped(current,paramsFilters(params));
    const summary={...d.summary,valid_sales_qty:sum(current,'sales_qty'),valid_sales_amount:sum(current,'sales_amount'),valid_order_count:sum(current,'order_count'),fact_count:current.length,fact_rows:current.length,highlight_sales_qty:sum(current,'highlight_qty'),highlight_companion_sales_qty:sum(current.filter(r=>r.highlight_type==='示例赠品（套装附带）'),'highlight_qty'),highlight_standalone_sales_qty:0,_filtered:true,_fact_grain:'synthetic_static'};
    return {summary,facts:current,comparison_facts:between(d.facts,day(end,-13),end),
      daily_report_trend:group(scoped(between(d.facts,day(end,-6),end),paramsFilters(params)),['date','book_series','segment']).sort((a,b)=>a.date.localeCompare(b.date)),
      quality_checks:d.quality_checks,
      dimensions:{products:[],influencers:[],flows:[],sources:[],
        region:group(selected,['province','city','date','book_series','segment']),
        hour:group(selected,['order_hour','order_weekday','date','book_series','source_type']).map(r=>({...r,hour:r.order_hour,weekday:r.order_weekday})),
        price_band:group(selected,['price_band','book_series','segment']),
        aftersale:group(scoped(current,Object.fromEntries(Object.entries(paramsFilters(params)).filter(([k])=>['book_series','store','segment'].includes(k)))),['aftersale_status','book_series','store','province','date'])}};
  }
  function resolveRange(d,rows,context,message) {
    const dates=rows.map(r=>r.date).sort(), earliest=dates[0], latest=dates.at(-1);
    if(!latest) return [];
    const explicit=message.match(/20\d{2}-\d{2}-\d{2}/g)||[];
    if(explicit.length>=2) {
      if(!explicit.slice(0,2).every(s=>!isNaN(Date.parse(s)))||explicit[0]>explicit[1]) throw new Error('请提供有效的起止日期');
      return explicit.slice(0,2);
    }
    if(/昨日|昨天/.test(message)) return [latest,latest];
    if(/全量|全部日期/.test(message)) return [earliest,latest];
    if(/本周|上周/.test(message)) {
      const weekday=(new Date(latest+'T00:00:00Z').getUTCDay()+6)%7, monday=day(latest,-weekday);
      return message.includes('上周')?[day(monday,-7),day(monday,-1)]:[monday,latest];
    }
    if(!/最近|近[七7三30]|周期/.test(message)&&/^\d{4}-\d{2}-\d{2}$/.test(context.date_start||'')&&/^\d{4}-\d{2}-\d{2}$/.test(context.date_end||'')) return [context.date_start,context.date_end];
    return [day(latest,/30\s*天/.test(message)?-29:-6),latest];
  }
  function agent(d,payload) {
    const message=String(payload.message||'').slice(0,3000),context=payload.context||{},filters={};
    for(const [key,column] of Object.entries(filterMap)) {
      const values=context.filters?.[key];
      if(Array.isArray(values)&&values.length) filters[column]=values.filter(v=>v!=='__all__');
    }
    for(const column of ['book_series','store','source_manager','province','segment','content_type']) {
      let names=[...new Set(d.facts.map(r=>r[column]))].filter(name=>name&&message.includes(name));
      if(names.length) {
        if(filters[column]?.length) {names=names.filter(name=>filters[column].includes(name));if(!names.length) return [{type:'text',text:'提问对象不在当前筛选范围，请先修改筛选；不会自动扩大范围。'}];}
        filters[column]=names;
      }
    }
    const rows=scoped(d.facts,filters), range=resolveRange(d,rows,context,message);
    if(!range.length) return [{type:'text',text:'当前筛选没有模拟数据，请清除部分条件。'}];
    const [start,end]=range, duration=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
    const current=between(rows,start,end), previous=between(rows,day(start,-duration),day(start,-1));
    const metric=/金额|成交额|销售额/.test(message)?'sales_amount':'sales_qty',label=metric==='sales_amount'?'成交额':'销量';
    const dimension=/渠道|直播|短视频|商品卡/.test(message)?'content_type':/地区|省份|地域/.test(message)?'province':message.includes('负责人')?'source_manager':'book_series';
    const curr=new Map(group(current,[dimension]).map(r=>[r[dimension],r])),prev=new Map(group(previous,[dimension]).map(r=>[r[dimension],r]));
    const segments=[...new Set([...curr.keys(),...prev.keys()])].map(name=>({name,current:curr.get(name)?.[metric]||0,previous:prev.get(name)?.[metric]||0})).map(r=>({...r,change:round(r.current-r.previous)}));
    const ranked=/日报|昨日|昨天|排行|排名|前十/.test(message);
    segments.sort(ranked?(a,b)=>b.current-a.current:/下滑|下降|减少/.test(message)?(a,b)=>a.change-b.change:(a,b)=>b.change-a.change);
    const selected=segments.slice(0,ranked?10:({concise:3,executive:5,detailed:8}[payload.output_style]||5));
    const delta=round(sum(current,metric)-sum(previous,metric)), baseline=sum(previous,metric),percent=baseline?`${(delta/baseline*100).toFixed(1)}%`:'前期为零，不计算增长率';
    const n=v=>v.toLocaleString('zh-CN',{maximumFractionDigits:2}),sign=v=>(v>=0?'+':'')+n(v);
    const daily=group(current,['date']).sort((a,b)=>a.date.localeCompare(b.date)), values=daily.map(r=>r[metric]);
    const mean=values.length?values.reduce((a,b)=>a+b,0)/values.length:0,xmean=(values.length-1)/2;
    const denominator=values.reduce((a,_,i)=>a+(i-xmean)**2,0);
    const slope=denominator&&mean?values.reduce((a,v,i)=>a+(i-xmean)*(v-mean),0)/denominator/mean*100:0;
    const direction=values.length<3?'样本不足':slope>1?'上升':slope< -1?'下降':'平稳';
    const text=['> 公开模拟数据 · 浏览器离线规则模式 · 未调用大模型','', '## 核心结论',
      `${start} 至 ${end}，模拟销量 **${n(sum(current,'sales_qty'))}**，模拟成交额 **¥${n(sum(current,'sales_amount'))}**。相比上一等长周期，${label}变化 **${sign(delta)}（${percent}）**。`,
      `范围：${Object.entries(filters).map(([k,v])=>`${k}=${v.join('、')}`).join('；')||'全部模拟对象'}。期间日序列走势：${direction}。`,'', '## 数据证据',
      `| 模拟对象 | 本期${label} | 前期${label} | 净变化 |`,'|---|---:|---:|---:|',...selected.map(r=>`| ${r.name} | ${n(r.current)} | ${n(r.previous)} | ${sign(r.change)} |`)];
    if(ranked&&dimension==='book_series') {
      text.push('','## 学段与商品排行（模拟）','| 学段 | 商品 | 销量 | 成交额 |','|---|---|---:|---:|');
      for(const r of group(current,['segment','book_series']).slice(0,10)) text.push(`| ${r.segment} | ${r.book_series} | ${n(r.sales_qty)} | ¥${n(r.sales_amount)} |`);
    }
    text.push('','## 待验证假设与优先动作','- 维度变化是计算结果，不证明流量、活动、库存或人员变动造成了变化。','- 优先复核变化最大的对象；补充活动、流量、价格和库存证据后，再确定负责人及销售动作。','- 静态模式支持周期对比、排行、渠道、地域与负责人拆解；不执行任意 SQL，不支持开放域问答。','- 日期以模拟数据最新完整日为锚点；“昨日”对应最新完整日。本周、上周按该锚点所在自然周计算。');
    return [{type:'status',message:'浏览器离线规则：识别期间与当前筛选（仅模拟数据）'},
      {type:'tool',tool:'get_summary_stats',message:`本地汇总 ${start} 至 ${end} 的模拟数据`},
      {type:'tool',tool:'compare_segments',message:`按 ${dimension} 对比上一等长周期（包含本期消失对象）`},
      {type:'tool',tool:'analyze_trend',message:'计算日序列趋势；区分数据事实与原因假设'},
      {type:'text',text:text.join('\n')}];
  }
  window.fetch = async function(input, options={}) {
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    const path=url.pathname.slice(new URL('.',location.href).pathname.length);
    if(url.origin!==location.origin||!path.startsWith('api/')) return nativeFetch(input,options);
    if(options.signal?.aborted) throw new DOMException('Aborted','AbortError');
    const d=await data;
    const json=obj=>new Response(JSON.stringify(obj),{headers:{'Content-Type':'application/json'}});
    if(path==='api/me'||path==='api/health') return json({ok:true,username:'demo-viewer',role:'admin',agent_mode:'static',data_kind:'synthetic'});
    if(path==='api/dashboard-data') return json(dashboard(d,url.searchParams));
    if(path==='api/table-data') {
      const fields=tableFields[url.searchParams.get('tab')||'series'];
      const rows=fields?group(scoped(between(d.facts,url.searchParams.get('date_start'),url.searchParams.get('date_end')),paramsFilters(url.searchParams)),fields).slice(0,2000).map(r=>({...r,matched_label:r.match_method||'',top_book_series:'',top_content_type:''})):[];
      return json({ok:true,rows,data_kind:'synthetic'});
    }
    if(path==='api/chat'&&options.method==='POST') {
      const started=performance.now();let events;
      try {events=agent(d,JSON.parse(options.body));}catch(e){events=[{type:'error',message:'分析未完成，请检查日期与筛选后重试。'}];}
      const encoder=new TextEncoder();let index=0,timer;
      const stream=new ReadableStream({
        start(controller) {
          const emit=()=>{
            if(options.signal?.aborted){controller.close();return;}
            if(index<events.length) {controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(events[index++])}\n\n`));timer=setTimeout(emit,80);}
            else {controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({elapsed_ms:Math.round(performance.now()-started),data_kind:'synthetic',agent_mode:'static'})}\n\n`));controller.close();}
          };emit();
        },cancel(){clearTimeout(timer);}
      });
      return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
    }
    return json({ok:false,message:'静态模式不支持此功能'});
  };
})();
