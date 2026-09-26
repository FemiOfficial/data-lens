import fs from 'node:fs';
import * as XLSX from 'xlsx';
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const regions = ['Lagos', 'Abuja', 'Nairobi', 'Accra', 'Cape Town', 'Cairo'];
const products = ['Laptop', 'Phone', 'Tablet', 'Monitor', 'Headphones', 'Keyboard'];
const price = { Laptop: 950, Phone: 620, Tablet: 410, Monitor: 230, Headphones: 85, Keyboard: 45 };
const reps = ['Ada', 'Tunde', 'Wanjiru', 'Kofi', 'Thandi', 'Omar', 'Zainab'];
const rows = [['order_id', 'date', 'region', 'product', 'sales rep', 'qty', 'unit_price', 'discount', 'status', 'notes']];
for (let i = 0; i < 2500; i++) {
  const p = pick(products);
  const d = new Date(2025, 0, 1 + Math.floor(rnd() * 365));
  rows.push([
    `ORD-${10000 + i}`,
    d.toISOString().slice(0, 10),
    pick(regions),
    p,
    pick(reps),
    1 + Math.floor(rnd() * 12),
    (price[p] * (0.9 + rnd() * 0.2)).toFixed(2),
    rnd() < 0.3 ? (rnd() * 0.25).toFixed(2) : '',
    pick(['paid', 'paid', 'paid', 'refunded', 'pending']),
    rnd() < 0.06 ? '  needs follow-up, "urgent" ' : rnd() < 0.04 ? 'gift wrap\nsecond line' : '',
  ]);
}
if (rows.length > 3) rows.push(rows[5].slice()); // one exact duplicate for dedupe testing
const csv = rows.map((r) => r.map((v) => (/[",\n]|^\s|\s$/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';

const wb = XLSX.utils.book_new();
const inv = [['SKU', 'Product', 'Warehouse', 'In stock', 'Reorder level', 'Unit cost', 'Last restock']];
let n = 0;
for (const p of products) for (const w of ['North', 'South', 'West']) inv.push([`SKU-${100 + n++}`, p, w, Math.floor(rnd() * 400), 50, price[p] * 0.6, new Date(2025, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27))]);
const ws1 = XLSX.utils.aoa_to_sheet(inv, { cellDates: true });
ws1['H1'] = { t: 's', v: 'Stock value' };
for (let r = 2; r <= inv.length; r++) ws1[`H${r}`] = { t: 'n', f: `D${r}*F${r}`, v: inv[r - 1][3] * inv[r - 1][5] };
ws1['!ref'] = `A1:H${inv.length}`;
XLSX.utils.book_append_sheet(wb, ws1, 'Inventory');
const sup = [['Supplier', 'Country', 'Lead time (days)', 'Rating'], ['Shenzhen Parts Co', 'China', 21, 4.6], ['Lagos Tech Supply', 'Nigeria', 5, 4.1], ['Nairobi Components', 'Kenya', 9, 3.9], ['Berlin Devices', 'Germany', 14, 4.8]];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sup), 'Suppliers');

const users = {
  meta: { generated: '2026-09-26', version: 3, source: 'crm-export', tags: ['beta', 'internal'] },
  settings: { theme: { primary: '#2a78d6', accent: '#eb6834' }, features: { exports: true, charts: true, ai: false }, limits: { rows: 100000, uploadMB: 50 } },
  users: Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    name: `${pick(['Ada', 'Chidi', 'Amara', 'Kwame', 'Lerato', 'Samir', 'Nia', 'Tobi'])} ${pick(['Okafor', 'Mensah', 'Kamau', 'Ndlovu', 'Haddad', 'Bello'])}`,
    email: `user${i + 1}@example.com`,
    active: rnd() > 0.2,
    age: 18 + Math.floor(rnd() * 50),
    plan: pick(['free', 'pro', 'team']),
    address: { city: pick(regions), country: pick(['NG', 'KE', 'GH', 'ZA', 'EG']), geo: { lat: +(rnd() * 60 - 30).toFixed(4), lng: +(rnd() * 60).toFixed(4) } },
    roles: rnd() > 0.7 ? ['admin', 'editor'] : ['viewer'],
    lastLogin: rnd() > 0.1 ? new Date(2026, 8, Math.floor(rnd() * 25) + 1).toISOString() : null,
    website: rnd() > 0.7 ? `https://site${i}.example.com` : null,
  })),
};
const events = Array.from({ length: 300 }, (_, i) => JSON.stringify({ ts: new Date(2026, 8, 1, 0, i * 7).toISOString(), level: pick(['info', 'info', 'info', 'warn', 'error']), service: pick(['api', 'worker', 'web']), latency_ms: Math.round(20 + rnd() * 900), user: 1 + Math.floor(rnd() * 120) })).join('\n') + '\n';

for (const dir of ['samples', 'standalone/samples']) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/sales.csv`, csv);
  fs.writeFileSync(`${dir}/inventory.xlsx`, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  fs.writeFileSync(`${dir}/users.json`, JSON.stringify(users, null, 2) + '\n');
  fs.writeFileSync(`${dir}/events.jsonl`, events);
}
console.log('samples written');
