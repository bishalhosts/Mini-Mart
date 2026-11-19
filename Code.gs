/**
 * MiniMart backend: Google Apps Script Web App.
 * Deploy with: Execute as = Me, Who has access = Anyone.
 */
const CONFIG = {
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID_HERE',
  PRODUCTS_SHEET: 'Products',
  ORDERS_SHEET: 'Orders',
  USERS_SHEET: 'Users',
  SESSIONS_SHEET: 'Sessions',
  DRIVE_FOLDER_ID: 'PASTE_DRIVE_FOLDER_ID_HERE',
  VENDOR_EMAIL: 'vendor@example.com',
  SESSION_HOURS: 24,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024
};

const EMAIL_RE = /^[a-z0-9][^\s@]*@[^\s@]+\.[^\s@]+$/i;

// Headers auto-created by sheet_() when a tab is empty.
const SCHEMA = {
  [CONFIG.PRODUCTS_SHEET]: ['id', 'name', 'category', 'description', 'price', 'unit', 'stock', 'imageUrl', 'discountPercent', 'discountEnds'],
  [CONFIG.ORDERS_SHEET]: ['orderId', 'timestamp', 'username', 'name', 'phone', 'email', 'items', 'total', 'paymentMethod', 'screenshotUrl', 'status', 'savings'],
  [CONFIG.USERS_SHEET]: ['username', 'passwordHash', 'salt', 'createdAt', 'lastLogin', 'email'],
  [CONFIG.SESSIONS_SHEET]: ['token', 'username', 'expiresAt']
};

/* ---------- Entry points ---------- */

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'products') {
      return json_({ success: true, products: getProducts_() });
    }
    return json_({ success: false, error: 'Unknown action' });
  } catch (err) { return errorJson_(err); }
}

function doPost(e) {
  try {
    // The browser sends JSON as text/plain (avoids a CORS preflight), so we parse it ourselves.
    const body = JSON.parse(e.postData.contents);
    const action = (e.parameter && e.parameter.action) || body.action;
    if (action === 'loginOrSignup') return json_(loginOrSignup_(body));
    if (action === 'placeOrder') return json_(placeOrder_(body));
    if (action === 'forgotPassword') return json_(forgotPassword_(body));
    if (action === 'resetPassword') return json_(resetPassword_(body));
    return json_({ success: false, error: 'Unknown action' });
  } catch (err) { return errorJson_(err); }
}

/** Run once from the editor: creates all four tabs and requests permissions. */
function initSheets() { Object.keys(SCHEMA).forEach(function (n) { sheet_(n); }); }

/* ---------- Authentication ---------- */

function loginOrSignup_(b) {
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,29}$/.test(username)) fail_('Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
  if (password.length < 6 || password.length > 100) fail_('Password must be 6–100 characters.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cache = CacheService.getScriptCache();
    const failKey = 'fail_' + username;
    if (Number(cache.get(failKey) || 0) >= 5) fail_('Too many wrong passwords. Try again in 10 minutes.');

    const users = sheet_(CONFIG.USERS_SHEET);
    const user = findUser_(username);
    const nowIso = new Date().toISOString();

    if (user) {
      // Existing user: re-hash the submitted password with the STORED salt and compare.
      if (!safeEqual_(hashPassword_(password, user.salt), user.hash)) {
        cache.put(failKey, String(Number(cache.get(failKey) || 0) + 1), 600);
        return { success: false, error: 'Wrong password' };
      }
      cache.remove(failKey);
      users.getRange(user.row, 5).setNumberFormat('@').setValue(nowIso);
      // Accounts made before emails existed get their email saved at the next login.
      if (!user.email && EMAIL_RE.test(email)) users.getRange(user.row, 6).setNumberFormat('@').setValue(email);
    } else {
      // New user: the frontend reveals the email box when it sees needEmail.
      if (!EMAIL_RE.test(email)) return { success: false, needEmail: true, error: 'New username! Enter your email to create the account.' };
      // Unique random salt per user; only salt + hash are stored, never the password.
      const salt = Utilities.getUuid();
      appendRow_(users, [username, hashPassword_(password, salt), salt, nowIso, nowIso, email]);
    }
    return createSession_(username);
  } finally { lock.releaseLock(); }
}

/**
 * Forgot password. Stored passwords are salted hashes and cannot be turned back into the original,
 * so we email a 6-digit code (valid 15 minutes) to the account's email instead.
 * The reply is the same whether or not the username exists, so nobody can probe for accounts.
 */
function forgotPassword_(b) {
  const username = String(b.username || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,29}$/.test(username)) fail_('Enter your username.');
  const cache = CacheService.getScriptCache();
  if (cache.get('fgt_' + username)) fail_('A code was just requested. Wait a minute and try again.');
  cache.put('fgt_' + username, '1', 60);
  const user = findUser_(username);
  if (user && user.email) {
    const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000 + 100000);
    cache.put('reset_' + username, code, 900);
    cache.remove('resetfail_' + username);
    mail_(user.email, 'Your MiniMart password reset code', 'Your MiniMart reset code is ' + code + '. It works for 15 minutes.\n\nIf you didn’t ask for it, ignore this email. Your password has not changed.');
  }
  return { success: true, message: 'If that account has an email address, a 6-digit code is on its way. It works for 15 minutes.' };
}

function resetPassword_(b) {
  const username = String(b.username || '').trim().toLowerCase();
  const code = String(b.code || '').trim();
  const newPassword = String(b.newPassword || '');
  if (newPassword.length < 6 || newPassword.length > 100) fail_('Password must be 6–100 characters.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cache = CacheService.getScriptCache();
    const saved = cache.get('reset_' + username);
    const tries = Number(cache.get('resetfail_' + username) || 0);
    if (!saved || tries >= 5) fail_('That code has expired. Request a new one.');
    if (!safeEqual_(saved, code)) { cache.put('resetfail_' + username, String(tries + 1), 900); fail_('Wrong code. Check the email and try again.'); }
    const user = findUser_(username);
    if (!user) fail_('That code has expired. Request a new one.');
    const salt = Utilities.getUuid(); // fresh salt for the new password
    sheet_(CONFIG.USERS_SHEET).getRange(user.row, 2, 1, 2).setNumberFormat('@').setValues([[hashPassword_(newPassword, salt), salt]]);
    ['reset_', 'resetfail_', 'fail_'].forEach(function (p) { cache.remove(p + username); });
    return createSession_(username);
  } finally { lock.releaseLock(); }
}

function findUser_(username) {
  const sh = sheet_(CONFIG.USERS_SHEET);
  const n = sh.getLastRow();
  if (n < 2) return null;
  const rows = sh.getRange(2, 1, n - 1, 6).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === username) return { row: i + 2, hash: String(rows[i][1]), salt: String(rows[i][2]), email: String(rows[i][5] || '') };
  }
  return null;
}

/** SHA-256(password + salt), returned as a hex string. */
function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function createSession_(username) {
  const sh = sheet_(CONFIG.SESSIONS_SHEET);
  const now = Date.now();
  const n = sh.getLastRow();
  if (n > 1) { // drop expired sessions so the tab stays small
    const v = sh.getRange(2, 3, n - 1, 1).getValues();
    for (let i = v.length - 1; i >= 0; i--) if (Number(v[i][0]) < now) sh.deleteRow(i + 2);
  }
  const token = Utilities.getUuid();
  const expiresAt = now + CONFIG.SESSION_HOURS * 3600000;
  appendRow_(sh, [token, username, String(expiresAt)]);
  return { success: true, username: username, token: token, expiresAt: expiresAt };
}

/** Returns the username for a valid, unexpired token; otherwise throws a SESSION error. */
function verifyToken_(token) {
  const sh = sheet_(CONFIG.SESSIONS_SHEET);
  const n = sh.getLastRow();
  const row = token && n > 1 ? sh.getRange(2, 1, n - 1, 3).getValues().find(function (r) { return String(r[0]) === String(token); }) : null;
  if (!row || Number(row[2]) < Date.now()) fail_('Session expired. Please log in again.', 'SESSION');
  return String(row[1]);
}

/* ---------- Products & orders ---------- */

/** Images must be SVG: a bare name or file name in the site's images/ folder, or an https URL ending in .svg. */
function svgImage_(v) {
  v = String(v || '').trim();
  if (/^[A-Za-z0-9_-]+$/.test(v)) return 'images/' + v + '.svg';
  if (/^[A-Za-z0-9_-]+\.svg$/i.test(v)) return 'images/' + v;
  if (/^https:\/\/[^\s'"<>]+\.svg(\?[^\s'"<>]*)?$/i.test(v)) return v;
  return '';
}

/**
 * Reads Products by header name, so the sheet columns can be in any order.
 * Rows keep their sheet order (first row added = listed first, FIFO); the site lifts discounted items to the front.
 * Discounts: discountPercent (1-99) puts a product on sale; discountEnds (optional) is the LAST day of the sale.
 * finalPrice is the only price used for orders, so the browser can never choose its own price.
 */
function readProducts_() {
  const sh = sheet_(CONFIG.PRODUCTS_SHEET);
  const n = sh.getLastRow();
  if (n < 2) return [];
  const data = sh.getRange(1, 1, n, sh.getLastColumn()).getValues();
  const h = data[0].map(function (x) { return String(x).trim().toLowerCase(); });
  const tz = Session.getScriptTimeZone();
  return data.slice(1).map(function (r, i) {
    const g = function (k) { const c = h.indexOf(k); return c < 0 ? '' : r[c]; };
    const price = Number(g('price')) || 0;
    const pct = Math.round(Number(g('discountpercent')) || 0);
    const end = g('discountends') ? new Date(g('discountends')) : null;
    const hasEnd = !!end && !isNaN(end.getTime());
    const active = pct > 0 && pct < 100 && (!hasEnd || end.getTime() + 86400000 > Date.now());
    return {
      row: i + 2, stockCol: h.indexOf('stock') + 1, id: String(g('id')).trim(), name: String(g('name')).trim(),
      category: String(g('category')).trim() || 'Other', description: String(g('description')).trim(),
      price: price, unit: String(g('unit')).trim() || 'piece', stock: Number(g('stock')) || 0,
      imageUrl: svgImage_(g('imageurl')),
      discountPercent: active ? pct : 0,
      finalPrice: active ? Math.round(price * (100 - pct)) / 100 : price,
      saleEnds: active && hasEnd ? Utilities.formatDate(end, tz, 'd MMM') : ''
    };
  }).filter(function (p) { return p.id && p.name; });
}

function getProducts_() {
  return readProducts_().map(function (p) {
    return { id: p.id, name: p.name, category: p.category, description: p.description, price: p.price, unit: p.unit,
      stock: p.stock, imageUrl: p.imageUrl, discountPercent: p.discountPercent, finalPrice: p.finalPrice, saleEnds: p.saleEnds };
  });
}

function placeOrder_(b) {
  const username = verifyToken_(b.token);
  const name = clean_(b.name, 80);
  const address = clean_(b.address, 300);
  const email = (findUser_(username) || {}).email || ''; // the account email gets the confirmation
  const phone = String(b.phone || '').replace(/[\s\-()]/g, '');
  const method = b.paymentMethod;
  const shot = b.screenshot;

  if (name.length < 2) fail_('Please enter your full name.');
  if (!/^\+?[0-9]{7,15}$/.test(phone)) fail_('Enter a valid phone number (7–15 digits).');
  if (address.length < 5) fail_('Please enter your delivery address.');
  if (method !== 'Cash on Delivery' && method !== 'QR Code Payment') fail_('Choose a payment method.');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) fail_('Your cart is empty.');
  if (method === 'QR Code Payment') {
    if (!shot || typeof shot.base64 !== 'string' || !shot.base64) fail_('Upload your payment screenshot for QR payment.');
    if (['image/jpeg', 'image/png', 'image/webp'].indexOf(shot.mimeType) < 0) fail_('Screenshot must be a JPG, PNG or WebP image.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let orderId, total = 0, savings = 0, itemsText;
  try {
    // Prices and stock always come from the sheet, never from the browser.
    const ps = sheet_(CONFIG.PRODUCTS_SHEET);
    const byId = {};
    readProducts_().forEach(function (p) { byId[p.id] = p; });

    const lines = [], deductions = [], seen = {};
    b.items.forEach(function (it) {
      const p = byId[String(it.id)];
      const qty = Number(it.qty);
      if (!p || seen[it.id]) fail_('A product in your cart is no longer available.');
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) fail_('Quantities must be whole numbers from 1 to 99.');
      if (qty > p.stock) fail_('Only ' + p.stock + ' ' + p.unit + ' of ' + p.name + ' left.');
      seen[it.id] = true;
      total += p.finalPrice * qty;
      savings += (p.price - p.finalPrice) * qty;
      lines.push(p.name + ' x' + qty + ' (' + p.unit + ') @ ' + p.finalPrice.toFixed(2) + (p.discountPercent ? ' (-' + p.discountPercent + '%)' : ''));
      deductions.push([p.row, p.stockCol, p.stock - qty]);
    });
    total = Math.round(total * 100) / 100;
    savings = Math.round(savings * 100) / 100;
    itemsText = lines.join('; ');

    const now = new Date();
    orderId = 'MM-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyMMdd') + '-' + Utilities.getUuid().slice(0, 4).toUpperCase();

    // Base64 upload: decode text -> bytes -> Blob -> file in the Drive folder.
    let screenshotUrl = '';
    if (method === 'QR Code Payment') {
      let bytes;
      try { bytes = Utilities.base64Decode(shot.base64); } catch (e) { fail_('The screenshot could not be read. Try another image.'); }
      if (bytes.length > CONFIG.MAX_IMAGE_BYTES) fail_('Screenshot is too large (max 5 MB).');
      const safeName = String(shot.filename || 'screenshot').replace(/[^\w.\-]/g, '_').slice(0, 60);
      const blob = Utilities.newBlob(bytes, shot.mimeType, orderId + '_' + safeName);
      screenshotUrl = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).createFile(blob).getUrl();
    }

    deductions.forEach(function (d) { ps.getRange(d[0], d[1]).setValue(d[2]); });
    const os = sheet_(CONFIG.ORDERS_SHEET);
    const row = appendRow_(os, [orderId, now.toISOString(), username, name, phone, email, itemsText, '', method, screenshotUrl, 'Pending']);
    os.getRange(row, 8).setNumberFormat('0.00').setValue(total);
    os.getRange(row, 12).setNumberFormat('0.00').setValue(savings);
  } finally { lock.releaseLock(); }

  const summary = 'Order ' + orderId + '\nItems: ' + itemsText + '\nTotal: ' + total.toFixed(2) + (savings > 0 ? ' (you saved ' + savings.toFixed(2) + ')' : '') + '\nPayment: ' + method + '\nDeliver to: ' + address + '\nPhone: ' + phone;
  mail_(CONFIG.VENDOR_EMAIL, 'New MiniMart order ' + orderId, 'Customer: ' + name + ' (' + username + ')\n' + summary);
  if (email) mail_(email, 'Your MiniMart order ' + orderId, 'Hi ' + name + ',\n\nThanks for your order! Here is your confirmation.\n\n' + summary + '\n\n— MiniMart');
  return { success: true, orderId: orderId };
}

/**
 * Run once from the editor to fill an EMPTY Products tab with 12 sample items (5 are on sale).
 * Delete the sample rows when you add your own products.
 */
function seedDemoProducts() {
  const sh = sheet_(CONFIG.PRODUCTS_SHEET);
  if (sh.getLastRow() > 1) { console.log('Products already has rows, so nothing was added.'); return; }
  const h = SCHEMA[CONFIG.PRODUCTS_SHEET];
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
  const end = new Date(Date.now() + 14 * 86400000);
  const rows = [
    ['p01', 'Tomatoes', 'Vegetables', 'Vine-ripened, picked this morning', 2.5, 'kg', 40, 'tomatoes.svg', 0, ''],
    ['p02', 'Spinach bunch', 'Vegetables', 'Tender leaves, washed', 1.2, 'bunch', 30, 'spinach.svg', 15, end],
    ['p03', 'Carrots', 'Vegetables', 'Sweet and crunchy', 1.8, 'kg', 25, 'carrots.svg', 0, ''],
    ['p04', 'Apples', 'Fruits', 'Crisp hill-grown apples', 4, 'kg', 20, 'apples.svg', 20, ''],
    ['p05', 'Bananas', 'Fruits', 'Naturally ripened', 2.2, 'dozen', 35, 'bananas.svg', 0, ''],
    ['p06', 'Woven bamboo basket', 'Handicrafts', 'Hand-woven, 30 cm', 12, 'piece', 8, 'basket.svg', 0, ''],
    ['p07', 'Painted ceramic mug', 'Handicrafts', 'Hand-painted, dishwasher safe', 9.5, 'piece', 15, 'mug.svg', 25, end],
    ['p08', 'Carved wooden elephant', 'Handicrafts', 'Carved from sheesham wood', 18, 'piece', 6, 'elephant.svg', 0, ''],
    ['p09', 'Hand-knit wool scarf', 'Textiles', 'Soft, warm and made to last', 22, 'piece', 10, 'scarf.svg', 30, end],
    ['p10', 'Cotton tote bag', 'Textiles', 'Block-printed pattern', 7.5, 'piece', 20, 'tote-bag.svg', 0, ''],
    ['p11', 'Soy candle', 'Home & Decor', 'Lavender, 40-hour burn', 11, 'piece', 12, 'candle.svg', 10, ''],
    ['p12', 'Local honey', 'Pantry', 'Raw, unfiltered, 500 g jar', 8, 'jar', 18, 'honey.svg', 0, '']
  ];
  sh.getRange(2, 1, rows.length, h.length).setValues(rows);
}

/* ---------- Helpers ---------- */

function sheet_(name) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    const h = SCHEMA[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Appends a row as plain text (keeps hashes/phones from being turned into numbers) and sanitizes formulas. */
function appendRow_(sh, row) {
  const r = sh.getRange(sh.getLastRow() + 1, 1, 1, row.length);
  r.setNumberFormat('@').setValues([row.map(safe_)]);
  return r.getRow();
}

/** Formula-injection guard: values starting with = + - @ get a leading apostrophe. */
function safe_(v) { v = String(v); return /^[=+\-@]/.test(v) ? "'" + v : v; }

function clean_(v, max) { return String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }

function mail_(to, subject, body) {
  try { MailApp.sendEmail(to, subject, body); } catch (e) { console.error('Mail failed: ' + e); }
}

function fail_(msg, code) { const e = new Error(msg); e.user = true; e.code = code; throw e; }

function errorJson_(err) {
  if (!err.user) console.error(err);
  return json_({ success: false, error: err.user ? err.message : 'Something went wrong on the server. Please try again.', code: err.code });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
