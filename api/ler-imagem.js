// Função serverless (Vercel): lê print do app de monitoramento, arquivo exportado do app ou foto/PDF da conta de luz com IA.
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  (obrigatória)  chave da API da Anthropic
//   ALLOWED_EMAILS     (opcional)     e-mails autorizados, separados por vírgula
//   ANTHROPIC_MODEL    (opcional)     modelo a usar (padrão abaixo)

const FIREBASE_API_KEY = 'AIzaSyA6oseIiOfGJ9IUwiGzdtUgRVC6kY6q2R8';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

const PROMPTS = {
  geracao: `A imagem é um print de um aplicativo de monitoramento de energia solar (Solarman, Deye Cloud, Growatt, FusionSolar, iSolarCloud, SEMS, Hoymiles, SolarEdge ou similar), normalmente na visão "Mês", com um gráfico de barras de geração por dia.
Extraia a geração de energia solar (produção), não o consumo.
Responda SOMENTE com um JSON, sem texto em volta, neste formato:
{"periodo": "dia" | "mes" | "ano" | "total" | "outro",
 "referencia": "AAAA-MM" ou null (o mês exibido),
 "total_topo_kwh": número ou null (o total do período mostrado no topo/cartão do print, em kWh; converta MWh para kWh),
 "diarios": [{"dia": número do dia, "kwh": número}] (o valor de CADA barra diária do gráfico, em ordem, um item por dia que tenha barra; estime pela escala do eixo quando o número não estiver escrito; dia sem barra = 0; dias futuros sem dado não entram),
 "valores_estimados_pela_altura": true | false (true se os valores diários foram estimados pela altura das barras e não lidos como números),
 "aviso": texto curto em português ou null}
Não invente totais: se não estiver legível, use null.`,
  exportacao: `O texto abaixo é o conteúdo de um arquivo exportado de um aplicativo de monitoramento de energia solar (ex.: Solarman), em formato de planilha/CSV.
Identifique a coluna de data/dia e a coluna de geração/produção de energia por dia (em kWh; converta Wh/MWh se necessário). Ignore colunas de consumo, rede, bateria.
Responda SOMENTE com um JSON, sem texto em volta:
{"referencia": "AAAA-MM" ou null (o mês dos dados; se houver mais de um mês, o mês com mais dias),
 "diarios": [{"data": "AAAA-MM-DD", "kwh": número}] (uma linha por dia presente no arquivo),
 "total_kwh": número ou null (total informado no arquivo, se existir),
 "aviso": texto curto em português ou null}`,
  conta: `A imagem/documento é uma conta de energia elétrica de uma distribuidora brasileira (ex.: CPFL, Elektro, Enel), de um cliente com geração distribuída (energia solar).
Extraia os dados e responda SOMENTE com um JSON, sem texto em volta, neste formato (números com ponto decimal; valores em R$ positivos salvo indicação):
{"titular": texto ou null,
 "cidade": texto ou null (cidade do endereço da unidade consumidora),
 "mes_referencia": "AAAA-MM" ou null,
 "leitura_anterior": "AAAA-MM-DD" ou null (data da leitura anterior do medidor),
 "leitura_atual": "AAAA-MM-DD" ou null (data da leitura atual do medidor),
 "tipo_ligacao": "monofasico" | "bifasico" | "trifasico" | null,
 "valor_total": número ou null (total a pagar),
 "total_distribuidora": número ou null (linha "Total Distribuidora" ou subtotal equivalente dos itens da distribuidora),
 "consumo_rede_kwh": número ou null (energia ativa consumida/fornecida pela rede no período, medida),
 "energia_injetada_kwh": número ou null (energia injetada na rede no período, medida; não confundir com saldo),
 "tarifa_tusd_com_tributos": número ou null (R$/kWh, coluna "Tarifa com tributos" da linha de consumo TUSD),
 "tarifa_te_com_tributos": número ou null (R$/kWh, coluna "Tarifa com tributos" da linha de consumo TE),
 "tarifa_tusd_compensada_com_tributos": número ou null (R$/kWh, tarifa com tributos da linha "Energia Ativa Injetada TUSD"),
 "kwh_compensados": número ou null (quantidade nas linhas "Energia Ativa Injetada" TUSD/TE; use a da TUSD se diferirem),
 "valor_compensado": número ou null (soma, em valor POSITIVO, dos valores negativos de energia injetada TUSD e TE e do crédito de bandeira),
 "bandeira_valor": número ou null (valor cobrado de adicional de bandeira tarifária; 0 se bandeira verde/sem cobrança),
 "multa_juros_atualizacao": número ou null (soma de multa, juros de mora e atualização monetária; 0 se não houver),
 "iluminacao_publica": número ou null (CIP / COSIP / contribuição de iluminação pública),
 "ajustes": número ou null (soma de ajustes e créditos avulsos como "Ajuste Saldo", devolução, crédito diverso; NEGATIVO se for crédito/desconto, POSITIVO se for cobrança; 0 se não houver),
 "debitos_em_aberto": [{"data": "AAAA-MM-DD" ou texto, "valor": número}] (quadro de débitos anteriores/mais antigos não pagos; lista vazia se não houver),
 "saldo_creditos_kwh": número ou null (saldo de créditos de energia informado pela distribuidora),
 "aviso": texto curto em português ou null (campos ambíguos, conta de outro titular, mais de um posto tarifário)}
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
    const { kind, mediaType, data, text } = body;
    if (!PROMPTS[kind]) return res.status(400).json({ ok: false, error: 'Tipo de leitura inválido.' });

    let content;
    if (kind === 'exportacao') {
      if (!text || typeof text !== 'string') return res.status(400).json({ ok: false, error: 'Arquivo vazio.' });
      content = [{ type: 'text', text: PROMPTS.exportacao + '\n\n--- CONTEÚDO DO ARQUIVO ---\n' + text.slice(0, 60000) }];
    } else {
      if (!data || !mediaType) return res.status(400).json({ ok: false, error: 'Arquivo não enviado.' });
      const isPdf = mediaType === 'application/pdf';
      if (!isPdf && !/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
        return res.status(400).json({ ok: false, error: 'Formato não suportado.' });
      }
      const fileBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      content = [fileBlock, { type: 'text', text: PROMPTS[kind] }];
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 3000,
        messages: [{ role: 'user', content }]
      })
    });
    const j = await r.json();
    if (!r.ok) {
      console.error('Anthropic error', r.status, j);
      const msg = (j && j.error && j.error.message) || ('Erro ' + r.status);
      return res.status(502).json({ ok: false, error: 'Falha na IA: ' + msg });
    }
    const out = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const parsed = extractJson(out);
    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Não foi possível ler o arquivo. Tente de novo.' });
  }
};
