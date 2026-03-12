const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const APP_SECRET = process.env.ECONOMIC_APP_SECRET_TOKEN;
const GRANT      = process.env.ECONOMIC_GRANT_TOKEN;
const PASSWORD   = process.env.DASHBOARD_PASSWORD;

const HEADERS = {
  'X-AppSecretToken': APP_SECRET,
  'X-AgreementGrantToken': GRANT,
  'Content-Type': 'application/json'
};
const BASE = 'https://restapi.e-conomic.com';

const PL_MAP = {
  revenue:      { from: 1004, to: 1030 },
  directPay:    { from: 1100, to: 1112 },
  cogs:         { from: 1310, to: 1330 },
  salaries:     { from: 2210, to: 2285 },
  salesCosts:   { from: 2740, to: 2811 },
  rent:         { from: 3410, to: 3450 },
  adminCosts:   { from: 3600, to: 3790 },
  financial:    { from: 4310, to: 4481 },
};

const BANK_ACCOUNT = 6750;

app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: 'Forkert adgangskode' });
});

app.get('/api/test-pl', async (req, res) => {
  try {
    const year = 2026;
    const month = 2;

    let booked = [];
    let url = `${BASE}/accounting-years/${year}/entries?pagesize=1000&skippages=0`;
    while (url) {
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      booked = booked.concat(d.collection || []);
      url = d.pagination?.nextPage || null;
    }
    booked = booked.filter(e => new Date(e.date).getMonth() + 1 === month);

    let drafts = [];
    const journalNums = [1, 2, 3, 8, 11, 12, 13];
    for (const jNum of journalNums) {
      let jUrl = `${BASE}/journals/${jNum}/entries?pagesize=1000&skippages=0`;
      while (jUrl) {
        const r = await fetch(jUrl, { headers: HEADERS });
        const d = await r.json();
        const entries = (d.collection || []).filter(e => e.date && new Date(e.date).getFullYear() === year && new Date(e.date).getMonth() + 1 === month);
        drafts = drafts.concat(entries);
        jUrl = d.pagination?.nextPage || null;
      }
    }

    const combined = [...booked, ...drafts];

    // Per-konto breakdown for admin (3600-3790)
    const adminAccounts = {};
    combined.forEach(e => {
      const acc = e.account?.accountNumber || 0;
      if (acc >= 3600 && acc <= 3790) {
        if (!adminAccounts[acc]) adminAccounts[acc] = { booked: 0, drafts: 0 };
        const isBooked = !e.journal; // bogførte entries har ikke journal-felt
        if (e.journal) adminAccounts[acc].drafts += e.amount || 0;
        else adminAccounts[acc].booked += e.amount || 0;
      }
    });

    // Rund af
    Object.keys(adminAccounts).forEach(k => {
      adminAccounts[k].booked = Math.round(adminAccounts[k].booked);
      adminAccounts[k].drafts = Math.round(adminAccounts[k].drafts);
      adminAccounts[k].combined = adminAccounts[k].booked + adminAccounts[k].drafts;
    });

    const cats = Object.entries(PL_MAP).map(([name, range]) => {
      const b = booked.filter(e => inRange(e.account?.accountNumber || 0, range)).reduce((s, e) => s + (e.amount || 0), 0);
      const d = drafts.filter(e => inRange(e.account?.accountNumber || 0, range)).reduce((s, e) => s + (e.amount || 0), 0);
      return { name, range: `${range.from}-${range.to}`, booked: Math.round(b), drafts: Math.round(d), combined: Math.round(b + d) };
    });

    res.json({ month: 'Februar 2026', bookedCount: booked.length, draftsCount: drafts.length, categories: cats, adminByAccount: adminAccounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function fetchAllEntries(year) {
  let all = [];
  let url = `${BASE}/accounting-years/${year}/entries?pagesize=1000&skippages=0`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    all = all.concat(d.collection || []);
    url = d.pagination?.nextPage || null;
  }

  const journalNums = [1, 2, 3, 8, 11, 12, 13];
  for (const jNum of journalNums) {
    let jUrl = `${BASE}/journals/${jNum}/entries?pagesize=1000&skippages=0`;
    while (jUrl) {
      const r = await fetch(jUrl, { headers: HEADERS });
      const d = await r.json();
      const entries = (d.collection || []).filter(e => {
        if (!e.date) return false;
        return new Date(e.date).getFullYear() === year;
      });
      all = all.concat(entries);
      jUrl = d.pagination?.nextPage || null;
    }
  }

  return all;
}

async function fetchAllInvoices(year) {
  let all = [];
  let url = `${BASE}/invoices/booked?filter=date$gte:${year}-01-01$and:date$lte:${year}-12-31&pagesize=1000&skippages=0`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    all = all.concat(d.collection || []);
    url = d.pagination?.nextPage || null;
  }
  return all;
}

function inRange(acc, range) { return acc >= range.from && acc <= range.to; }

function sumCat(entries, range, month) {
  return entries
    .filter(e => new Date(e.date).getMonth() + 1 === month && inRange(e.account?.accountNumber || 0, range))
    .reduce((s, e) => s + (e.amount || 0), 0);
}

app.get('/api/revenue', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const [entries, invoices] = await Promise.all([
      fetchAllEntries(year),
      fetchAllInvoices(year)
    ]);

    const seen = new Set();
    const months = Array.from({length: 12}, (_, i) => {
      const m = i + 1;
      const revenue    = -(sumCat(entries, PL_MAP.revenue, m) + sumCat(entries, PL_MAP.directPay, m));
      const cogs       = sumCat(entries, PL_MAP.cogs, m);
      const salaries   = sumCat(entries, PL_MAP.salaries, m);
      const salesCosts = sumCat(entries, PL_MAP.salesCosts, m);
      const rent       = sumCat(entries, PL_MAP.rent, m);
      const adminCosts = sumCat(entries, PL_MAP.adminCosts, m);
      const financial  = sumCat(entries, PL_MAP.financial, m);
      const monthInv   = invoices.filter(inv => new Date(inv.date).getMonth() + 1 === m);
      const cids       = [...new Set(monthInv.map(inv => inv.customer?.customerNumber).filter(Boolean))];
      const newCustomers = cids.filter(c => !seen.has(c)).length;
      cids.forEach(c => seen.add(c));
      return { month: m, revenue, cogs, salaries, salesCosts, rent, adminCosts, financial, customers: cids.length, newCustomers };
    });

    res.json({ year, months });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/liquidity', async (req, res) => {
  try {
    const today = new Date();
    const toStr = today.toISOString().split('T')[0];
    const from  = new Date(today); from.setDate(today.getDate() - 180);
    const fromStr = from.toISOString().split('T')[0];

    const years = [...new Set([from.getFullYear(), today.getFullYear()])];
    let all = [];
    for (const y of years) all = all.concat(await fetchAllEntries(y));

    const bankEntries = all
      .filter(e => (e.account?.accountNumber || 0) === BANK_ACCOUNT && e.date >= fromStr && e.date <= toStr)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const dailyMap = {};
    bankEntries.forEach(e => {
      const day = e.date.split('T')[0];
      dailyMap[day] = (dailyMap[day] || 0) + (e.amount || 0);
    });

    const allDates = Object.keys(dailyMap).sort();
    let running = 0;
    const cumulMap = {};
    allDates.forEach(d => { running += dailyMap[d]; cumulMap[d] = running; });

    const cutoff = new Date(today); cutoff.setDate(today.getDate() - 90);
    let lastKnown = 0;
    allDates.forEach(d => { if (new Date(d) <= cutoff) lastKnown = cumulMap[d]; });

    const days = [];
    for (let d = new Date(cutoff); d <= today; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().split('T')[0];
      if (cumulMap[ds] !== undefined) lastKnown = cumulMap[ds];
      days.push({ date: ds, balance: lastKnown });
    }

    res.json({ days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/booked', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(`${BASE}/invoices/booked?pagesize=50&skippages=${page-1}&sort=bookedInvoiceNumber$desc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ invoices: d.collection || [], pageCount: Math.ceil((d.pagination?.results || 0) / 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/drafts', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/invoices/drafts?pagesize=100`, { headers: HEADERS });
    const d = await r.json();
    res.json({ invoices: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/unpaid', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/invoices/booked?filter=remainder$gt:0&pagesize=100&sort=dueDate$asc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ invoices: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(`${BASE}/customers?pagesize=50&skippages=${page-1}&sort=name$asc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ customers: d.collection || [], pageCount: Math.ceil((d.pagination?.results || 0) / 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/products?pagesize=100`, { headers: HEADERS });
    const d = await r.json();
    res.json({ products: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/orders/drafts?pagesize=100`, { headers: HEADERS });
    const d = await r.json();
    res.json({ orders: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kører på port ${PORT}`));
