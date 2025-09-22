// Vercel Serverless Function: POST /api/asaas-webhook?token=...
const axios = require('axios');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
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
    REFUNDED: 'Cancelado'
  };
  return map[asaasStatus] || 'Em aberto';
};

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const token = req.query.token || req.headers['x-webhook-token'];
    if (token !== process.env.WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }

    const event = req.body || {};
    const paymentId = event?.payment?.id;

    if (!paymentId) {
      console.log('Webhook recebido sem payment.id:', JSON.stringify(event));
      return res.json({ ok: true });
    }

    // Confirma o status diretamente no Asaas
    const asaas = await axios.get(`https://api.asaas.com/v3/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.ASAAS_API_KEY}` }
    });

    const asaasStatus = asaas.data?.status || 'PENDING';
    const statusApp = mapAsaasToApp(asaasStatus);

    // Atualiza o doc de faturamento com este asaasPaymentId
    const snap = await db.collection('faturamento')
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
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, status: statusApp });
  } catch (err) {
    console.error('Erro no webhook:', err?.response?.data || err.message);
    return res.status(500).json({ ok: false });
  }
};
