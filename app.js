'use strict';
window.MINIMART_VERSION = 5;

/* ===== Settings ===== */
const API_URL = 'https://script.google.com/macros/s/AKfycbzjnfZzBUzTVceKxRAYeAJB2ZFK-LZP3V2fvhcdWglX5Yy4u93P93coJYry5_34Q1R1/exec'; // Ensure your URL is here
const CURRENCY = 'Rs '; // Changed to Nepalese Rupee
const SESSION_KEY = 'minimart_session';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const API_READY = API_URL.indexOf('https://') === 0;

const $ = (id) => document.getElementById(id);
const authDlg = $('authDialog');
const checkoutDlg = $('checkoutDialog');
let products = [];
let cart = {}; // productId -> quantity
let activeCategory = 'All';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function show(node, text, type) { node.textContent = text; node.className = 'msg ' + (type || ''); }
const money = (n) => CURRENCY + n.toFixed(2);

async function apiPost(action, payload) {
  const res = await fetch(API_URL + '?action=' + action, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload)
  });
  try { return await res.json(); } catch (e) { return { success: false, error: 'Unexpected response.' }; }
}
async function apiGetProducts() {
  const res = await fetch(API_URL + '?action=products');
  try { return await res.json(); } catch (e) { throw new Error('Server error'); }
}

/* ===== Auth & Session ===== */
function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s && s.token && s.expiresAt > Date.now() ? s : null;
  } catch (e) { return null; }
}
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
function logout(message) {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  applyAuthState();
  show($('orderMsg'), message || '', message ? 'error' : '');
}
function applyAuthState() {
  const s = getSession();
  $('loginOpenBtn').hidden = !!s;
  $('userBar').hidden = !s;
  $('whoami').textContent = s ? 'Hi, ' + s.username : '';
  $('orderFields').hidden = !s;
  $('orderFields').disabled = !s;
  $('orderBtn').textContent = s ? 'Place order' : 'Log in to checkout';
}

const VIEWS = ['login', 'forgot', 'reset'];
function showView(v) { VIEWS.forEach((n) => { $(n + 'Form').hidden = n !== v; }); show($('authMsg'), ''); }
function openAuth() { showView('login'); if (!authDlg.open) authDlg.showModal(); }

async function authCall(btn, action, payload, onOk) {
  if (!API_READY) return show($('authMsg'), 'Not connected to backend.', 'error');
  btn.disabled = true;
  show($('authMsg'), 'Please wait…');
  try {
    const data = await apiPost(action, payload);
    if (data.success) { show($('authMsg'), ''); onOk(data); }
    else {
      if (data.needEmail) $('emailRow').hidden = false;
      show($('authMsg'), data.error || 'Something went wrong.', 'error');
    }
  } catch (e) {
    show($('authMsg'), 'Network error.', 'error');
  } finally { btn.disabled = false; }
}
function finishAuth(data) {
  saveSession({ username: data.username, token: data.token, expiresAt: data.expiresAt });
  VIEWS.forEach((n) => $(n + 'Form').reset());
  $('emailRow').hidden = true;
  authDlg.close();
  applyAuthState();
  if (checkoutDlg.open) show($('orderMsg'), 'You’re logged in. Add delivery details to finish.', 'ok');
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
$('closeAuth').addEventListener('click', () => authDlg.close());
$('logoutBtn').addEventListener('click', () => logout());

/* ===== Checkout Dialog Logic ===== */
$('openCartBtn').addEventListener('click', () => {
  if (!checkoutDlg.open) checkoutDlg.showModal();
});
$('closeCheckout').addEventListener('click', () => checkoutDlg.close());

/* ===== Catalog ===== */
async function loadProducts() {
  const grid = $('productGrid');
  $('notice').hidden = true;
  if (!API_READY) {
    grid.textContent = 'Paste your Web App URL into API_URL in app.js.';
    return updateSummary();
  }
  grid.textContent = 'Loading products…';
  try {
    const data = await apiGetProducts();
    if (!data.success) throw new Error(data.error || 'Server error');
    products = data.products;
    cart = {};
    renderCatalog();
    updateSummary(); // Reset cart icon
  } catch (e) {
    grid.textContent = 'Could not load products (' + e.message + '). Check API_URL.';
  }
}

const SALE = 'Offers';
const ICONS = { vegetables: '🥕', fruits: '🍎', handicrafts: '🧺', textiles: '🧶', 'home & decor': '🕯️', pantry: '🍯' };
const unitPrice = (p) => (p.finalPrice != null ? p.finalPrice : p.price);

function renderCatalog() {
  const bar = $('categoryBar'), root = $('productGrid');
  bar.replaceChildren(); root.replaceChildren();
  if (!products.length) { root.textContent = 'No products are listed right now.'; return; }
  
  const offers = products.filter((p) => p.discountPercent > 0);
  const regular = products.filter((p) => !(p.discountPercent > 0));
  const cats = Array.from(new Set(products.map((p) => p.category)));
  const chips = ['All'].concat(offers.length ? [SALE] : [], cats);
  if (chips.indexOf(activeCategory) < 0) activeCategory = 'All';

  chips.forEach((c) => {
    const chip = el('button', 'chip' + (c === activeCategory ? ' on' : ''), c);
    chip.type = 'button';
    chip.addEventListener('click', () => { activeCategory = c; renderCatalog(); });
    bar.append(chip);
  });

  let sections;
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
  const placeholder = () => {
    const d = el('div', 'ph', ICONS[p.category.toLowerCase()] || p.name.charAt(0).toUpperCase());
    let hue = 0;
    for (const ch of p.category) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    d.style.background = 'hsl(' + hue + ' 60% 90%)';
    return d;
  };
  
  if (/^(images\/[\w-]+\.svg|https:\/\/\S+\.svg(\?\S*)?)$/i.test(p.imageUrl)) {
    const img = el('img');
    img.src = p.imageUrl; img.alt = p.name; img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(placeholder()));
    media.append(img);
  } else {
    media.append(placeholder());
  }
  if (sale) media.append(el('span', 'badge', 'Sale -' + p.discountPercent + '%'));

  const body = el('div', 'body');
  body.append(el('div', 'cat-label', p.category));
  body.append(el('h4', '', p.name));
  
  const stars = el('div', 'stars');
  stars.innerHTML = '<span class="star-icon">★</span><span class="star-icon">★</span><span class="star-icon">★</span><span class="star-icon">★</span><span class="star-icon">★</span> <span>(12)</span>';
  body.append(stars);

  const price = el('div', 'pricebox');
  price.append(el('span', 'price', money(unitPrice(p)) + ' / ' + p.unit));
  if (sale) price.append(el('s', 'was', money(p.price)));
  body.append(price);

  const actionArea = el('div', 'card-action');
  
  function renderAction() {
    actionArea.replaceChildren();
    const qty = cart[p.id] || 0;
    if (qty === 0) {
      const addBtn = el('button', 'btn add-btn', out ? 'Out of stock' : 'Add to Cart');
      addBtn.type = 'button';
      addBtn.disabled = out;
      addBtn.addEventListener('click', () => { cart[p.id] = 1; updateSummary(); renderAction(); });
      actionArea.append(addBtn);
    } else {
      const qtyBox = el('div', 'qty');
      const minus = el('button', '', '−'), input = el('input'), plus = el('button', '', '+');
      minus.type = plus.type = 'button';
      input.type = 'number'; input.value = qty; input.readOnly = true;
      
      const update = (newQ) => {
        newQ = Math.max(0, Math.min(p.stock, newQ));
        cart[p.id] = newQ;
        updateSummary();
        if (newQ === 0) renderAction(); else input.value = newQ;
      };
      
      minus.addEventListener('click', () => update(qty - 1));
      plus.addEventListener('click', () => update(qty + 1));
      
      qtyBox.append(minus, input, plus);
      actionArea.append(qtyBox);
    }
  }
  
  renderAction();
  body.append(actionArea);
  
  card.append(media, body);
  return card;
}

/* Updates the cart totals and header badge */
function updateSummary() {
  const list = $('cartSummary');
  list.replaceChildren();
  let total = 0, saved = 0, itemCount = 0;
  
  products.forEach((p) => {
    const q = cart[p.id] || 0;
    if (q > 0) {
      total += q * unitPrice(p); 
      saved += q * (p.price - unitPrice(p));
      itemCount += q;
      list.append(el('li', '', p.name + ' × ' + q + ' = ' + money(q * unitPrice(p))));
    }
  });
  
  if (!list.children.length) list.append(el('li', '', 'Nothing selected yet.'));
  $('cartTotal').textContent = money(total);
  $('cartSaved').hidden = saved < 0.005;
  $('cartSaved').textContent = 'You save ' + money(saved) + ' with discounts';
  
  // Update Header Badge
  const badge = $('cartBadge');
  if (itemCount > 0) {
    badge.textContent = itemCount;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

document.querySelectorAll('input[name="payment"]').forEach((r) => r.addEventListener('change', () => {
  const qr = document.querySelector('input[name="payment"]:checked').value === 'QR Code Payment';
  $('qrSection').hidden = !qr;
  $('screenshot').required = qr;
}));

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: String(reader.result).split(',')[1], mimeType: file.type, filename: file.name });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

$('orderForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('orderMsg');
  const items = Object.keys(cart).filter((id) => cart[id] > 0).map((id) => ({ id: id, qty: cart[id] }));
  if (!items.length) return show(msg, 'Add at least one item to your order first.', 'error');

  const session = getSession();
  if (!session) { show(msg, ''); return openAuth(); }

  const method = document.querySelector('input[name="payment"]:checked').value;
  const file = $('screenshot').files[0];
  if (method === 'QR Code Payment') {
    if (!file) return show(msg, 'Upload your payment screenshot.', 'error');
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return show(msg, 'Image must be JPG, PNG or WebP.', 'error');
    if (file.size > MAX_IMAGE_BYTES) return show(msg, 'Image is larger than 5 MB.', 'error');
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
      show(msg, 'Order placed! ID: ' + data.orderId, 'ok');
      $('orderForm').reset();
      $('qrSection').hidden = true;
      loadProducts();
      setTimeout(() => { checkoutDlg.close(); }, 3000); // Close checkout after 3s on success
    } else if (data.code === 'SESSION') {
      logout(data.error); openAuth();
    } else {
      show(msg, data.error || 'Could not place your order.', 'error');
    }
  } catch (e) {
    show(msg, 'Network error. Please try again.', 'error');
  } finally { btn.disabled = false; }
});

applyAuthState();
loadProducts();
