// server.js — Backend Kynox Buxx PIX v2.5
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const efi     = require('./efi');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','OPTIONS'], allowedHeaders: ['Content-Type','x-webhook-secret','Authorization'] }));
app.options('*', cors());
app.use(express.json());

const pedidos = {};

// Gera orderId válido para EFI: só letras+números, 26-35 chars
function gerarOrderId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'KB';
  for (let i = 0; i < 28; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id; // 30 chars exatos, sempre válido
}

// ═══════════════════════════════════════════════════════════════
// GET /roblox/search?q=nick
// ═══════════════════════════════════════════════════════════════
app.get('/roblox/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ data: [] });
  try {
    const searchResp = await fetchJson('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      body: JSON.stringify({ usernames: [q], excludeBannedUsers: true }),
    });
    const suggestResp = await fetchJson(
      `https://www.roblox.com/search/users/results?keyword=${encodeURIComponent(q)}&maxRows=4&startIndex=0`
    ).catch(() => ({ UserSearchResults: [] }));

    const ids = new Set();
    const users = [];
    (suggestResp.UserSearchResults || []).slice(0, 4).forEach(u => {
      if (!ids.has(u.UserId)) { ids.add(u.UserId); users.push({ id: u.UserId, name: u.Name, displayName: u.DisplayName || u.Name }); }
    });
    (searchResp.data || []).forEach(u => {
      if (!ids.has(u.id)) { ids.add(u.id); users.push({ id: u.id, name: u.name, displayName: u.displayName || u.name }); }
    });
    if (!users.length) return res.json({ data: [] });

    const idList = users.map(u => u.id).join(',');
    const thumbResp = await fetchJson(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${idList}&size=150x150&format=Png&isCircular=false`
    ).catch(() => ({ data: [] }));
    const avatarMap = {};
    (thumbResp.data || []).forEach(t => { avatarMap[t.targetId] = t.imageUrl; });
    return res.json({ data: users.map(u => ({ id: u.id, name: u.name, displayName: u.displayName, avatar: avatarMap[u.id] || null })) });
  } catch (err) {
    console.error('[ROBLOX SEARCH]', err.message);
    return res.json({ data: [] });
  }
});

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}) },
    };
    const req = https.request(options, resp => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('JSON parse error')); } });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// POST /pix/criar
// ═══════════════════════════════════════════════════════════════
app.post('/pix/criar', async (req, res) => {
  try {
    const { orderId: orderIdFront, valor, produto, userId, robloxNick } = req.body;

    if (!orderIdFront || !valor || !produto) {
      return res.status(400).json({ erro: 'Campos obrigatórios: orderId, valor, produto' });
    }

    const valorNum = parseFloat(String(valor).replace(',', '.'));
    if (isNaN(valorNum) || valorNum <= 0) {
      return res.status(400).json({ erro: 'Valor inválido' });
    }

    // CORREÇÃO: gerar orderId novo com 30 chars válidos para a EFI
    // O orderId do frontend (ex: KBMPOPVQWI4GPJ) tem só 14 chars — inválido para EFI
    const orderId = gerarOrderId();

    console.log(`[PIX] Criando: orderId=${orderId} (front=${orderIdFront}) valor=${valorNum.toFixed(2)}`);

    const cob = await efi.criarCobranca({
      valor:   valorNum.toFixed(2),
      orderId: orderId,
      desc:    `Kynox Buxx - ${produto}`,
    });

    const qr = await efi.gerarQRCode(cob.loc.id);

    // Salva com o orderId original do front para o polling funcionar
    pedidos[orderIdFront] = {
      orderId:    orderIdFront,
      txid:       cob.txid || orderId,
      locId:      cob.loc.id,
      valor:      valorNum.toFixed(2),
      produto,
      userId:     userId || 'guest',
      robloxNick: robloxNick || '',
      status:     'pendente',
      criadoEm:   new Date().toISOString(),
    };

    console.log(`[PIX] ✓ Criada! orderId=${orderIdFront} txid=${cob.txid} R$${valorNum.toFixed(2)}`);

    return res.json({
      ok:        true,
      orderId:   orderIdFront,
      txid:      cob.txid || orderId,
      qrcode:    qr.qrcode,
      qrcodeImg: qr.imagemQrcode,
      expiracao: 3600,
    });

  } catch (err) {
    const errDetail = err?.response?.data || err?.data || err?.message || String(err);
    console.error('[PIX] Erro detalhado:', JSON.stringify(errDetail));
    return res.status(500).json({ erro: 'Erro ao gerar PIX. Tente novamente.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /pix/status/:orderId
// ═══════════════════════════════════════════════════════════════
app.get('/pix/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const pedido = pedidos[orderId];
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  if (pedido.status === 'pago') return res.json({ status: 'pago', orderId });
  try {
    const cob = await efi.consultarCobranca(pedido.txid);
    if (cob.status === 'CONCLUIDA') {
      pedidos[orderId].status = 'pago';
      pedidos[orderId].pagoEm = new Date().toISOString();
      return res.json({ status: 'pago', orderId });
    }
    return res.json({ status: pedido.status, cobranca: cob.status });
  } catch (err) {
    return res.json({ status: pedido.status });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /pix/webhook
// ═══════════════════════════════════════════════════════════════
app.post('/pix/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const { pix } = req.body;
    if (!pix || !Array.isArray(pix)) return;
    pix.forEach(({ txid, valor, horario }) => {
      if (!txid) return;
      const entry = Object.values(pedidos).find(p => p.txid === txid);
      if (!entry || entry.status === 'pago') return;
      entry.status = 'pago';
      entry.pagoEm = horario || new Date().toISOString();
      entry.valorPago = valor;
      console.log(`[WEBHOOK] ✓ Pago: ${entry.orderId} R$${valor}`);
    });
  } catch (err) {
    console.error('[WEBHOOK] Erro:', err.message);
  }
});

app.get('/pix/webhook', (req, res) => res.sendStatus(200));

app.post('/pix/registrar-webhook', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    await efi.registrarWebhook(`${process.env.SITE_URL}/pix/webhook`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/pix/pedidos', (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET)
    return res.status(401).json({ erro: 'Não autorizado' });
  return res.json(Object.values(pedidos));
});

app.get('/', (req, res) => res.json({ ok: true, servico: 'Kynox Buxx PIX', versao: '2.5.0' }));

app.listen(PORT, () => {
  console.log(`\n🚀 Kynox Buxx Backend rodando na porta ${PORT}`);
  console.log(`   PIX Key: ${process.env.EFI_PIX_KEY}`);
  console.log(`   Modo: ${process.env.EFI_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUÇÃO'}\n`);
});
