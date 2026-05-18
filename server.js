require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const efi = require('./efi');

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS manual — funciona sempre
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-webhook-secret,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const pedidos = {};

app.post('/pix/criar', async (req, res) => {
  try {
    const { orderId, valor, produto, userId, robloxNick } = req.body;
    if (!orderId || !valor || !produto) return res.status(400).json({ erro: 'Campos obrigatorios: orderId, valor, produto' });
    const cob = await efi.criarCobranca({ valor: parseFloat(valor).toFixed(2), orderId, desc: `Kynox Buxx - ${produto}` });
    const qr  = await efi.gerarQRCode(cob.loc.id);
    pedidos[orderId] = { orderId, txid: cob.txid, locId: cob.loc.id, valor, produto, userId: userId||'guest', robloxNick: robloxNick||'', status: 'pendente', criadoEm: new Date().toISOString() };
    console.log(`[PIX] Criado: ${orderId} | R$${valor}`);
    return res.json({ ok: true, orderId, txid: cob.txid, qrcode: qr.qrcode, qrcodeImg: qr.imagemQrcode, expiracao: 3600 });
  } catch (err) {
    console.error('[PIX] Erro:', err?.response?.data || err.message);
    return res.status(500).json({ erro: 'Erro ao gerar PIX.' });
  }
});

app.get('/pix/status/:orderId', async (req, res) => {
  const pedido = pedidos[req.params.orderId];
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado' });
  if (pedido.status === 'pago') return res.json({ status: 'pago', orderId: req.params.orderId });
  try {
    const cob = await efi.consultarCobranca(pedido.txid);
    if (cob.status === 'CONCLUIDA') {
      pedido.status = 'pago';
      pedido.pagoEm = new Date().toISOString();
      return res.json({ status: 'pago', orderId: req.params.orderId });
    }
    return res.json({ status: pedido.status, cobranca: cob.status });
  } catch (err) {
    return res.json({ status: pedido.status });
  }
});

app.post('/pix/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const { pix } = req.body;
    if (!pix || !Array.isArray(pix)) return;
    pix.forEach(p => {
      if (!p.txid) return;
      const entry = Object.values(pedidos).find(x => x.txid === p.txid);
      if (!entry || entry.status === 'pago') return;
      entry.status = 'pago';
      entry.pagoEm = p.horario || new Date().toISOString();
      console.log(`[WEBHOOK] Pago: ${entry.orderId} | R$${p.valor}`);
    });
  } catch (err) { console.error('[WEBHOOK]', err.message); }
});

app.get('/pix/webhook', (req, res) => res.sendStatus(200));

app.post('/pix/registrar-webhook', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) return res.status(401).json({ erro: 'Nao autorizado' });
  try {
    await efi.registrarWebhook(`${process.env.SITE_URL}/pix/webhook`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/pix/pedidos', (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) return res.status(401).json({ erro: 'Nao autorizado' });
  return res.json(Object.values(pedidos));
});

app.get('/', (req, res) => res.json({ ok: true, servico: 'Kynox Buxx PIX', versao: '2.0.0' }));

app.listen(PORT, () => {
  console.log(`Kynox Buxx Backend porta ${PORT} | ${process.env.EFI_SANDBOX==='true'?'SANDBOX':'PRODUCAO'}`);
});
