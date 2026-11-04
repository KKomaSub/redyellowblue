// Temporary public connectivity check with fixed destinations (never includes credentials).
export async function onRequestGet(){
  const checks=[
    ['reddit-atom','https://www.reddit.com/search.rss?q=chatgpt&sort=relevance&t=all'],
    ['bing-rss','https://www.bing.com/search?format=rss&q=site%3Areddit.com%2Fr%2F+chatgpt'],
    ['arctic-scoped','https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=ChatGPT&limit=3&sort=desc'],
    ['pullpush','https://api.pullpush.io/reddit/search/submission/?q=chatgpt&size=3'],
  ];
  const rows=await Promise.all(checks.map(async ([name,url])=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),6000);
    try{
      const response=await fetch(url,{
        headers:{Accept:'application/atom+xml, application/rss+xml, application/json',
          'User-Agent':'Mozilla/5.0 (compatible; FindlySearch/1.0)'},
        redirect:'follow',signal:controller.signal
      });
      const body=(await response.text()).slice(0,200000);
      return {name,status:response.status,contentType:response.headers.get('content-type'),
        length:body.length,entries:(body.match(/<entry(?:\s|>)/gi)||[]).length,
        items:(body.match(/<item(?:\s|>)/gi)||[]).length,
        sample:body.slice(0,180).replace(/\s+/g,' ')};
    }catch(e){return{name,error:String(e?.message||e).slice(0,160)}}
    finally{clearTimeout(timer)}
  }));
  return new Response(JSON.stringify({checks:rows}),{headers:{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'
  }});
}
