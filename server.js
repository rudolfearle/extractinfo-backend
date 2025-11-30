// ----------------------- Imports -----------------------
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import puppeteer from 'puppeteer';
import xpath from 'xpath';
import { DOMParser } from 'xmldom';
import * as cheerio from 'cheerio';
import * as parse5 from 'parse5';
import crypto from 'node:crypto';

// ----------------------- App Setup -----------------------


const app = express();
app.use(express.json({ limit: '2mb' }));                // <-- add JSON parser
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use(cors({ origin: true }));
app.use(function (err, req, res, next) {
  if (err && (err.status === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  next(err);
});


// ----------------------- Constants -----------------------
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: 'https://finance.yahoo.com/',
};

const CACHE = new Map();
const cacheKey = (route, url, key) => [route, url, key].filter(Boolean).join('::');
const getCached = (k) => {
  const i = CACHE.get(k);
  if (i && i.exp > Date.now()) return i.payload;
  if (i) CACHE.delete(k);
  return null;
};
const setCached = (k, payload, ttlMs = 60_000) =>
  CACHE.set(k, { payload, exp: Date.now() + ttlMs });

// ----------------------- Helpers -----------------------

function formatErr(err) {
  if (err && err.isAxiosError) {
    var s = err.response && err.response.status;
    var t = err.response && err.response.statusText;
   
    return ('AxiosError ' + (s == null ? '' : String(s)) + ' ' + (t || '')).trim();

  }
  try {
    return (err && err.message) ? err.message : String(err);
  } catch (e) {
    return String(err);
  }
}


async function getWithRetry(url, headers = BROWSER_HEADERS, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.get(url, {
        headers,
        timeout: 30_000,
        decompress: true,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      return resp.data;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 503 || !status) {
        const base = 800 * Math.pow(2, attempt - 1);
        const jitter = base * (0.75 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, jitter));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-features=site-per-process',
  '--disable-gpu',
  '--no-zygote',
];

async function launchBrowser() {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const MAX_LAUNCH_ATTEMPTS = 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
    try {
      const opts = { headless: true, args: LAUNCH_ARGS };
      if (execPath) opts.executablePath = execPath;

      console.info(`Launching puppeteer (attempt ${attempt})`, { execPath });
      const browser = await puppeteer.launch(opts);
      return browser;
    } catch (err) {
      lastErr = err;
      console.error(`puppeteer.launch failed (attempt ${attempt}):`, String(err));
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastErr;
}

async function tryConsent(page) {
  const current = page.url();
  if (/guce\.yahoo\.com|consent\.yahoo\.com/i.test(current)) {
    const candidates = [
      'button[type="submit"]',
      '[data-testid*="accept"]',
      '[data-accept]',
      'button:has-text("Accept")',
      'button:has-text("Agree")',
    ];
    for (const sel of candidates) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }
  }
}

async function applyInterception(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const urlReq = req.url();
    if (['image', 'font', 'media'].includes(type)) return req.abort();
    if (/doubleclick|adtech|scorecardresearch|\/ads?[\W_]/i.test(urlReq)) return req.abort();
    req.continue();
  });
}

// ----------------------- Routes -----------------------
// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Diagnostics
app.get('/__diag', (_req, res) => {
  res.json({
    node: process.version,
    envPuppeteerExec: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    memoryLimit: process.env.MEMORY || null,
  });
});

// Extract CSS
async function handleExtractCss(req, res) {
  try {
    const { url, selector } = req.body;
    const key = cacheKey('css', url, selector);
    const cached = getCached(key);
    if (cached) return res.json(cached);

    const html = await getWithRetry(url);
    const $ = cheerio.load(html);
    const result = $(selector).map((i, el) => $(el).text()).get();
    setCached(key, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: formatErr(err) });
  }
}


// HANDLER (place with your other handler functions)
async function handleExtractXpathHTML(req, res) {
  try {
    // 1) Get the XPath from query or header (raw HTML is in req.body)
    const xp = (req.query && (req.query.xpath || req.query.xp)) || req.header('x-xpath');
	if (!xp) return res.status(400).json({ error: "Provide XPath via query (?xpath=...) or 'x-xpath' header" });


    // 2) Read raw HTML body (string)
    const html = req.body || '';
    if (!html) {
      return res.status(400).json({ error: 'Body must contain raw HTML text.' });
    }

    //2.1 cache
									  
    const key = cacheKey('xpath-html', crypto.createHash('sha256').update(html).digest('hex'), xp);
		
	  
    const cached = getCached(key);
    if (cached) return res.json(cached);

    // 3) Normalize HTML → XHTML, then parse into a DOM document
    const ast = parse5.parse(html);
    const xhtml = parse5.serialize(ast);
    const doc = new DOMParser({errorHandler: { warning(){}, error(){}, fatalError(){} }}).parseFromString(xhtml);

    // 4) Try plain XPath; if it throws, retry using XHTML namespace (x:)
    let nodes;
    try {
      nodes = xpath.select(xp, doc);
    } catch (e) {
      const selectNs = xpath.useNamespaces({ x: 'http://www.w3.org/1999/xhtml' });
      nodes = selectNs(xp, doc);
    }

    // 5) Extract text/attribute values (trimmed)
    const result = nodes.map((n) => {
      // Attribute node
      if (n.nodeType === 2 && n.nodeValue != null) return String(n.nodeValue).trim();
      // Generic node values
      if (n.nodeValue != null) return String(n.nodeValue).trim();
      if (n.textContent != null) return String(n.textContent).trim();
      // Fallback to stringifier
      return String(n.toString ? n.toString() : '').trim();
    });

    
    setCached(key, result, 5 * 60 * 1000);
    return res.json(result);

  } catch (err) {
    return res.status(500).json({ error: formatErr(err) });
  }
}


// Extract XPath
async function handleExtractXpath(req, res) {
  try {
    const { url, xpath: xp } = req.body;
    const key = cacheKey('xpath', url, xp);
    const cached = getCached(key);
    if (cached) return res.json(cached);

    const html = await getWithRetry(url);
    const ast = parse5.parse(html);
    const xhtml = parse5.serialize(ast);
    const doc = new DOMParser({errorHandler: { warning(){}, error(){}, fatalError(){} }}).parseFromString(xhtml);
    const nodes = xpath.select(xp, doc);

    const result = nodes.map((n) => n.toString());
    setCached(key, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: formatErr(err) });
  }
}

// Render & Extract (Puppeteer)
async function handleRenderExtract(req, res) {
  let browser;
  try {
    const { url, selector } = req.body;
    const key = cacheKey('render', url, selector);
    const cached = getCached(key);
    if (cached) return res.json(cached);

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await applyInterception(page);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await tryConsent(page);

    const result = await page.$$eval(selector, (els) => els.map((e) => e.textContent));
    setCached(key, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: formatErr(err) });
  } finally {
    if (browser) await browser.close();
  }
}

// Multi-extract (CSS/XPath/Puppeteer)
async function handleExtractMulti(req, res) {
  const { tasks } = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });

  const results = [];
  for (const t of tasks) {
    try {
      if (t.type === 'css') {
        const html = await getWithRetry(t.url);
        const $ = cheerio.load(html);
        const r = $(t.selector).map((i, el) => $(el).text().trim()).get();
        results.push({ task: t, result: r });
      } else if (t.type === 'xpath') {
        const html = await getWithRetry(t.url);
        const ast = parse5.parse(html);
        const xhtml = parse5.serialize(ast);
        const doc = new DOMParser({errorHandler: { warning(){}, error(){}, fatalError(){} }}).parseFromString(xhtml);
        const nodes = xpath.select(t.xpath, doc);
        results.push({ task: t, result: nodes.map((n) => n.toString()) });
      } else if (t.type === 'render') {
        const browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
        await applyInterception(page);
        await page.goto(t.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await tryConsent(page);
        
       const r = await page.$$eval(t.selector, els => els.map(e => (e.textContent || '').trim()));
        results.push({ task: t, result: r });
        await browser.close();
      } else {
        results.push({ task: t, error: 'Unknown task type' });
      }
    } catch (err) {
      results.push({ task: t, error: formatErr(err) });
    }
  }
  res.json(results);
}

// ----------------------- Routes Binding -----------------------
app.post('/extract-css', handleExtractCss);
app.post('/extract-xpath', handleExtractXpath);
app.post('/render-extract', handleRenderExtract);
app.post('/extract-multi', handleExtractMulti);
app.post('/render-extract-multi', handleExtractMulti); // alias
//app.post('/extract-xpath-html', handleExtractXpath); // alias

app.post(
  '/extract-xpath-html',
  express.text({ type: ['text/html', 'application/xhtml+xml'], limit: '10mb' }),
  handleExtractXpathHTML
);


// ----------------------- Start Server -----------------------
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log('Server listening on port ' + port));

//

