// api/asaas-webhook.js
const axios = require('axios');
const admin = require('firebase-admin');

// Inicializa o Firebase Admin uma única vez
if (!admin.apps.length) {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // a chave deve estar numa linha com \n; aqui convertemos para quebras reais
      privateKey: FIREBASE_PRIVATE_KEY
        ? FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        : undefined,
    }),
  });
}

const db = admin.firestore();

// Mapeia status do Asaas -> status do Sindcontrol
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
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    // valida o token passado na URL (?token=...) ou no header
    const token = req.query.token || req.headers['x-webhook-token'];
    if (token !== process.env.WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }

    // garante que temos um objeto (às vezes pode vir string)
    const event = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const paymentId = event?.payment?.id;

    // permite "ping" de sanidade sem payment.id
    if (!paymentId) {
      console.log('Webhook sem payment.id:', JSON.stringify(event));
      return res.json({ ok: true, message: 'no_payment_id' });
    }

    // confirma status direto no Asaas
    const asaasResp = await axios.get(
      `https://api.asaas.com/v3/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${process.env.ASAAS_API_KEY}` } }
    );

    const asaasStatus = asaasResp?.data?.status || 'PENDING';
    const statusApp = mapAsaasToApp(asaasStatus);

    // localiza o doc do faturamento com esse asaasPaymentId
    const snap = await db
      .collection('faturamento')
      .where('asaasPaymentId', '==', paymentId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`Nenhum doc faturamento com asaasPaymentId=${paymentId}`);
      return res.json({ ok: true, message: 'no_doc_found', asaasStatus, statusApp });
    }

    // atualiza o documento
    await snap.docs[0].ref.update({
      status: statusApp,
      asaasRawStatus: asaasStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, asaasStatus, status: statusApp });
  } catch (err) {
    // <<< PATCH para mostrar o erro real >>>
    const info = {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    };
    console.error('WEBHOOK_ERROR', info);
    return res.status(500).json({ ok: false, error: info });
  }
};
