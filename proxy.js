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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { url } = req.query;
  if (!url) { res.status(400).json({ error: 'Missing url parameter' }); return; }

  let targetUrl;
  try { targetUrl = decodeURIComponent(url); }
  catch (e) { res.status(400).json({ error: 'Invalid URL' }); return; }

  const isLogoUrl = req.query.type === 'logo';
  const mac   = extractMac(targetUrl);
  const token = extractToken(targetUrl);

  const protocol = targetUrl.startsWith('https') ? https : http;

  // Parse host for Referer
  let host = 'nexusconnects.org';
  try { host = new URL(targetUrl).host; } catch(e) {}

  const headers = isLogoUrl ? {
    // Logo fetch: minimal headers
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
  } : {
    // Stalker Portal stream: full auth headers
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `http://${host}/`,
    'Origin':  `http://${host}`,
    'Cookie':  buildStalkerCookie(mac, token),
    'X-Forwarded-For': '127.0.0.1',
    'Connection': 'keep-alive',
  };

  if (req.headers['range']) headers['Range'] = req.headers['range'];

  const options = { headers, timeout: 15000 };

  const doRequest = (url, opts, attempt) => {
    const proto = url.startsWith('https') ? https : http;
    const proxyReq = proto.get(url, opts, (proxyRes) => {
      // Handle redirects
      if ([301,302,303,307,308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        if (attempt < 3) {
          let loc = proxyRes.headers.location;
          if (loc.startsWith('/')) loc = `http://${host}${loc}`;
          return doRequest(loc, opts, attempt + 1);
        }
      }

      const forward = ['content-type','content-length','content-range','accept-ranges','cache-control','last-modified','etag'];
      forward.forEach(h => { if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]); });

      // For logos, set cache header
      if (isLogoUrl) res.setHeader('Cache-Control', 'public, max-age=86400');

      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Proxy error', detail: err.message });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Timeout' });
    });

    req.on('close', () => proxyReq.destroy());
  };

  doRequest(targetUrl, options, 0);
};
