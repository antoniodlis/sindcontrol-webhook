// /api/asaas-webhook.js
const axios = require('axios');
const admin = require('firebase-admin');

/**
 * Inicializa o Firebase Admin usando UMA variável com o JSON completo
 * da conta de serviço, para evitar problemas de quebra de linha no private key.
 */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/** Mapeia status do Asaas -> status do seu app */
const mapAsaasToApp = (asaasStatus) => {
  const map = {
    PENDING: 'Em aberto',
    AWAITING_PAYMENT: 'Em aberto',
    RECEIVED: 'Quitados',
    CONFIRMED: 'Quitados',
    OVERDUE: 'Em atraso',
    EXPIRED: 'Expirado',
    CANCELLED: 'Cancelado',
    REFUNDED: 'Cancelado',
  };
  return map[asaasStatus] || 'Em aberto';
};

module.exports = async (req, res) => {
  try {
    // Apenas POST
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    // Validação do token do webhook
    const token = req.query.token || req.headers['x-webhook-token'];
    if (token !== process.env.WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }

    // Evento do Asaas
    const event = req.body || {};
    const paymentId = event?.payment?.id;

    // Se não veio paymentId, aceite silenciosamente (sanidade)
    if (!paymentId) {
      console.log('Webhook recebido sem payment.id:', JSON.stringify(event));
      return res.json({ ok: true, message: 'no_payment_id' });
    }

    // Confere status no Asaas
    const r = await axios.get(`https://api.asaas.com/v3/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.ASAAS_API_KEY}` },
      timeout: 15000,
    });

    const asaasStatus = r.data?.status || 'PENDING';
    const statusApp = mapAsaasToApp(asaasStatus);

    // Atualiza o doc com este asaasPaymentId
    const snap = await db
      .collection('faturamento')
      .where('asaasPaymentId', '==', paymentId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`Nenhum documento com asaasPaymentId=${paymentId}`);
      return res.json({ ok: true, message: 'no_doc_found' });
    }

    const ref = snap.docs[0].ref;
    await ref.update({
      status: statusApp,
      asaasRawStatus: asaasStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, status: statusApp });
  } catch (err) {
    // PATCH: loga a causa real no response e no console da Vercel
    const info = {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    };
    console.error('WEBHOOK_ERROR', info);
    return res.status(500).json({ ok: false, error: info });
  }
};
