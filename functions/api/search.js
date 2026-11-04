// Cloudflare Pages Function: same-origin search API (no browser-to-provider CORS).
const PERIODS = new Set(['all', 'day', 'week', 'month', 'year']);
const SORTS = new Set(['relevance', 'recent', 'popular']);
const MAX_QUERY = 200;
const LIMIT = 70;

function reply(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=45' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function periodStart(period) {
  const days = { day: 1, week: 7, month: 30, year: 365 }[period];
  return days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
}

function providers(q, period) {
  const after = periodStart(period);
  const a = new URL('https://api.pullpush.io/reddit/search/submission/');
  a.searchParams.set('q', q);
  a.searchParams.set('size', '50');
  if (after) a.searchParams.set('after', String(after));

  const b = new URL('https://arctic-shift.photon-reddit.com/api/posts/search');
  b.searchParams.set('query', q);
  b.searchParams.set('limit', '35');
  b.searchParams.set('sort', 'desc');
  if (after) b.searchParams.set('after', new Date(after * 1000).toISOString());
  return [a, b];
}

function listFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.children)) return data.data.children.map(x => x?.data).filter(Boolean);
  throw new Error('Invalid upstream response');
}

function cleanPost(post) {
  if (!post || typeof post !== 'object' || post.over_18 === true || post.over18 === true || post.nsfw === true) return null;
  if (!post.title || typeof post.title !== 'string') return null;
  let path = typeof post.permalink === 'string' ? post.permalink : '';
  if (!path && typeof post.id === 'string' && /^[a-z0-9]+$/i.test(post.id)) {
    path = '/comments/' + post.id + '/';
  }
  if (!path) return null;
  let target;
  try {
    target = new URL(path, 'https://www.reddit.com');
    if (target.protocol !== 'https:' || !/(^|\.)reddit\.com$/i.test(target.hostname)) return null;
  } catch { return null; }
  const date = Number(post.created_utc ?? post.created ?? 0);
  const excerpt = typeof post.selftext === 'string' ? post.selftext : (typeof post.body === 'string' ? post.body : '');
  return {
    title: post.title.slice(0, 500),
    permalink: target.pathname + target.search,
    selftext: excerpt.slice(0, 1200),
    created_utc: Number.isFinite(date) ? date : 0,
    score: Number(post.score) || 0,
    num_comments: Number(post.num_comments) || 0,
  };
}

async function getJSON(url, opts, signal) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(opts?.headers || {}) },
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error('Upstream returned ' + response.status);
  const size = Number(response.headers.get('content-length') || 0);
  if (size > 3_000_000) throw new Error('Upstream response too large');
  const raw = await response.text();
  if (raw.length > 3_000_000) throw new Error('Upstream response too large');
  const payload = JSON.parse(raw);
  if (payload?.error) throw new Error('Upstream error');
  return listFrom(payload);
}


function decodeEntities(input){
  return String(input||'').replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi,(all,k)=>{
    if(k[0]==='#'){
      const n=k[1]?.toLowerCase()==='x'?parseInt(k.slice(2),16):parseInt(k.slice(1),10);
      return n>0 && n<=0x10ffff && !(n>=0xd800 && n<=0xdfff)?String.fromCodePoint(n):' ';
    }
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[k.toLowerCase()]||' ';
  });
}
function asText(html){
  return decodeEntities(String(html||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
}
function xmlTag(xml,name){
  const match=new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i').exec(xml);
  return match?match[1]:'';
}
function postUrl(raw){
  let u;
  try{
    u=new URL(decodeEntities(raw).trim());
    if(u.hostname==='duckduckgo.com'||u.hostname==='www.duckduckgo.com')
      u=new URL(u.searchParams.get('uddg')||'');
  }catch{return ''}
  return u.protocol==='https:'&&/(^|\.)reddit\.com$/i.test(u.hostname)&&/\/comments\/[a-z0-9]+/i.test(u.pathname)?u.pathname+u.search:'';
}
async function fetchText(url,signal,accept){
  const res=await fetch(url,{method:'GET',headers:{Accept:accept,'User-Agent':'Mozilla/5.0 (compatible; FindlySearch/1.0)'},redirect:'follow',signal});
  if(!res.ok)throw new Error('HTTP '+res.status);
  if(Number(res.headers.get('content-length')||0)>2500000)throw new Error('Response too big');
  const body=await res.text();
  if(body.length>2500000)throw new Error('Response too big');
  return body;
}
async function rssSearch(q,period,signal){
  const u=new URL('https://www.bing.com/search');
  let search='site:reddit.com/r/ '+q;
  const after=periodStart(period);
  if(after)search+=' after:'+new Date(after*1000).toISOString().slice(0,10);
  u.searchParams.set('q',search);u.searchParams.set('format','rss');u.searchParams.set('count','50');
  const xml=await fetchText(u.toString(),signal,'application/rss+xml, text/xml');
  if(!/<rss[\s>]/i.test(xml))throw new Error('No RSS feed');
  const rows=[];
  for(const item of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)){
    const x=item[1],link=postUrl(asText(xmlTag(x,'link'))),title=asText(xmlTag(x,'title'));
    if(!link||!title)continue;
    const date=Date.parse(asText(xmlTag(x,'pubDate')));
    rows.push({title,permalink:link,selftext:asText(xmlTag(x,'description')),created_utc:Number.isFinite(date)?Math.floor(date/1000):0});
  }
  return rows;
}
async function htmlSearch(q,period,signal){
  const u=new URL('https://html.duckduckgo.com/html/');
  u.searchParams.set('q','site:reddit.com/r/ '+q);
  const ranges={day:'d',week:'w',month:'m',year:'y'};
  if(ranges[period])u.searchParams.set('df',ranges[period]);
  const html=await fetchText(u.toString(),signal,'text/html');
  if(!/result__a/i.test(html))throw new Error('Search page unavailable');
  const rows=[];
  for(const match of html.matchAll(/<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)){
    const href=/\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1]||'';
    const link=postUrl(href.startsWith('//')?'https:'+href:href);
    const title=asText(match[2]);
    if(link&&title)rows.push({title,permalink:link,selftext:''});
  }
  return rows;
}

async function atomSearch(q,period,sort,signal){
  const u=new URL('https://www.reddit.com/search.rss');
  u.searchParams.set('q',q);
  u.searchParams.set('sort',sort==='recent'?'new':sort==='popular'?'top':'relevance');
  u.searchParams.set('t',period);
  u.searchParams.set('limit','75');
  const xml=await fetchText(u.toString(),signal,'application/atom+xml, application/xml');
  if(!/<feed[\s>]/i.test(xml))throw new Error('No Atom feed');
  const rows=[];
  for(const match of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)){
    const entry=match[1];
    const href=/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(entry)?.[1]||'';
    const permalink=postUrl(href);
    const title=asText(xmlTag(entry,'title'));
    if(!permalink||!title)continue;
    const date=Date.parse(asText(xmlTag(entry,'published')||xmlTag(entry,'updated')));
    rows.push({permalink,title,
      selftext:asText(xmlTag(entry,'content')).slice(0,1200),
      created_utc:Number.isFinite(date)?Math.floor(date/1000):0});
    if(rows.length>=75)break;
  }
  return rows;
}

async function officialSearch(context, q, period, sort, signal) {
  const env = context.env || {};
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET || !env.REDDIT_USER_AGENT) {
    throw new Error('Official API is not configured');
  }
  const tokenResponse = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.REDDIT_CLIENT_ID + ':' + env.REDDIT_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': env.REDDIT_USER_AGENT,
    },
    body: 'grant_type=client_credentials',
    signal,
    redirect: 'error',
  });
  if (!tokenResponse.ok) throw new Error('Official API authentication failed');
  const token = await tokenResponse.json();
  if (!token?.access_token) throw new Error('Official API token missing');
  const url = new URL('https://oauth.reddit.com/search');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(LIMIT));
  url.searchParams.set('type', 'link');
  url.searchParams.set('raw_json', '1');
  url.searchParams.set('sort', { recent: 'new', popular: 'top', relevance: 'relevance' }[sort]);
  url.searchParams.set('t', period);
  return getJSON(url, { headers: { Authorization: 'Bearer ' + token.access_token, 'User-Agent': env.REDDIT_USER_AGENT } }, signal);
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const period = url.searchParams.get('period') || 'all';
  const sort = url.searchParams.get('sort') || 'relevance';
  if (!q || q.length > MAX_QUERY || !PERIODS.has(period) || !SORTS.has(sort)) {
    return reply({ error: '잘못된 검색 요청입니다.' }, 400);
  }

  // Cache successful, nonempty searches at the edge to reduce public RSS rate limits.
  const cache=(typeof caches!=='undefined'&&caches.default)?caches.default:null;
  if(cache){
    try{
      const saved=await cache.match(context.request);
      if(saved)return saved;
    }catch(e){console.warn('Search cache read failed:',String(e?.message||e))}
  }

  const jobs = [];
  if (context.env?.REDDIT_CLIENT_ID && context.env?.REDDIT_CLIENT_SECRET && context.env?.REDDIT_USER_AGENT)
    jobs.push({name:'official',run:signal=>officialSearch(context,q,period,sort,signal)});
  jobs.push({name:'reddit-atom',run:signal=>atomSearch(q,period,sort,signal)});
  jobs.push({name:'duck-search',run:signal=>htmlSearch(q,period,signal)});
  jobs.push({name:'bing-rss',run:signal=>rssSearch(q,period,signal)});

  const controllers=jobs.map(()=>new AbortController());
  const failures=[];
  let validEmpty=false;
  const promises=jobs.map(async(job,i)=>{
    const timer=setTimeout(()=>controllers[i].abort(),9000);
    try{
      const source=await job.run(controllers[i].signal);
      const deduplicated=new Map();
      for(const row of source){
        const item=cleanPost(row);
        if(item&&!deduplicated.has(item.permalink))deduplicated.set(item.permalink,item);
        if(deduplicated.size>=LIMIT)break;
      }
      if(deduplicated.size===0){
        if(job.name==='reddit-atom'||job.name==='official')validEmpty=true;
        throw new Error('No results');
      }
      return [...deduplicated.values()];
    }catch(e){
      failures.push(job.name+':'+String(e?.message||e).slice(0,100));
      throw e;
    }finally{clearTimeout(timer)}
  });
  try{
    const results=await Promise.any(promises);
    controllers.forEach(c=>c.abort());
    const response=reply({data:results});
    response.headers.set('Cache-Control','public, max-age=600');
    if(cache && typeof context.waitUntil==='function'){
      context.waitUntil(cache.put(context.request,response.clone()).catch(e=>
        console.warn('Search cache write failed:',String(e?.message||e))));
    }
    return response;
  }catch{
    console.warn('All Findly search sources failed:',failures.join(' | '));
    return validEmpty?reply({data:[]}):reply({error:'검색 제공처 연결 실패',code:'UPSTREAM_UNAVAILABLE'},502);
  }
}
