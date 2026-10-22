// Função serverless (Vercel): lê print do app de monitoramento ou foto/PDF da conta de luz com IA.
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  (obrigatória)  chave da API da Anthropic
//   ALLOWED_EMAILS     (opcional)     e-mails autorizados, separados por vírgula
//   ANTHROPIC_MODEL    (opcional)     modelo a usar (padrão abaixo)

const FIREBASE_API_KEY = 'AIzaSyA6oseIiOfGJ9IUwiGzdtUgRVC6kY6q2R8';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

const PROMPTS = {
  geracao: `A imagem é um print de um aplicativo de monitoramento de energia solar (Solarman, Deye Cloud, Growatt, FusionSolar, iSolarCloud, SEMS, Hoymiles, SolarEdge ou similar).
Identifique qual visão está aberta e extraia a geração de energia solar (produção), não o consumo.
Responda SOMENTE com um JSON, sem texto em volta, neste formato:
{"periodo": "dia" | "mes" | "ano" | "total" | "outro",
 "referencia": "AAAA-MM" ou null (o mês exibido, se a visão for de mês),
 "geracao_kwh": número ou null (total de geração do período exibido, em kWh; converta MWh para kWh),
 "meses": [{"mes": "AAAA-MM", "kwh": número}] (só se a visão for anual e os valores de cada mês estiverem legíveis como números; senão lista vazia),
 "aviso": texto curto em português ou null (ex.: dúvida sobre o número, unidade ambígua)}
Não invente números: se não estiver legível, use null.`,
  conta: `A imagem/documento é uma conta de energia elétrica de uma distribuidora brasileira, de um cliente com geração distribuída (energia solar).
Extraia os dados e responda SOMENTE com um JSON, sem texto em volta, neste formato:
{"mes_referencia": "AAAA-MM" ou null (mês de referência da conta),
 "leitura_anterior": "AAAA-MM-DD" ou null (data da leitura anterior do medidor),
 "leitura_atual": "AAAA-MM-DD" ou null (data da leitura atual do medidor),
 "valor_total": número ou null (total a pagar, em R$),
 "consumo_rede_kwh": número ou null (energia ativa consumida/fornecida pela rede no período, em kWh; é o consumo medido, não o faturado após compensação),
 "energia_injetada_kwh": número ou null (energia injetada na rede pelo sistema solar no período, em kWh; não confundir com saldo de créditos acumulados),
 "tarifa_kwh": número ou null (preço unitário com tributos do consumo em R$/kWh, somando TE e TUSD se vierem separados; null se não estiver claro),
 "aviso": texto curto em português ou null (ex.: campo ambíguo, conta de outro titular, valores de mais de um posto tarifário)}
Não invente números: se não estiver legível ou não existir, use null.`
};

async function verifyUser(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.users && j.users[0]) || null;
}

function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('Resposta da IA sem JSON');
  return JSON.parse(text.slice(s, e + 1));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const user = token ? await verifyUser(token) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'Não autorizado. Entre de novo no sistema.' });
    const allowed = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(user.email || '').toLowerCase())) {
      return res.status(403).json({ ok: false, error: 'Usuário sem permissão para leitura com IA.' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'Chave da IA não configurada na Vercel (ANTHROPIC_API_KEY).' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { kind, mediaType, data } = body;
    if (!PROMPTS[kind]) return res.status(400).json({ ok: false, error: 'Tipo de leitura inválido.' });
    if (!data || !mediaType) return res.status(400).json({ ok: false, error: 'Arquivo não enviado.' });
    const isPdf = mediaType === 'application/pdf';
    if (!isPdf && !/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
      return res.status(400).json({ ok: false, error: 'Formato não suportado.' });
    }

    const fileBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: PROMPTS[kind] }] }]
      })
    });
    const j = await r.json();
    if (!r.ok) {
      console.error('Anthropic error', r.status, j);
      const msg = (j && j.error && j.error.message) || ('Erro ' + r.status);
      return res.status(502).json({ ok: false, error: 'Falha na IA: ' + msg });
    }
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const parsed = extractJson(text);
    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Não foi possível ler a imagem. Tente de novo.' });
  }
};
