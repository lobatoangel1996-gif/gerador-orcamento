// Função serverless (Vercel): cotação em 3 níveis (string, micro, híbrido) nas distribuidoras.
// Hoje consulta a Fortlev. A Belenus entra na próxima etapa; a AVT entra pelo favorito "Cotar AVT".
// Variáveis de ambiente (Vercel → Settings → Environment Variables, Production e Preview):
//   FORTLEV_USUARIO, FORTLEV_SENHA   (obrigatórias para a Fortlev)
//   FORTLEV_PARTNER_ID               (opcional) id do integrador na Fortlev
//   FORTLEV_FASE_MONO220             (opcional) código de fase "monofásico 220 V" no portal (padrão 3)
//   ALLOWED_EMAILS                   (opcional) e-mails autorizados, separados por vírgula

const FIREBASE_API_KEY = 'AIzaSyA6oseIiOfGJ9IUwiGzdtUgRVC6kY6q2R8';
const FORTLEV = 'https://fortlevsolar.app';
const FORTLEV_PARTNER_DEFAULT = '690b41ac0ce65f69d6a9924e';

// Tipos de telhado da Fortlev (id do portal). A chave é o que o gerador envia.
const FORTLEV_SURFACES = {
  ceramico: '69a7489fdc52587ed265ba18',
  fibrocimento_madeira: '69a74981dc52587ed265ba1b',
  fibrocimento_madeira_300: '69a749dcdc52587ed265ba1c',
  fibrocimento_metal: '69a74a0edc52587ed265ba1d',
  metalico_minitrilho: '69a74aaedc52587ed265ba21',
  metalico_perfil: '69a74ae2dc52587ed265ba22',
  zipado: '69a74a7fdc52587ed265ba20',
  shingle: '66950560cd3f8e5b21aede6f',
  laje: '69a74a5fdc52587ed265ba1f',
  laje_lastro: '6a47c0aadfe17b7e9efc1b89',
  solo_lastro: '66950a12cd3f8e5b21aede72',
  solo_metalico: '66950bbacd3f8e5b21aede73'
};

// Fabricantes de módulo considerados Tier 1 (conferir periodicamente na lista BloombergNEF).
const TIER1 = /JINKO|JA ?SOLAR|LONGI|TRINA|CANADIAN|ASTRONERGY|RISEN|TONGWEI|ZNSHINE|AIKO|TCL|HUASUN|DAS SOLAR|BYD|DMEGC|SERAPHIM/i;

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

function readSetCookies(r) {
  if (typeof r.headers.getSetCookie === 'function') return r.headers.getSetCookie();
  const raw = r.headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[A-Za-z0-9_]+=)/) : [];
}

// ---------- Fortlev ----------

async function fortlevLogin() {
  const user = process.env.FORTLEV_USUARIO, pass = process.env.FORTLEV_SENHA;
  if (!user || !pass) throw new Error('Login da Fortlev não configurado na Vercel (FORTLEV_USUARIO / FORTLEV_SENHA).');
  const r = await fetch(`${FORTLEV}/login-action`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'HX-Request': 'true',
      'Origin': FORTLEV,
      'Referer': `${FORTLEV}/login`
    },
    body: new URLSearchParams({ username: user, password: pass }).toString()
  });
  const cookies = readSetCookies(r);
  const tokenCookie = cookies.map(c => c.split(';')[0]).find(c => c.startsWith('accessToken0='));
  if (!tokenCookie) throw new Error(`Fortlev recusou o login (status ${r.status}). Confira usuário e senha na Vercel.`);
  return decodeURIComponent(tokenCookie.slice('accessToken0='.length));
}

async function fortlevGet(token, path) {
  const r = await fetch(`${FORTLEV}/api/partner/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Fortlev respondeu ${r.status} em ${path.split('?')[0]}`);
  return r.json();
}

async function fortlevCity(token, cidade) {
  const nome = String(cidade || '').split('-')[0].trim();
  if (!nome) throw new Error('Informe a cidade de entrega.');
  const q = encodeURIComponent(`['/^${nome.replace(/[^\p{L}\s]/gu, '')}/i']`);
  const j = await fortlevGet(token, `brazilian-city/?slug_name_in=${q}&current_page=1&docs_per_page=27`);
  const docs = j.docs || [];
  const uf = (String(cidade).split('-')[1] || 'SP').trim().toUpperCase();
  const city = docs.find(d => new RegExp(`^${nome}\\s*-\\s*${uf}$`, 'i').test(d.name)) || docs[0];
  if (!city) throw new Error(`Cidade "${cidade}" não encontrada na Fortlev.`);
  return city;
}

function classifyInverter(name) {
  if (/H[IÍ]BRID/i.test(name)) return 'hibrido';
  if (/OFF-GRID/i.test(name)) return 'offgrid';
  if (/MICRO|NEO \d|HMS|MIS-|IQ8|HYX-M|SUN-M|SUN-S\d/i.test(name)) return 'micro';
  return 'string';
}

function summarizeFortlevOrder(o) {
  const k = o.pv_kits[0];
  const comps = k.pv_kit_components.map(x => ({ nome: x.component.name, qtd: x.quantity, familia: x.component.family }));
  const mod = comps.find(c => c.familia === 'module');
  const invs = comps.filter(c => c.familia === 'inverter');
  const bats = comps.filter(c => /BATERIA|BATTERY/i.test(c.nome));
  const preco = Number(o.final_price) || 0;
  const frete = Number(o.freight_value) || 0;
  const kwp = Number(o.power) || 0;
  const wMod = mod ? Number((mod.nome.match(/(\d{3})\s?W/i) || [])[1] || 0) : 0;
  const tipo = invs.length ? classifyInverter(invs[0].nome) : 'string';
  return {
    distribuidora: 'Fortlev',
    tipo,
    kwp,
    overload: Math.round((Number(k.overload) || 0) * 1000) / 10,
    preco,
    frete,
    total: Math.round((preco + frete) * 100) / 100,
    rsWp: kwp ? Math.round(((preco + frete) / (kwp * 1000)) * 1000) / 1000 : null,
    modulo: mod ? { nome: mod.nome, qtd: mod.qtd, watts: wMod, tier1: TIER1.test(mod.nome) } : null,
    inversores: invs.map(i => ({ nome: i.nome, qtd: i.qtd })),
    baterias: bats.map(b => ({ nome: b.nome, qtd: b.qtd }))
  };
}

async function fortlevOrders(token, base, extra) {
  const r = await fetch(`${FORTLEV}/api/partner/order/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(Object.assign({}, base, extra))
  });
  if (!r.ok) throw new Error(`Fortlev respondeu ${r.status} ao gerar os kits.`);
  const j = await r.json();
  return (Array.isArray(j) ? j : []).map(summarizeFortlevOrder);
}

async function cotarFortlev({ kwp, telhado, cidade }) {
  const surface = FORTLEV_SURFACES[telhado];
  if (!surface) throw new Error(`Telhado "${telhado}" sem correspondência na Fortlev.`);
  const token = await fortlevLogin();
  const city = await fortlevCity(token, cidade);
  const base = {
    phase: Number(process.env.FORTLEV_FASE_MONO220 || 3),
    partner: process.env.FORTLEV_PARTNER_ID || FORTLEV_PARTNER_DEFAULT,
    voltage: '220',
    target_power: String(kwp),
    brazilian_city: city.id,
    distribution_center: city.distribution_center,
    surface,
    consume: null, orientation: null, inclination: null, total_load_w: null, total_load_wh: null
  };
  const onGrid = await fortlevOrders(token, base, {});
  // Híbridos na Fortlev só existem em kit com bateria (modo off-grid/híbrido com carga de "casa padrão").
  let hibridos = [];
  try {
    hibridos = (await fortlevOrders(token, base, { phase: 1, total_load_w: 555, total_load_wh: 3640 }))
      .filter(k => k.tipo === 'hibrido');
  } catch (e) { /* sem híbridos */ }
  return { cidade: city.name, kits: onGrid.concat(hibridos) };
}

// ---------- Seleção dos 3 níveis ----------

// Padrão Solsempre: painel Tier 1 de 590 a 720 W. Se não houver nenhum nessa faixa, aceita outras potências.
function melhores(kits, tipo, n = 3) {
  const base = kits.filter(k => k.tipo === tipo && k.modulo && k.modulo.tier1 && k.overload <= 50 && k.rsWp);
  const faixa = base.filter(k => k.modulo.watts >= 590 && k.modulo.watts <= 720);
  return (faixa.length ? faixa : base).sort((a, b) => a.rsWp - b.rsWp).slice(0, n);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });
  try {
    const auth = req.headers.authorization || '';
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const user = idToken ? await verifyUser(idToken) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'Não autorizado. Entre de novo no sistema.' });
    const allowed = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(user.email || '').toLowerCase())) {
      return res.status(403).json({ ok: false, error: 'Usuário sem permissão para cotar.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const kwp = Number(String(body.kwp || '').replace(',', '.'));
    if (!(kwp > 0 && kwp < 200)) return res.status(400).json({ ok: false, error: 'Informe a potência em kWp.' });
    const telhado = String(body.telhado || 'ceramico');
    const cidade = String(body.cidade || 'Itu - SP');

    const fontes = {};
    const avisos = [];
    let kits = [];

    try {
      const f = await cotarFortlev({ kwp, telhado, cidade });
      fontes.fortlev = { ok: true, cidade: f.cidade, total: f.kits.length };
      kits = kits.concat(f.kits);
    } catch (e) {
      fontes.fortlev = { ok: false, erro: e.message };
    }
    fontes.belenus = { ok: false, erro: 'Integração da Belenus em construção.' };
    fontes.avt = { ok: false, erro: 'Use o favorito "Cotar AVT" no portal da AVT.' };

    // Kits da AVT enviados pelo favorito (já com frete), se vierem junto.
    if (Array.isArray(body.kitsExtras)) kits = kits.concat(body.kitsExtras.filter(k => k && k.tipo && k.rsWp));

    const niveis = {
      entrada: melhores(kits, 'string'),
      equilibrado: melhores(kits, 'micro'),
      premium: melhores(kits.filter(k => !k.baterias || !k.baterias.length), 'hibrido')
    };
    if (!niveis.premium.length && kits.some(k => k.tipo === 'hibrido')) {
      avisos.push('Os híbridos encontrados só vêm em kit com bateria. Eles aparecem na lista completa, fora do nível premium.');
    }

    return res.status(200).json({ ok: true, entrada: { kwp, telhado, cidade }, fontes, niveis, kits, avisos });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Não foi possível cotar agora. Tente de novo.' });
  }
};
