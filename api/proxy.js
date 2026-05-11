// ZedTV Proxy - Vercel Serverless Function
// Handles Stalker Portal MAC-auth streams + logo proxying

const https = require('https');
const http  = require('http');

// Extract MAC from stream URL
function extractMac(url) {
  const m = url.match(/mac=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '00:1A:79:16:DB:23';
}

// Extract play_token from stream URL
function extractToken(url) {
  const m = url.match(/play_token=([^&]+)/);
  return m ? m[1] : '';
}

// Build Stalker Portal cookie string
function buildStalkerCookie(mac, token) {
  return [
    `mac=${mac}`,
    `stb_lang=en`,
    `timezone=Europe/London`,
    token ? `play_token=${token}` : '',
  ].filter(Boolean).join('; ');
}

module.exports = async (req, res) => {
  // CORS — must be set before any early return
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Accept-Encoding');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const { url } = req.query;
  if (!url) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing url'})); return; }

  let targetUrl;
  try { targetUrl = decodeURIComponent(url); }
  catch (e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Invalid URL'})); return; }

  const isLogoUrl = req.query.type === 'logo';
  const mac   = extractMac(targetUrl);
  const token = extractToken(targetUrl);

  // Parse host for Referer
  let host = 'nexusconnects.org';
  try { host = new URL(targetUrl).host; } catch(e) {}

  const headers = isLogoUrl ? {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
  } : {
    // Stalker Portal stream: full auth headers — mimic VLC/IPTV player
    'User-Agent': 'stagefright/1.2 (Linux;Android 5.0)',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `http://${host}/`,
    'Origin':  `http://${host}`,
    'Cookie':  buildStalkerCookie(mac, token),
    'Connection': 'keep-alive',
  };

  if (req.headers['range']) headers['Range'] = req.headers['range'];

  const options = { headers, timeout: 20000 };

  const doRequest = (reqUrl, opts, attempt) => {
    const proto = reqUrl.startsWith('https') ? https : http;
    const proxyReq = proto.get(reqUrl, opts, (proxyRes) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        if (attempt < 5) {
          let loc = proxyRes.headers.location;
          if (loc.startsWith('/')) loc = `http://${host}${loc}`;
          proxyRes.resume(); // drain
          return doRequest(loc, opts, attempt + 1);
        }
      }

      const isTsStream = !isLogoUrl && (
        /extension=ts/i.test(targetUrl) ||
        /\.ts(\?|$)/i.test(targetUrl) ||
        (proxyRes.headers['content-type'] || '').includes('octet-stream') ||
        (proxyRes.headers['content-type'] || '').includes('mp2t')
      );

      const outHeaders = {};
      // Forward safe headers
      ['content-length','content-range','accept-ranges','cache-control','last-modified','etag']
        .forEach(h => { if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h]; });

      if (isTsStream) {
        outHeaders['Content-Type'] = 'video/mp2t';
        // Live TS streams usually have no content-length — use chunked
        if (!outHeaders['content-length']) outHeaders['Transfer-Encoding'] = 'chunked';
      } else {
        if (proxyRes.headers['content-type']) outHeaders['Content-Type'] = proxyRes.headers['content-type'];
      }

      if (isLogoUrl) outHeaders['Cache-Control'] = 'public, max-age=86400';

      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Proxy error', detail: err.message}));
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Timeout'}));
      }
    });

    req.on('close', () => proxyReq.destroy());
  };

  doRequest(targetUrl, options, 0);
};
