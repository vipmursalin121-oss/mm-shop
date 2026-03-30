const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const BOT_TOKEN = '8629234754:AAG-mNYbprUdaH8fwYhtspvTx9lg8Wd25DQ';
const ADMIN_CHAT = '7410446660';
const API_KEY = 'b325dd8f2773e688ca6bee7b0611e835';
const API_URL = 'https://bdsmmpanel.com/api/v2';
const ADMIN_UID = 'MM-001';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function readDB(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return f.includes('users') ? {} : []; }
}
function writeDB(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

async function callAPI(p) {
  const body = new URLSearchParams({ key: API_KEY, ...p });
  const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  return r.json();
}

function genUID() {
  const users = readDB('users.json');
  return 'MM-' + String(Object.keys(users).length + 1).padStart(3, '0');
}
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function hashPass(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

function auth(req, res, next) {
  const token = req.headers['x-token'];
  const users = readDB('users.json');
  const user = Object.values(users).find(u => u.token === token);
  if (!user) return res.json({ error: 'Login করুন' });
  req.user = user;
  next();
}

function adminAuth(req, res, next) {
  const token = req.headers['x-token'];
  const users = readDB('users.json');
  const user = Object.values(users).find(u => u.token === token && u.isAdmin);
  if (!user) return res.json({ error: 'Admin access নেই' });
  req.user = user;
  next();
}

// Register
app.post('/api/register', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) return res.json({ error: 'সব তথ্য দিন' });
  const users = readDB('users.json');
  if (Object.values(users).find(u => u.phone === phone)) return res.json({ error: 'এই নম্বর আগেই রেজিস্টার করা' });
  const uid = genUID();
  const token = genToken();
  const isAdmin = Object.keys(users).length === 0;
  const user = { uid, name, phone, password: hashPass(password), balance: 0, token, isAdmin, createdAt: new Date().toISOString() };
  users[uid] = user;
  writeDB('users.json', users);
  bot.sendMessage(ADMIN_CHAT, `🆕 নতুন User!\n\n🆔 ID: ${uid}\n👤 নাম: ${name}\n📱 নম্বর: ${phone}\n${isAdmin ? '👑 ADMIN' : ''}`);
  res.json({ success: true, uid, token, name, balance: 0, isAdmin });
});

// Login
app.post('/api/login', (req, res) => {
  const { phone, password } = req.body;
  const users = readDB('users.json');
  const user = Object.values(users).find(u => u.phone === phone);
  if (!user) return res.json({ error: 'একাউন্ট পাওয়া যায়নি' });
  if (user.password !== hashPass(password)) return res.json({ error: 'পাসওয়ার্ড ভুল' });
  const token = genToken();
  user.token = token;
  users[user.uid] = user;
  writeDB('users.json', users);
  res.json({ success: true, uid: user.uid, token, name: user.name, balance: user.balance, isAdmin: user.isAdmin });
});

// Profile
app.get('/api/profile', auth, (req, res) => {
  const { password, token, ...safe } = req.user;
  res.json(safe);
});

// My Orders
app.get('/api/my-orders', auth, (req, res) => {
  const orders = readDB('orders.json');
  res.json(orders.filter(o => o.uid === req.user.uid).reverse().slice(0, 30));
});

// Place Order
app.post('/api/order', auth, async (req, res) => {
  const { serviceId, link, quantity, serviceName, price } = req.body;
  const users = readDB('users.json');
  const user = users[req.user.uid];
  if (user.balance < price) return res.json({ error: `ব্যালেন্স কম! আপনার ব্যালেন্স: ৳${user.balance}` });
  user.balance = Math.round((user.balance - price) * 100) / 100;
  writeDB('users.json', users);
  try {
    const apiRes = await callAPI({ action: 'add', service: serviceId, link, quantity });
    const orders = readDB('orders.json');
    const order = {
      id: 'ORD' + Date.now(),
      providerOrderId: apiRes.order || null,
      uid: user.uid, userName: user.name,
      serviceName, serviceId, link, quantity, price,
      status: apiRes.order ? 'Processing' : 'Failed',
      createdAt: new Date().toISOString()
    };
    orders.push(order);
    writeDB('orders.json', orders);
    if (apiRes.order) {
      bot.sendMessage(ADMIN_CHAT, `📦 নতুন অর্ডার!\n\n🆔 ${user.uid} | ${user.name}\n📱 ${user.phone}\n🛒 ${serviceName}\n📊 ${parseInt(quantity).toLocaleString()}\n💰 ৳${price}\n🔗 Provider: ${apiRes.order}`);
      res.json({ success: true, orderId: order.id, providerOrderId: apiRes.order, newBalance: user.balance });
    } else {
      user.balance = Math.round((user.balance + price) * 100) / 100;
      writeDB('users.json', users);
      res.json({ error: 'Order failed: ' + (apiRes.error || 'Unknown') });
    }
  } catch(e) {
    user.balance = Math.round((user.balance + price) * 100) / 100;
    writeDB('users.json', users);
    res.json({ error: 'সংযোগ সমস্যা' });
  }
});

// Order Status
app.get('/api/status/:id', auth, async (req, res) => {
  try { res.json(await callAPI({ action: 'status', order: req.params.id })); }
  catch(e) { res.json({ error: e.message }); }
});

// Add Funds Request
app.post('/api/funds-request', auth, (req, res) => {
  const { amount, trxId } = req.body;
  if (!amount || !trxId) return res.json({ error: 'পরিমাণ ও TrxID দিন' });
  const txns = readDB('transactions.json');
  const txn = { id: 'TXN' + Date.now(), uid: req.user.uid, userName: req.user.name, phone: req.user.phone, amount: parseFloat(amount), trxId, status: 'Pending', createdAt: new Date().toISOString() };
  txns.push(txn);
  writeDB('transactions.json', txns);
  bot.sendMessage(ADMIN_CHAT, `💳 Balance Request!\n\n🆔 ${req.user.uid} | ${req.user.name}\n📱 ${req.user.phone}\n💰 ৳${amount}\n🧾 TrxID: ${trxId}\n\n✅ Approve করতে:\n/addbal ${req.user.uid} ${amount}`);
  res.json({ success: true });
});

// Admin Routes
app.get('/api/admin/balance', adminAuth, async (req, res) => {
  try { res.json(await callAPI({ action: 'balance' })); } catch(e) { res.json({ error: e.message }); }
});
app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = readDB('users.json');
  res.json(Object.values(users).map(({ password, token, ...u }) => u));
});
app.get('/api/admin/orders', adminAuth, (req, res) => {
  res.json(readDB('orders.json').reverse().slice(0, 100));
});
app.get('/api/admin/transactions', adminAuth, (req, res) => {
  res.json(readDB('transactions.json').reverse().slice(0, 50));
});
app.post('/api/admin/addbal', adminAuth, (req, res) => {
  const { uid, amount } = req.body;
  const users = readDB('users.json');
  if (!users[uid]) return res.json({ error: 'User পাওয়া যায়নি' });
  users[uid].balance = Math.round((users[uid].balance + parseFloat(amount)) * 100) / 100;
  writeDB('users.json', users);
  bot.sendMessage(ADMIN_CHAT, `✅ Balance Added!\n${uid} → +৳${amount}\nNew: ৳${users[uid].balance}`);
  res.json({ success: true, newBalance: users[uid].balance });
});

// Telegram Bot
bot.onText(/\/start/, msg => {
  if (msg.chat.id.toString() !== ADMIN_CHAT) return;
  bot.sendMessage(ADMIN_CHAT, `👑 MM SHOP Admin Bot\n\nCommands:\n/users — সব user\n/orders — সব order\n/addbal MM-001 100 — balance add\n/balance — API balance\n/txns — pending requests`);
});

bot.onText(/\/users/, msg => {
  if (msg.chat.id.toString() !== ADMIN_CHAT) return;
  const users = readDB('users.json');
  const list = Object.values(users).slice(-15).map(u => `${u.uid} | ${u.name} | ৳${u.balance}`).join('\n');
  bot.sendMessage(ADMIN_CHAT, `👥 Users:\n\n${list || 'নেই'}`);
});

bot.onText(/\/orders/, msg => {
  if (msg.chat.id.toString() !== ADMIN_CHAT) return;
  const orders = readDB('orders.json');
  const list = orders.slice(-10).reverse().map(o => `${o.id}\n${o.uid} | ${o.serviceName} | ৳${o.price} | ${o.status}`).join('\n\n');
  bot.sendMessage(ADMIN_CHAT, `📦 Recent Orders:\n\n${list || 'নেই'}`);
});

bot.onText(/\/addbal (\S+) (\S+)/, (msg, match) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT) return;
  const uid = match[1].toUpperCase();
  const amount = parseFloat(match[2]);
  const users = readDB('users.json');
  if (!users[uid]) return bot.sendMessage(ADMIN_CHAT, '❌ User পাওয়া যায়নি: ' + uid);
  users[uid].balance = Math.round((users[uid].balance + amount) * 100) / 100;
  writeDB('users.json', users);
  bot.sendMessage(ADMIN_CHAT, `✅ Done!\n${uid} (${users[uid].name})\n+৳${amount}\nNew Balance: ৳${users[uid].balance}`);
});

bot.onText(/\/balance/, async msg => {
  if (msg.chat.id.toString() !== ADMIN_CHAT) return;
  const d = await callAPI({ action: 'balance' });
  bot.sendMessage(ADMIN_CHAT, `💰 API Balance: $${d.balance}\n≈ ৳${Math.round(d.balance * 110)}`);
});

bot.onText(/\/txns/, msg => {
  if (msg.chat.id.toString() !== ADMIN_CHAT) return;
  const txns = readDB('transactions.json');
  const pending = txns.filter(t => t.status === 'Pending').slice(-10);
  const list = pending.map(t => `${t.uid} | ${t.userName} | ৳${t.amount} | TrxID: ${t.trxId}\n/addbal ${t.uid} ${t.amount}`).join('\n\n');
  bot.sendMessage(ADMIN_CHAT, `💳 Pending Requests:\n\n${list || 'কোনো pending নেই'}`);
});

app.listen(3000, () => console.log('MM SHOP running! http://localhost:3000'));
