require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-webhook-secret,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Persistência em arquivo (sobrevive reinicialização) ──────────
const PEDIDOS_FILE = '/tmp/pedidos.json';
function loadPedidos() {
  try { return JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function savePedidos(pedidos) {
  try { fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos)); }
  catch(e) { console.error('Erro ao salvar pedidos:', e.message); }
}
let pedidos = loadPedidos();

// ── Efí ──────────────────────────────────────────────────────────
const BASE_URL = 'https://pix.api.efipay.com.br';
let _token = null, _tokenExp = 0;

function getAgent() {
  const certData = process.env.EFI_CERT_BASE64
    ? Buffer.from(process.env.EFI_CERT_BASE64, 'base64')
    : fs.readFileSync(path.resolve('./certs/producao-873607-kynox.p12'));
  return new https.Agent({ pfx: certData, passphrase: '', rejectUnauthorized: false });
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const creds = Buffer.from(`${process.env.EFI_CLIENT_ID}:${process.env.EFI_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(`${BASE_URL}/oauth/token`, { grant_type: 'client_credentials' }, {
    httpsAgent: getAgent(), headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' }
  });
  _token = res.data.access_token;
  _tokenExp = Date.now() + (res.data.expires_in - 60) * 1000;
  return _token;
}

async function efiApi() {
  const token = await getToken();
  return axios.create({ baseURL: BASE_URL, httpsAgent: getAgent(), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

function gerarTxid() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 35; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

// ── Health ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, servico: 'Kynox Buxx PIX', versao: '5.0.0' }));

// ── POST /pix/criar ──────────────────────────────────────────────
app.post('/pix/criar', async (req, res) => {
  try {
    const { orderId, valor, produto, userId, robloxNick } = req.body;
    if (!orderId || !valor || !produto) return res.status(400).json({ erro: 'orderId, valor e produto sao obrigatorios' });

    const txid   = gerarTxid();
    const client = await efiApi();

    const cob = await client.put(`/v2/cob/${txid}`, {
      calendario: { expiracao: 3600 },
      valor: { original: parseFloat(valor).toFixed(2) },
      chave: process.env.EFI_PIX_KEY,
      solicitacaoPagador: `Kynox Buxx - ${produto}`,
    });

    const qr = await client.get(`/v2/loc/${cob.data.loc.id}/qrcode`);

    pedidos[orderId] = { orderId, txid, valor, produto, userId: userId||'guest', robloxNick: robloxNick||'', status: 'pendente', criadoEm: new Date().toISOString() };
    savePedidos(pedidos);

    console.log(`[PIX] Criado: ${orderId} | R$${valor} | ${produto}`);
    return res.json({ ok: true, orderId, txid, qrcode: qr.data.qrcode, qrcodeImg: qr.data.imagemQrcode, expiracao: 3600 });
  } catch (err) {
    console.error('[PIX] Erro:', JSON.stringify(err?.response?.data) || err.message);
    return res.status(500).json({ erro: 'Erro ao gerar PIX.' });
  }
});

// ── GET /pix/status/:orderId ─────────────────────────────────────
app.get('/pix/status/:orderId', async (req, res) => {
  pedidos = loadPedidos(); // recarrega sempre
  const pedido = pedidos[req.params.orderId];
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado' });
  if (pedido.status === 'pago') return res.json({ status: 'pago', orderId: req.params.orderId });

  // Consulta ativa na Efí para garantir
  try {
    const client = await efiApi();
    const cob    = await client.get(`/v2/cob/${pedido.txid}`);
    if (cob.data.status === 'CONCLUIDA') {
      pedidos[req.params.orderId].status = 'pago';
      pedidos[req.params.orderId].pagoEm = new Date().toISOString();
      savePedidos(pedidos);
      console.log(`[STATUS] Pago confirmado: ${req.params.orderId}`);
      return res.json({ status: 'pago', orderId: req.params.orderId });
    }
    return res.json({ status: pedido.status, cobranca: cob.data.status });
  } catch (err) {
    return res.json({ status: pedido.status });
  }
});

// ── POST /pix/webhook ────────────────────────────────────────────
app.post('/pix/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    pedidos = loadPedidos();
    const { pix } = req.body;
    if (!pix || !Array.isArray(pix)) return;
    let changed = false;
    pix.forEach(p => {
      if (!p.txid) return;
      const entry = Object.values(pedidos).find(x => x.txid === p.txid);
      if (!entry || entry.status === 'pago') return;
      entry.status = 'pago';
      entry.pagoEm = p.horario || new Date().toISOString();
      entry.valorPago = p.valor;
      changed = true;
      console.log(`[WEBHOOK] ✓ Pago: ${entry.orderId} | R$${p.valor}`);
    });
    if (changed) savePedidos(pedidos);
  } catch (err) { console.error('[WEBHOOK]', err.message); }
});

app.get('/pix/webhook', (req, res) => res.sendStatus(200));

// ── POST /pix/registrar-webhook ──────────────────────────────────
app.post('/pix/registrar-webhook', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) return res.status(401).json({ erro: 'Nao autorizado' });
  try {
    const client     = await efiApi();
    const webhookUrl = `https://kynox-backend-production.up.railway.app/pix/webhook`;
    await client.put(`/v2/webhook/${process.env.EFI_PIX_KEY}`, { webhookUrl });
    console.log(`[WEBHOOK] Registrado: ${webhookUrl}`);
    return res.json({ ok: true, webhookUrl });
  } catch (err) {
    console.error('[WEBHOOK] Erro:', err?.response?.data || err.message);
    return res.status(500).json({ erro: err.message });
  }
});

// ── GET /pix/pedidos ─────────────────────────────────────────────
app.get('/pix/pedidos', (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) return res.status(401).json({ erro: 'Nao autorizado' });
  pedidos = loadPedidos();
  return res.json(Object.values(pedidos));
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Kynox Buxx PIX v5.0.0 | porta ${PORT} | PRODUCAO`);

  // Registrar webhook automaticamente
  try {
    const client     = await efiApi();
    const webhookUrl = `https://kynox-backend-production.up.railway.app/pix/webhook`;
    await client.put(`/v2/webhook/${process.env.EFI_PIX_KEY}`, { webhookUrl });
    console.log(`[WEBHOOK] ✓ Registrado: ${webhookUrl}`);
  } catch(e) {
    console.log(`[WEBHOOK] Aviso: ${e?.response?.data?.mensagem || e.message}`);
  }
});
