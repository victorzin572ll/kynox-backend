// efi.js — Módulo de integração com a API Efí Bank (Gerencianet)
const axios  = require('axios');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
require('dotenv').config();

const BASE_URL = process.env.EFI_SANDBOX === 'true'
  ? 'https://pix-h.api.efipay.com.br'
  : 'https://pix.api.efipay.com.br';

let _token    = null;
let _tokenExp = 0;

function getAgent() {
  let certData;
  if (process.env.EFI_CERT_BASE64) {
    certData = Buffer.from(process.env.EFI_CERT_BASE64, 'base64');
  } else {
    const certPath = path.resolve(process.env.EFI_CERT_PATH || './certs/producao-873607-kynox.p12');
    certData = fs.readFileSync(certPath);
  }
  return new https.Agent({ pfx: certData, passphrase: '', rejectUnauthorized: false });
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const credentials = Buffer.from(`${process.env.EFI_CLIENT_ID}:${process.env.EFI_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(`${BASE_URL}/oauth/token`, { grant_type: 'client_credentials' }, {
    httpsAgent: getAgent(),
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
  });
  _token    = res.data.access_token;
  _tokenExp = Date.now() + (res.data.expires_in - 60) * 1000;
  return _token;
}

async function api() {
  const token = await getToken();
  return axios.create({
    baseURL: BASE_URL,
    httpsAgent: getAgent(),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

// ── Criar cobrança PIX ──────────────────────────────────────────
async function criarCobranca({ valor, orderId, desc }) {
  const client = await api();

  // txid: só letras e números, 26-35 chars
  const txid = orderId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 35);

  const body = {
    calendario: { expiracao: 3600 },
    // CORRIGIDO: devedor removido — sem CPF não pode ter devedor
    valor: { original: parseFloat(valor).toFixed(2) },
    chave: process.env.EFI_PIX_KEY,
    solicitacaoPagador: desc || 'Kynox Buxx',
    infoAdicionais: [
      { nome: 'Pedido', valor: orderId },
    ],
  };

  const res = await client.put(`/v2/cob/${txid}`, body);
  return res.data;
}

async function gerarQRCode(locId) {
  const client = await api();
  const res = await client.get(`/v2/loc/${locId}/qrcode`);
  return res.data;
}

async function consultarCobranca(txid) {
  const client = await api();
  const res = await client.get(`/v2/cob/${txid}`);
  return res.data;
}

async function registrarWebhook(webhookUrl) {
  const client = await api();
  await client.put(`/v2/webhook/${process.env.EFI_PIX_KEY}`, { webhookUrl });
  console.log('Webhook registrado:', webhookUrl);
}

module.exports = { criarCobranca, gerarQRCode, consultarCobranca, registrarWebhook, getToken };
