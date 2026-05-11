// ZedTV Proxy - Vercel Serverless Function
// Routes stream URLs through server to bypass CORS

const https = require('https');
const http = require('http');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { url } = req.query;
  if (!url) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
  } catch (e) {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  const protocol = targetUrl.startsWith('https') ? https : http;

  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Referer': 'http://nexusconnects.org/',
      'Origin': 'http://nexusconnects.org',
    }
  };

  // Forward Range header if present
  if (req.headers['range']) {
    options.headers['Range'] = req.headers['range'];
  }

  const proxyReq = protocol.get(targetUrl, options, (proxyRes) => {
    // Forward relevant response headers
    const forwardHeaders = [
      'content-type', 'content-length', 'content-range',
      'accept-ranges', 'cache-control', 'last-modified', 'etag'
    ];
    forwardHeaders.forEach(h => {
      if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
    });

    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy error', detail: err.message });
    }
  });

  req.on('close', () => proxyReq.destroy());
};
