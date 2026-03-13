// v5
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
const BASE      = 'https://restapi.e-conomic.com';
const BASE_NEW  = 'https://apis.e-conomic.com/journalsapi/v14.0.1';

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

function draftAmountDKKExVat(e) {
  const rate = (e.exchangeRate || 100) / 100;
  if (e.entryTypeNumber === 3) {
    const dkk = Math.abs(e.amount || 0) * rate;
    const hasVat = e.contraVatCode || e.vatCode;
    return hasVat ? dkk / 1.25 : dkk;
  } else {
    const dkk = (e.amount || 0) * rate;
    const hasVat = e.contraVatCode || e.vatCode;
    return hasVat ? dkk / 1.25 : dkk;
  }
}

// Debug: vis alle rå kladde-entries for salg+admin i feb 2026
app.get('/api/test-drafts-raw', async (req, res) => {
  try {
    const year = 2026, month = 2;
    let drafts = [];
    let dUrl = `${BASE_NEW}/draft-entries`;
    while (dUrl) {
      const r = await fetch(dUrl, { headers: HEADERS });
      const d = await r.json();
      const items = (d.items || []).filter(e => {
        if (!e.date) return false;
        const date = new Date(e.date);
        return date.getFullYear() === year && date.getMonth() + 1 === month;
      });
      drafts = drafts.concat(items);
      dUrl = d.cursor ? `${BASE_NEW}/draft-entries?cursor=${d.cursor}` : null;
    }

    const relevant = drafts
      .map(e => {
        const acc = e.entryTypeNumber === 3 ? (e.contraAccountNumber || 0) : (e.accountNumber || 0);
        const inSales = acc >= 2740 && acc <= 2811;
        const inAdmin = acc >= 3600 && acc <= 3790;
        if (!inSales && !inAdmin) return null;
        return {
          cat: inSales ? 'salg' : 'admin',
          acc,
          entryTypeNumber: e.entryTypeNumber,
          accountNumber: e.accountNumber,
          contraAccountNumber: e.contraAccountNumber,
          amount: e.amount,
          exchangeRate: e.exchangeRate,
          vatCode: e.vatCode,
          contraVatCode: e.contraVatCode,
          computed: Math.round(draftAmountDKKExVat(e))
        };
      })
      .filter(Boolean);

    const salesTotal = relevant.filter(e => e.cat === 'salg').reduce((s, e) => s + e.computed, 0);
    const adminTotal = relevant.filter(e => e.cat === 'admin').reduce((s, e) => s + e.computed, 0);

    res.json({ salesTotal, adminTotal, entries: relevant });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    let dUrl = `${BASE_NEW}/draft-entries`;
    while (dUrl) {
      const r = await fetch(dUrl, { headers: HEADERS });
      const d = await r.json();
      const items = (d.items || []).filter(e => {
        if (!e.date) return false;
        const date = new Date(e.date);
        return date.getFullYear() === year && date.getMonth() + 1 === month;
      });
      drafts = drafts.concat(items);
      dUrl = d.cursor ? `${BASE_NEW}/draft-entries?cursor=${d.cursor}` : null;
    }

    const adminAccounts = {};
    booked.forEach(e => {
      const acc = e.account?.accountNumber || 0;
      if (acc >= 3600 && acc <= 3790) {
        if (!adminAccounts[acc]) adminAccounts[acc] = { booked: 0, drafts: 0 };
        adminAccounts[acc].booked += e.amount || 0;
      }
    });
    drafts.forEach(e => {
      const acc = e.entryTypeNumber === 3 ? (e.contraAccountNumber || 0) : (e.accountNumber || 0);
      if (acc >= 3600 && acc <= 3790) {
        if (!adminAccounts[acc]) adminAccounts[acc] = { booked: 0, drafts: 0 };
        adminAccounts[acc].drafts += draftAmountDKKExVat(e);
      }
    });
    Object.keys(adminAccounts).forEach(k => {
      adminAccounts[k].booked = Math.round(adminAccounts[k].booked);
      adminAccounts[k].drafts = Math.round(adminAccounts[k].drafts);
      adminAccounts[k].combined = adminAccounts[k].booked + adminAccounts[k].drafts;
    });

    const salaryAccounts = {};
    booked.forEach(e => {
      const acc = e.account?.accountNumber || 0;
      if (acc >= 2210 && acc <= 2285) {
        if (!salaryAccounts[acc]) salaryAccounts[acc] = { booked: 0, drafts: 0 };
        salaryAccounts[acc].booked += e.amount || 0;
      }
    });
    drafts.forEach(e => {
      const acc = e.entryTypeNumber === 3 ? (e.contraAccountNumber || 0) : (e.accountNumber || 0);
      if (acc >= 2210 && acc <= 2285) {
        if (!salaryAccounts[acc]) salaryAccounts[acc] = { booked: 0, drafts: 0 };
        salaryAccounts[acc].drafts += draftAmountDKKExVat(e);
      }
    });
    Object.keys(salaryAccounts).forEach(k => {
      salaryAccounts[k].booked = Math.round(salaryAccounts[k].booked);
      salaryAccounts[k].drafts = Math.round(salaryAccounts[k].drafts);
      salaryAccounts[k].combined = salaryAccounts[k].booked + salaryAccounts[k].drafts;
    });

    const cats = Object.entries(PL_MAP).map(([name, range]) => {
      const b = booked.filter(e => inRange(e.account?.accountNumber || 0, range)).reduce((s, e) => s + (e.amount || 0), 0);
      const d = drafts.reduce((s, e) => {
        const acc = e.entryTypeNumber === 3 ? (e.contraAccountNumber || 0) : (e.accountNumber || 0);
        if (!inRange(acc, range)) return s;
        return s + draftAmountDKKExVat(e);
      }, 0);
      return { name, range: `${range.from}-${range.to}`, booked: Math.round(b), drafts: Math.round(d), combined: Math.round(b + d) };
    });

    res.json({ month: 'Februar 2026', bookedCount: booked.length, draftsCount: drafts.length, categories: cats, adminByAccount: adminAccounts, salaryByAccount: salaryAccounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function fetchAllDraftEntries(year) {
  let drafts = [];
  let url = `${BASE_NEW}/draft-entries`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    const items = (d.items || []).filter(e => {
      if (!e.date) return false;
      return new Date(e.date).getFullYear() === year;
    });
    drafts = drafts.concat(items);
    url = d.cursor ? `${BASE_NEW}/draft-entries?cursor=${d.cursor}` : null;
  }
  return drafts;
}

async function fetchAllEntries(year) {
  let all = [];
  let url = `${BASE}/accounting-years/${year}/entries?pagesize=1000&skippages=0`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    all = all.concat(d.collection || []);
    url = d.pagination?.nextPage || null;
  }
  const drafts = await fetchAllDraftEntries(year);
  all = all.concat(drafts);
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
    .filter(e => {
      const date = new Date(e.date);
      const acc = e.entryTypeNumber === 3
        ? (e.contraAccountNumber || 0)
        : (e.account?.accountNumber || e.accountNumber || 0);
      return date.getMonth() + 1 === month && inRange(acc, range);
    })
    .reduce((s, e) => {
      if (e.account) return s + (e.amount || 0);
      return s + draftAmountDKKExVat(e);
    }, 0);
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
      .filter(e => {
        const acc = e.account?.accountNumber || 0;
        const dateStr = (e.date || '').split('T')[0];
        return acc === BANK_ACCOUNT && dateStr >= fromStr && dateStr <= toStr;
      })
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
