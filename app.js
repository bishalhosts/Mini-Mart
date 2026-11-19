'use strict';
window.MINIMART_VERSION = 4; // index.html checks this to detect an outdated app.js

/* ===== Settings: paste your Apps Script Web App URL below ===== */
const API_URL = 'https://script.google.com/macros/s/AKfycbzjnfZzBUzTVceKxRAYeAJB2ZFK-LZP3V2fvhcdWglX5Yy4u93P93coJYry5_34Q1R1/exec';
const CURRENCY = '$';
const SESSION_KEY = 'minimart_session';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const API_READY = API_URL.indexOf('https://') === 0; // false until the Web App URL is pasted in

const $ = (id) => document.getElementById(id);
const dlg = $('authDialog');
let products = [];
let cart = {}; // productId -> quantity
let activeCategory = 'All';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // textContent only: never inject HTML
  return n;
}
function show(node, text, type) { node.textContent = text; node.className = 'msg ' + (type || ''); }
const money = (n) => CURRENCY + n.toFixed(2);

/* ===== API helpers =====
 * CORS workaround: Apps Script web apps cannot answer a CORS preflight (OPTIONS) request.
 * A POST with Content-Type "text/plain" counts as a "simple request", so the browser skips
 * the preflight. We still send JSON, as a string, and the backend runs JSON.parse on it. */
async function apiPost(action, payload) {
  const res = await fetch(API_URL + '?action=' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  });
  try { return await res.json(); } catch (e) { return { success: false, error: 'Unexpected response from the server.' }; }
}
async function apiGetProducts() {
  const res = await fetch(API_URL + '?action=products');
  try { return await res.json(); } catch (e) { throw new Error('the server did not return product data'); }
}

/* ===== Session (localStorage) ===== */
function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s && s.token && s.expiresAt > Date.now() ? s : null;
  } catch (e) { return null; }
}
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* storage blocked */ } }
function logout(message) {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  applyAuthState();
  show($('orderMsg'), message || '', message ? 'error' : '');
}
/** Shopping is open to everyone; only the checkout details need a login. */
function applyAuthState() {
  const s = getSession();
  $('loginOpenBtn').hidden = !!s;
  $('userBar').hidden = !s;
  $('whoami').textContent = s ? 'Hi, ' + s.username : '';
  $('orderFields').hidden = !s;
  $('orderFields').disabled = !s; // disabled fields are skipped by browser form validation
  $('orderBtn').textContent = s ? 'Place order' : 'Log in to checkout';
}

/* ===== Login / sign up / forgot password (dialog) ===== */
const VIEWS = ['login', 'forgot', 'reset'];
function showView(v) { VIEWS.forEach((n) => { $(n + 'Form').hidden = n !== v; }); show($('authMsg'), ''); }
function openAuth() { showView('login'); if (!dlg.open) dlg.showModal(); }

async function authCall(btn, action, payload, onOk) {
  if (!API_READY) return show($('authMsg'), 'Login isn’t connected yet. Paste your Web App URL into API_URL in app.js (see SETUP.md, step 5).', 'error');
  btn.disabled = true;
  show($('authMsg'), 'Please wait…');
  try {
    const data = await apiPost(action, payload);
    if (data.success) { show($('authMsg'), ''); onOk(data); }
    else {
      if (data.needEmail) $('emailRow').hidden = false; // new username: ask for an email
      show($('authMsg'), data.error || 'Something went wrong.', 'error');
    }
  } catch (e) {
    show($('authMsg'), 'Network error. Check your connection and try again.', 'error');
  } finally { btn.disabled = false; }
}
function finishAuth(data) {
  saveSession({ username: data.username, token: data.token, expiresAt: data.expiresAt });
  VIEWS.forEach((n) => $(n + 'Form').reset());
  $('emailRow').hidden = true;
  dlg.close();
  applyAuthState();
  show($('orderMsg'), 'You’re logged in. Add your delivery details to finish the order.', 'ok');
}

$('loginForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  authCall($('authBtn'), 'loginOrSignup', { username: $('username').value.trim(), password: $('password').value, email: $('email').value.trim() }, finishAuth);
});
$('forgotForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  authCall($('forgotBtn'), 'forgotPassword', { username: $('forgotUser').value.trim() }, (d) => { showView('reset'); show($('authMsg'), d.message, 'ok'); });
});
$('resetForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  authCall($('resetBtn'), 'resetPassword', { username: $('forgotUser').value.trim(), code: $('resetCode').value.trim(), newPassword: $('newPassword').value }, finishAuth);
});
$('forgotLink').addEventListener('click', () => showView('forgot'));
document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => showView('login')));
$('loginOpenBtn').addEventListener('click', openAuth);
$('closeAuth').addEventListener('click', () => dlg.close());
$('logoutBtn').addEventListener('click', () => logout());

/* ===== Catalog: grouped by category ===== */
async function loadProducts() {
  const grid = $('productGrid');
  $('notice').hidden = true;
  if (!API_READY) {
    grid.textContent = 'Your product sheet isn’t connected yet. Paste your Web App URL into API_URL in app.js (see SETUP.md, step 5).';
    return updateSummary();
  }
  grid.textContent = 'Loading products…';
  try {
    const data = await apiGetProducts();
    if (!data.success) throw new Error(data.error || 'the server returned an error');
    products = data.products; // every product comes from the Google Sheet
    cart = {};
    renderCatalog();
  } catch (e) {
    grid.textContent = 'Could not load products (' + e.message + '). Check API_URL, and that the Web App is deployed with access set to Anyone.';
  }
  updateSummary();
}

const SALE = 'Offers';
const ICONS = { vegetables: '🥕', fruits: '🍎', handicrafts: '🧺', textiles: '🧶', 'home & decor': '🕯️', pantry: '🍯' };
const unitPrice = (p) => (p.finalPrice != null ? p.finalPrice : p.price);

function renderCatalog() {
  const bar = $('categoryBar'), root = $('productGrid');
  bar.replaceChildren(); root.replaceChildren();
  if (!products.length) { root.textContent = 'No products are listed right now. Please check back soon.'; return; }
  // Listing order is FIFO: the sheet’s own row order, first row first. Discounted items move to the front.
  const offers = products.filter((p) => p.discountPercent > 0);
  const regular = products.filter((p) => !(p.discountPercent > 0));
  const cats = Array.from(new Set(products.map((p) => p.category)));
  const chips = ['All'].concat(offers.length ? [SALE] : [], cats);
  if (chips.indexOf(activeCategory) < 0) activeCategory = 'All';

  chips.forEach((c) => {
    const chip = el('button', 'chip' + (c === activeCategory ? ' on' : ''), c);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(c === activeCategory));
    chip.addEventListener('click', () => { activeCategory = c; renderCatalog(); });
    bar.append(chip);
  });

  let sections; // [title, items]
  if (activeCategory === 'All') sections = [[SALE, offers]].concat(cats.map((c) => [c, regular.filter((p) => p.category === c)]));
  else if (activeCategory === SALE) sections = [[SALE, offers]];
  else sections = [[activeCategory, offers.concat(regular).filter((p) => p.category === activeCategory)]];
  sections.filter((s) => s[1].length).forEach((s) => {
    const sec = el('section', 'cat' + (s[0] === SALE ? ' offers' : '')), grid = el('div', 'grid');
    s[1].forEach((p) => grid.append(productCard(p)));
    sec.append(el('h3', '', s[0]), grid);
    root.append(sec);
  });
}

function productCard(p) {
  const out = p.stock < 1, sale = p.discountPercent > 0;
  const card = el('article', 'card' + (out ? ' out' : ''));
  const media = el('div', 'media');
  const placeholder = () => { // no photo yet: a tinted tile with the category icon
    const d = el('div', 'ph', ICONS[p.category.toLowerCase()] || p.name.charAt(0).toUpperCase());
    let hue = 0;
    for (const ch of p.category) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    d.style.background = 'hsl(' + hue + ' 60% 90%)';
    d.setAttribute('aria-hidden', 'true');
    return d;
  };
  if (/^(images\/[\w-]+\.svg|https:\/\/\S+\.svg(\?\S*)?)$/i.test(p.imageUrl)) { // SVG images only
    const img = el('img');
    img.src = p.imageUrl; img.alt = p.name; img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(placeholder()));
    media.append(img);
  } else media.append(placeholder());
  if (sale) media.append(el('span', 'badge', '-' + p.discountPercent + '%'));

  const body = el('div', 'body');
  body.append(el('h4', '', p.name));
  if (p.description) body.append(el('p', 'desc', p.description));
  const price = el('div', 'pricebox');
  price.append(el('span', 'price', money(unitPrice(p)) + ' / ' + p.unit));
  if (sale) price.append(el('s', 'was', money(p.price)));
  body.append(price);
  if (sale && p.saleEnds) body.append(el('span', 'stock', 'Sale ends ' + p.saleEnds));
  body.append(el('span', 'stock', out ? 'Out of stock' : p.stock + ' in stock'));

  const qty = el('div', 'qty');
  const input = el('input');
  input.type = 'number'; input.min = 0; input.max = p.stock; input.value = cart[p.id] || 0;
  input.disabled = out; input.setAttribute('aria-label', 'Quantity of ' + p.name);
  const set = (q) => {
    q = Math.max(0, Math.min(p.stock, Math.floor(Number(q) || 0)));
    input.value = q; cart[p.id] = q; updateSummary();
  };
  const minus = el('button', '', '−'), plus = el('button', '', '+');
  minus.type = plus.type = 'button'; minus.disabled = plus.disabled = out;
  minus.setAttribute('aria-label', 'Remove one ' + p.name); plus.setAttribute('aria-label', 'Add one ' + p.name);
  minus.addEventListener('click', () => set(Number(input.value) - 1));
  plus.addEventListener('click', () => set(Number(input.value) + 1));
  input.addEventListener('change', () => set(input.value));
  qty.append(minus, input, plus);
  body.append(qty);
  card.append(media, body);
  return card;
}

function updateSummary() {
  const list = $('cartSummary');
  list.replaceChildren();
  let total = 0, saved = 0;
  products.forEach((p) => {
    const q = cart[p.id] || 0;
    if (q > 0) {
      total += q * unitPrice(p); saved += q * (p.price - unitPrice(p));
      list.append(el('li', '', p.name + ' × ' + q + ' = ' + money(q * unitPrice(p))));
    }
  });
  if (!list.children.length) list.append(el('li', '', 'Nothing selected yet. Add items above.'));
  $('cartTotal').textContent = money(total);
  $('cartSaved').hidden = saved < 0.005;
  $('cartSaved').textContent = 'You save ' + money(saved) + ' with discounts';
}

/* ===== Payment toggle ===== */
document.querySelectorAll('input[name="payment"]').forEach((r) => r.addEventListener('change', () => {
  const qr = document.querySelector('input[name="payment"]:checked').value === 'QR Code Payment';
  $('qrSection').hidden = !qr;
  $('screenshot').required = qr; // the screenshot is mandatory for QR payments
}));

/* ===== Base64 upload =====
 * FileReader.readAsDataURL gives "data:image/png;base64,AAAA...". The backend only wants the
 * Base64 part, so we cut off everything up to the comma and send it with mimeType + filename. */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: String(reader.result).split(',')[1], mimeType: file.type, filename: file.name });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/* ===== Checkout ===== */
$('orderForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('orderMsg');
  const items = Object.keys(cart).filter((id) => cart[id] > 0).map((id) => ({ id: id, qty: cart[id] }));
  if (!items.length) return show(msg, 'Add at least one item to your order first.', 'error');

  const session = getSession();
  if (!session) { show(msg, ''); return openAuth(); } // login is only asked for when the shopper is ready to buy

  const method = document.querySelector('input[name="payment"]:checked').value;
  const file = $('screenshot').files[0];
  if (method === 'QR Code Payment') {
    if (!file) return show(msg, 'Upload your payment screenshot to pay by QR code.', 'error');
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return show(msg, 'The screenshot must be a JPG, PNG or WebP image.', 'error');
    if (file.size > MAX_IMAGE_BYTES) return show(msg, 'The screenshot is larger than 5 MB.', 'error');
  }

  const btn = $('orderBtn');
  btn.disabled = true;
  show(msg, 'Placing your order…');
  try {
    const payload = {
      token: session.token, items: items, paymentMethod: method,
      name: $('fullName').value.trim(), phone: $('phone').value.trim(), address: $('address').value.trim()
    };
    if (method === 'QR Code Payment') payload.screenshot = await readFile(file);
    const data = await apiPost('placeOrder', payload);
    if (data.success) {
      show(msg, 'Order placed! Your order ID is ' + data.orderId + '.', 'ok');
      $('orderForm').reset();
      $('qrSection').hidden = true;
      loadProducts(); // refresh stock levels and clear the cart
    } else if (data.code === 'SESSION') {
      logout(data.error); openAuth();
    } else {
      show(msg, data.error || 'Could not place your order.', 'error');
    }
  } catch (e) {
    show(msg, 'Network error. Your order was not confirmed, so please try again.', 'error');
  } finally { btn.disabled = false; }
});

/* ===== Start ===== */
applyAuthState();
loadProducts();
