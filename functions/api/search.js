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
  const a = new URL('https://api.pullpush.io/topic');
  a.searchParams.set('q', q);
  a.searchParams.set('size', String(LIMIT));
  if (after) a.searchParams.set('after', String(after));

  const b = new URL('https://arctic-shift.photon-reddit.com/api/posts/search');
  b.searchParams.set('query', q);
  b.searchParams.set('limit', String(LIMIT));
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

  const jobs = [];
  if (context.env?.REDDIT_CLIENT_ID && context.env?.REDDIT_CLIENT_SECRET && context.env?.REDDIT_USER_AGENT) {
    jobs.push(signal => officialSearch(context, q, period, sort, signal));
  }
  for (const endpoint of providers(q, period)) {
    jobs.push(signal => getJSON(endpoint.toString(), null, signal));
  }

  // The browser calls only this same-origin route; upstream failures stay server-side.
  const attempts = await Promise.allSettled(jobs.map(async job => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const source = await job(controller.signal);
      const unique = new Map();
      for (const post of source) {
        const item = cleanPost(post);
        if (item && !unique.has(item.permalink)) unique.set(item.permalink, item);
        if (unique.size >= LIMIT) break;
      }
      return [...unique.values()];
    } finally {
      clearTimeout(timeout);
    }
  }));
  const successes = attempts.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!successes.length) return reply({ error: '검색 제공처에 연결하지 못했습니다.' }, 502);
  const best = successes.find(x => x.length > 0) || [];
  return reply({ data: best });
}
