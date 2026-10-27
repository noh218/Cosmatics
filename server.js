const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env, PORT = E.PORT || 3000, DATA = E.DATA_DIR || path.join(__dirname, 'data');
const PASS = E.ADMIN_PASSWORD || '', PIXEL = E.PIXEL_ID || '', TOKEN = E.CAPI_TOKEN || '', TEST = E.TEST_EVENT_CODE || '';
const CUR = E.CURRENCY || 'USD', CC = E.COUNTRY_CODE || '218', CTRY = E.COUNTRY || 'ly', EVT = E.ORDER_EVENT || 'Purchase';
const WA = (E.WHATSAPP || '').replace(/\D/g, ''), GV = E.GRAPH_VERSION || 'v21.0';
if (!PASS) { console.error('ضع ADMIN_PASSWORD في المتغيرات'); process.exit(1); }
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });

const rd = (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8')); } catch { return d; } };
const wr = (n, v) => fs.writeFileSync(path.join(DATA, n), JSON.stringify(v, null, 1));
const hash = s => s ? crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex') : undefined;
const sign = t => crypto.createHmac('sha256', PASS).update(t).digest('hex');
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));
const rid = () => crypto.randomBytes(4).toString('hex');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '8mb' }));

// ---------- الدخول ----------
const tries = {};
function isAdmin(req) {
  const [ts, sig] = (cookies(req).adm || '').split('.');
  return !!ts && !!sig && sig === sign(ts) && Date.now() - +ts < 30 * 864e5;
}
const auth = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'غير مصرح' });
app.post('/api/login', (req, res) => {
  const k = req.ip, now = Date.now(), t = (tries[k] = (tries[k] || []).filter(x => now - x < 60000));
  if (t.length >= 5) return res.status(429).json({ error: 'محاولات كثيرة، انتظر دقيقة' });
  t.push(now);
  if (req.body.password !== PASS) return res.status(401).json({ error: 'كلمة السر خاطئة' });
  const ts = String(now);
  res.setHeader('Set-Cookie', `adm=${ts}.${sign(ts)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ admin: isAdmin(req) }));

// ---------- Meta Conversions API ----------
// كل منتج يمكن أن يملك Pixel وToken خاصين به، وإلا يُستخدم الإعداد العام
async function capi(req, p, name, eventId, custom, user = {}) {
  const px = p.pixel || PIXEL, tk = p.token || (p.pixel ? '' : TOKEN), test = p.test || (p.pixel ? '' : TEST);
  if (!px || !tk) return;
  const c = cookies(req);
  const body = { data: [{
    event_name: name, event_time: Math.floor(Date.now() / 1000), event_id: eventId,
    event_source_url: req.body.url, action_source: 'website',
    user_data: { client_ip_address: (req.ip || '').replace('::ffff:', ''), client_user_agent: req.headers['user-agent'], fbp: c._fbp, fbc: c._fbc, ...user },
    custom_data: custom
  }] };
  if (test) body.test_event_code = test;
  try {
    const r = await fetch(`https://graph.facebook.com/${GV}/${px}/events?access_token=${encodeURIComponent(tk)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('CAPI error', await r.text());
  } catch (e) { console.error('CAPI error', e.message); }
}

// ---------- API ----------
app.get('/api/config', (req, res) => res.json({ pixel: PIXEL, currency: CUR, wa: WA, orderEvent: EVT }));
// الـ Token سري: يظهر للمالك فقط ولا يخرج للزوار
app.get('/api/products', (req, res) => {
  const adm = isAdmin(req);
  res.json(rd('products.json', []).map(p => { if (adm) return p; const { token, test, ...pub } = p; return pub; }));
});

app.post('/api/products', auth, (req, res) => {
  const b = req.body, list = rd('products.json', []);
  const id = /^[a-f0-9]{8}$/.test(b.id || '') ? b.id : rid();
  let img = b.img || '';
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(img);
  if (m) {
    const f = `${id}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(DATA, 'uploads', f), Buffer.from(m[2], 'base64'));
    img = '/uploads/' + f;
  } else if (!/^\/uploads\/[\w.-]+$/.test(img)) img = '';
  const p = { id, title: String(b.title || '').slice(0, 200), price: Math.max(0, +b.price || 0), desc: String(b.desc || '').slice(0, 5000),
    details: (Array.isArray(b.details) ? b.details : []).map(s => String(s).slice(0, 300)).slice(0, 30), img,
    pixel: String(b.pixel || '').replace(/\D/g, '').slice(0, 20), token: String(b.token || '').trim().slice(0, 400), test: String(b.test || '').trim().slice(0, 40) };
  const i = list.findIndex(x => x.id === id);
  i < 0 ? list.push(p) : (list[i] = p);
  wr('products.json', list);
  res.json(p);
});
app.delete('/api/products/:id', auth, (req, res) => {
  wr('products.json', rd('products.json', []).filter(x => x.id !== req.params.id));
  res.json({ ok: true });
});
app.get('/api/orders', auth, (req, res) => res.json(rd('orders.json', [])));

// أحداث التصفح (ViewContent / InitiateCheckout) من الخادم
app.post('/api/track', (req, res) => {
  const { event, eventId, pid } = req.body;
  const p = rd('products.json', []).find(x => x.id === pid);
  if (!['ViewContent', 'InitiateCheckout'].includes(event) || !p) return res.sendStatus(400);
  capi(req, p, event, String(eventId), { content_ids: [p.id], content_type: 'product', content_name: p.title, value: p.price, currency: CUR });
  res.sendStatus(204);
});

// الطلب: يُحفظ ثم يُرسل لفيسبوك مع بيانات العميل مشفّرة
app.post('/api/order', (req, res) => {
  const b = req.body, p = rd('products.json', []).find(x => x.id === b.pid);
  const name = String(b.name || '').trim().slice(0, 100), phone = String(b.phone || '').replace(/\D/g, '');
  if (!p || !name || phone.length < 7) return res.status(400).json({ error: 'الاسم ورقم الهاتف مطلوبان' });
  const qty = Math.min(99, Math.max(1, parseInt(b.qty) || 1)), city = String(b.city || '').trim().slice(0, 100);
  const o = { id: rid(), at: new Date().toISOString(), pid: p.id, product: p.title, qty, total: p.price * qty, name, phone, city };
  const list = rd('orders.json', []); list.unshift(o); wr('orders.json', list);

  const local = phone.replace(/^0+/, ''), intl = local.startsWith(CC) ? local : CC + local;
  const [fn, ...ln] = name.split(/\s+/);
  capi(req, p, EVT, String(b.eventId || o.id), {
    content_ids: [p.id], content_type: 'product', contents: [{ id: p.id, quantity: qty, item_price: p.price }],
    num_items: qty, value: o.total, currency: CUR, order_id: o.id
  }, {
    ph: [hash(intl)], fn: [hash(fn)], ln: ln.length ? [hash(ln.join(' '))] : undefined,
    ct: city ? [hash(city.replace(/\s/g, ''))] : undefined, country: [hash(CTRY)], external_id: [hash(intl)]
  });
  res.json({ ok: true, id: o.id });
});

// ---------- الملفات والصفحات ----------
app.use('/uploads', express.static(path.join(DATA, 'uploads'), { maxAge: '7d' }));
const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const ea = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
app.get('*', (req, res) => {
  const m = /^\/p\/([a-f0-9]{8})$/.exec(req.path), p = m && rd('products.json', []).find(x => x.id === m[1]);
  const og = p ? `<title>${ea(p.title)}</title><meta property="og:title" content="${ea(p.title)}"><meta property="og:description" content="${ea(p.desc.slice(0, 150))}">${p.img ? `<meta property="og:image" content="${req.protocol}://${req.get('host')}${p.img}">` : ''}` : '<title>متجري</title>';
  res.send(page.replace('<!--OG-->', og));
});
app.listen(PORT, () => console.log('يعمل على المنفذ ' + PORT));
