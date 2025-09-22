// api/asaas-webhook.js
const axios = require('axios');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

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
    // GET para ver se a rota está viva no navegador
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, route: 'asaas-webhook' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    // segurança do webhook
    const token = req.query.token || req.headers['x-webhook-token'];
    if (!token || token !== process.env.WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }

    // corpo do Asaas pode vir como string
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const paymentId = body?.payment?.id;

    if (!paymentId) {
      console.log('Webhook sem payment.id', body);
      return res.json({ ok: true, message: 'no_payment_id' });
    }

    // confirma status "real" no Asaas
    const { data } = await axios.get(`https://api.asaas.com/v3/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.ASAAS_API_KEY}` }
    });

    const asaasStatus = data?.status || 'PENDING';
    const statusApp = mapAsaasToApp(asaasStatus);

    // atualiza o doc do seu sistema
    const snap = await db.collection('faturamento')
      .where('asaasPaymentId', '==', paymentId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`Documento não encontrado para asaasPaymentId=${paymentId}`);
      return res.json({ ok: true, message: 'no_doc_found' });
    }

    await snap.docs[0].ref.update({
      status: statusApp,
      asaasRawStatus: asaasStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, status: statusApp, asaasStatus });
  } catch (e) {
    console.error('Webhook error', e?.response?.data || e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
};
