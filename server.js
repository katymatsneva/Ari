// Ari — сервер: Telegram-бот, API для мини-приложения, напоминания.
// Все даты и время считаются по Еревану.
process.env.TZ = process.env.TZ || 'Asia/Yerevan';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const ical = require('node-ical');

const {
  WEBAPP_URL: RAW_URL = '',
  PORT = 3000,
  DB_PATH = path.join(__dirname, 'data', 'ari.db'),
  SEED_DEMO = '',
  DEV_TG_ID = '',
  NO_BOT = ''
} = process.env;

// Чистим значения от случайных пробелов и кавычек
const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
const BOT_TOKEN = clean(process.env.BOT_TOKEN);
const WEBAPP_URL = clean(RAW_URL);
const TOKEN_OK = /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(BOT_TOKEN);
if (!BOT_TOKEN) console.error('❌ BOT_TOKEN не задан. Добавь его во вкладке «Переменные».');
else if (!TOKEN_OK) console.error(`❌ BOT_TOKEN выглядит неправильно: сейчас он начинается с «${BOT_TOKEN[0]}» и длиной ${BOT_TOKEN.length} символов. Правильный токен начинается с цифр, потом двоеточие, всего около 46 символов. Возьми его в @BotFather: /mybots → бот → API Token.`);
else console.log(`✅ BOT_TOKEN по формату правильный (${BOT_TOKEN.length} символов)`);
if (!WEBAPP_URL) console.warn('⚠️  WEBAPP_URL пока не задан — кнопка «Открыть Ari» появится после того, как добавишь адрес');
const ADMIN_IDS = clean(process.env.ADMIN_IDS).split(/[\s,]+/).map(Number).filter(Boolean);
if (!ADMIN_IDS.length) console.warn('⚠️  ADMIN_IDS не задан — модерация некому приходит');
const isAdmin = id => ADMIN_IDS.includes(Number(id));
process.on('unhandledRejection', e => console.error('Ошибка (сервер продолжает работать):', e && e.message ? e.message : e));

/* ---------- база данных ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY, name TEXT, phone TEXT, tourist INTEGER DEFAULT 0,
  consent_at TEXT NOT NULL, joined_at TEXT NOT NULL, no INTEGER
);
CREATE TABLE IF NOT EXISTS masters (
  id TEXT PRIMARY KEY, tg_id INTEGER UNIQUE, data TEXT NOT NULL, plan TEXT DEFAULT 'free',
  demo INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, master_id TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, master_id TEXT NOT NULL, service_id TEXT, event_id TEXT,
  client_tg INTEGER, client_name TEXT, date TEXT NOT NULL, time TEXT NOT NULL, dur INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', source TEXT, confirmed INTEGER DEFAULT 0, rating INTEGER,
  created_at TEXT NOT NULL, moved_at TEXT, cancelled_at TEXT, confirmed_at TEXT,
  r24 INTEGER DEFAULT 0, r2 INTEGER DEFAULT 0, rm INTEGER DEFAULT 0, rrate INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS b_master_date ON bookings(master_id, date);
CREATE INDEX IF NOT EXISTS b_client ON bookings(client_tg);
CREATE TABLE IF NOT EXISTS digests (master_id TEXT, date TEXT, PRIMARY KEY (master_id, date));
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  from_tg INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL, resolved INTEGER DEFAULT 0,
  UNIQUE (target_type, target_id, from_tg)
);
`);
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('masters', 'status', "TEXT DEFAULT 'approved'"); // уже существующие страницы считаем одобренными
addCol('masters', 'reject_reason', 'TEXT');
addCol('events', 'status', "TEXT DEFAULT 'approved'");
addCol('events', 'reject_reason', 'TEXT');
addCol('users', 'blocked', 'INTEGER DEFAULT 0');
addCol('users', 'notify_launch', 'INTEGER DEFAULT 0');
addCol('users', 'pin_msg_id', 'INTEGER');
addCol('users', 'cal_token', 'TEXT');
addCol('masters', 'salon_id', 'TEXT');
addCol('masters', 'salon_role', 'TEXT');
addCol('masters', 'ical_url', 'TEXT');
addCol('masters', 'ical_synced', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS salons (
  id TEXT PRIMARY KEY, owner_tg INTEGER NOT NULL, data TEXT NOT NULL, status TEXT DEFAULT 'pending', reject_reason TEXT,
  invite TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT, master_id TEXT NOT NULL, client_tg INTEGER NOT NULL, date TEXT,
  created_at TEXT NOT NULL, notified INTEGER DEFAULT 0, UNIQUE (master_id, client_tg, date)
);
CREATE TABLE IF NOT EXISTS busy (
  master_id TEXT NOT NULL, date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS busy_md ON busy(master_id, date);
`);
addCol('bookings', 'attended', 'INTEGER');   // 1 — пришёл, 0 — не пришёл, NULL — не отмечено
addCol('bookings', 'rv', 'INTEGER DEFAULT 0'); // мастеру отправлен вопрос «пришёл ли клиент»
db.exec(`
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, booking_id TEXT UNIQUE NOT NULL, master_id TEXT NOT NULL, client_tg INTEGER,
  rating INTEGER NOT NULL, tags TEXT, text TEXT, anon INTEGER DEFAULT 1, display_name TEXT,
  created_at TEXT NOT NULL, publish_at TEXT NOT NULL, notified INTEGER DEFAULT 0,
  reply TEXT, reply_at TEXT, hidden INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, from_role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay (
  chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, booking_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
`);
const EVENT_KINDS = ['workshop', 'meetup', 'sport', 'food', 'tour', 'art', 'other'];
const REVIEW_TAGS = ['Пунктуальность', 'Результат', 'Атмосфера', 'Чистота', 'Внимательность', 'Цена и качество'];
const PUBLISH_DELAY = 3 * 864e5;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const shortName = n => { const [a = '', b = ''] = String(n || '').trim().split(/\s+/); return a + (b ? ' ' + b[0].toUpperCase() + '.' : ''); };

/* ---------- модерация: стоп-слова ---------- */
const STOP = [
  'секс', 'интим', 'эрот', 'оргия', 'оргии', 'свинг', 'эскорт', 'проститу', 'хэппи энд', 'хеппи энд', 'happy end', '18+', 'порн', 'стриптиз', 'вебкам',
  'наркот', 'закладк', 'марихуан', 'каннаб', 'гашиш', 'кокаин', 'мефедрон', 'амфетамин', 'мдма', 'экстази', 'псилоцибин',
  'оружи', 'пистолет', 'боеприпас', 'казино', 'букмекер', 'ставки на спорт', 'ставкам на спорт', 'финансовая пирамида', 'гарантированный доход', 'удвоим',
  'вылечим', 'излечим', 'исцеление от', 'без лицензии',
  'sex', 'erotic', 'orgy', 'escort', 'nude', 'nsfw', 'porn', 'strip', 'weed', 'cocaine', 'drugs', 'casino', 'betting',
  'սեքս', 'էրոտիկ', 'թմրանյութ', 'կազինո'
];
const STOP_RE = new RegExp('(^|[^\\p{L}\\p{N}])(' + STOP.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'iu');
const flagged = (...parts) => { const m = parts.filter(Boolean).join(' \n ').toLowerCase().replace(/ё/g, 'е').match(STOP_RE); return m ? m[2] : null; };
const REJECT_REASONS = ['Нарушает правила сервиса', 'Мало информации — добавь описание и фото', 'Не похоже на реальную услугу или событие', 'Запрещённая категория (18+, азартные игры, вещества и т. п.)'];

/* ---------- утилиты ---------- */
const pad = n => String(n).padStart(2, '0');
const dk = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const startTs = (date, time) => new Date(`${date}T${time}:00`).getTime();
const nowIso = () => new Date().toISOString();
const rid = () => crypto.randomBytes(5).toString('hex');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max, def = min) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00'));
const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isId = s => typeof s === 'string' && /^[\w-]{3,40}$/.test(s);
const html = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const CATS = ['massage', 'beauty', 'psy', 'photo', 'yoga', 'edu', 'tour'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const cap = t => t ? t[0].toUpperCase() + t.slice(1) : t;
const human = date => { const d = new Date(date + 'T00:00:00'); return `${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}`; };
const CARD_RE = /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

/* ---------- доступ к данным ---------- */
const getUser = id => db.prepare('SELECT * FROM users WHERE tg_id = ?').get(id);
const rowToMaster = r => r && ({ ...JSON.parse(r.data), id: r.id, plan: r.plan, tgId: r.tg_id });
const getMaster = id => rowToMaster(db.prepare('SELECT * FROM masters WHERE id = ?').get(id));
const masterOf = tgId => rowToMaster(db.prepare('SELECT * FROM masters WHERE tg_id = ?').get(tgId));
const getEvent = id => { const r = db.prepare('SELECT * FROM events WHERE id = ?').get(id); return r && { ...JSON.parse(r.data), id: r.id, masterId: r.master_id, date: r.date, time: r.time }; };
const getBooking = id => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

const inArm = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 38.7 && lat < 41.4 && lng > 43.3 && lng < 46.7;
const okImg = v => typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length < 400000 ? v : '';
function cleanPlace(b) {
  const lat = Number(b.lat), lng = Number(b.lng), ok = inArm(lat, lng);
  return { lat: ok ? Math.round(lat * 1e6) / 1e6 : null, lng: ok ? Math.round(lng * 1e6) / 1e6 : null, entrance: str(b.entrance, 300), entrancePhoto: okImg(b.entrancePhoto) };
}
function cleanMaster(b) {
  const sch = b.schedule || {};
  const out = {
    name: str(b.name, 60), cat: CATS.includes(b.cat) ? b.cat : 'massage', about: str(b.about, 400),
    area: str(b.area, 40), address: str(b.address, 120), prepay: int(b.prepay, 0, 1e6, 0),
    payInfo: str(b.payInfo, 120), langs: str(b.langs, 80), registry: !!b.registry,
    ...cleanPlace(b),
    photo: typeof b.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.photo) && b.photo.length < 400000 ? b.photo : '',
    services: (Array.isArray(b.services) ? b.services : []).slice(0, 20)
      .map(s => ({ id: isId(s.id) ? s.id : rid(), name: str(s.name, 60), dur: int(s.dur, 15, 720, 60), price: int(s.price, 0, 1e7, 0) }))
      .filter(s => s.name),
    schedule: { days: [...new Set((Array.isArray(sch.days) ? sch.days : []).map(Number).filter(d => d >= 0 && d <= 6))], from: int(sch.from, 0, 23, 10), to: int(sch.to, 1, 24, 19) }
  };
  if (!out.name) fail(400, 'Укажи имя');
  if (!out.services.length) fail(400, 'Нужна хотя бы одна услуга');
  if (!out.schedule.days.length || out.schedule.to <= out.schedule.from) fail(400, 'Проверь график работы');
  if (CARD_RE.test(out.payInfo)) fail(400, 'Не указывай номер карты — лучше Idram, Telcell или ссылку');
  return out;
}

function slotFree(m, date, time, dur, ignoreId = '') {
  const d = new Date(date + 'T00:00:00');
  if (!m.schedule.days.includes(d.getDay())) return false;
  const s = toMin(time), e = s + dur;
  if (s < m.schedule.from * 60 || e > m.schedule.to * 60) return false;
  if (startTs(date, time) < Date.now()) return false;
  const busy = db.prepare(`SELECT time, dur FROM bookings WHERE master_id = ? AND date = ? AND status = 'active' AND event_id IS NULL AND id <> ?`).all(m.id, date, ignoreId)
    .concat(db.prepare('SELECT time, data FROM events WHERE master_id = ? AND date = ?').all(m.id, date).map(r => ({ time: r.time, dur: JSON.parse(r.data).dur || 90 })));
  db.prepare('SELECT start_min, end_min FROM busy WHERE master_id = ? AND date = ?').all(m.id, date).forEach(x => busy.push({ time: toTime(x.start_min), dur: x.end_min - x.start_min }));
  return !busy.some(b => s < toMin(b.time) + b.dur && e > toMin(b.time));
}
const toTime = mins => pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);

const imgV = d => crypto.createHash('md5').update(d).digest('hex').slice(0, 10);
const imgUrl = (kind, id, field, d) => d ? `/img/${kind}/${id}/${field}?v=${imgV(d)}` : '';
function publicMaster(r) {
  const m = rowToMaster(r);
  m.photo = imgUrl('m', m.id, 'photo', m.photo);
  m.entrancePhoto = imgUrl('m', m.id, 'entrancePhoto', m.entrancePhoto);
  m.salonId = r.salon_id || undefined;
  m.salonRole = r.salon_id ? r.salon_role || 'master' : undefined;
  const now = nowIso();
  const rated = db.prepare('SELECT COUNT(*) n, SUM(rating) s FROM reviews WHERE master_id = ? AND hidden = 0 AND publish_at <= ?').get(m.id, now);
  const n = rated.n;
  m.rating = n >= 3 ? Math.round((rated.s / n) * 10) / 10 : 0; // средний рейтинг показываем от трёх отзывов
  m.reviews = n;
  m.reviewsList = db.prepare('SELECT * FROM reviews WHERE master_id = ? AND hidden = 0 AND publish_at <= ? ORDER BY publish_at DESC LIMIT 20').all(m.id, now).map(v => {
    const d = new Date(v.created_at);
    return { id: v.id, rating: v.rating, tags: JSON.parse(v.tags || '[]'), text: v.text || '', name: v.anon ? 'Анонимно' : (v.display_name || 'Клиент'), month: MONTHS[d.getMonth()] + ' ' + d.getFullYear(), reply: v.reply || '' };
  });
  m.status = r.status || 'approved';
  m.rejectReason = r.reject_reason || undefined;
  delete m.tgId;
  return m;
}

const noShowStmt = db.prepare('SELECT 1 FROM bookings WHERE client_tg = ? AND attended = 0 AND date >= ? LIMIT 1');
const reviewStmt = db.prepare('SELECT rating FROM reviews WHERE booking_id = ?');
function bookingOut(b, viewer, myMasterIds) {
  const myMasterId = myMasterIds && myMasterIds.has(b.master_id) ? b.master_id : null;
  const rv = reviewStmt.get(b.id);
  const extra = { attended: b.attended === null || b.attended === undefined ? undefined : b.attended, reviewed: !!rv, rating: rv ? rv.rating : undefined };
  const base = { id: b.id, masterId: b.master_id, serviceId: b.service_id || undefined, eventId: b.event_id || undefined, date: b.date, time: b.time, dur: b.dur, status: b.status };
  if (b.client_tg && b.client_tg === viewer) return { ...base, ...extra, mine: true, clientName: b.client_name, source: b.source, confirmed: !!b.confirmed, createdAt: b.created_at, movedAt: b.moved_at || undefined, cancelledAt: b.cancelled_at || undefined, confirmedAt: b.confirmed_at || undefined };
  if (myMasterId && b.master_id === myMasterId) return { ...base, ...extra, mine: false, hasClient: !!b.client_tg, clientFlag: b.client_tg && noShowStmt.get(b.client_tg, dk(Date.now() - 180 * 864e5)) ? 'noshow' : undefined, clientName: b.client_name, source: b.source, confirmed: !!b.confirmed, createdAt: b.created_at, movedAt: b.moved_at || undefined, cancelledAt: b.cancelled_at || undefined, confirmedAt: b.confirmed_at || undefined };
  return { ...base, mine: false, clientName: '' }; // чужие записи — только занятое время, без имён
}

/* ---------- демо-данные для закрытого теста ---------- */
if (SEED_DEMO && !db.prepare('SELECT 1 FROM masters WHERE demo = 1 LIMIT 1').get()) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  const ins = db.prepare('INSERT INTO masters (id, tg_id, data, plan, demo, created_at) VALUES (?, NULL, ?, ?, 1, ?)');
  seed.masters.forEach(m => { const { id, ...data } = m; ins.run(id, JSON.stringify(data), 'free', nowIso()); });
  const insE = db.prepare('INSERT INTO events (id, master_id, date, time, data, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  seed.events.forEach(e => { const { id, masterId, offset, time, ...data } = e; insE.run(id, masterId, dk(Date.now() + Math.max(1, offset) * 864e5), time, JSON.stringify(data), nowIso()); });
  console.log('Демо-данные добавлены');
}

if (process.env.CLEAR_DEMO) {
  const ids = db.prepare('SELECT id FROM masters WHERE demo = 1').all().map(r => r.id);
  ids.forEach(id => { db.prepare('DELETE FROM bookings WHERE master_id = ?').run(id); db.prepare('DELETE FROM events WHERE master_id = ?').run(id); db.prepare('DELETE FROM masters WHERE id = ?').run(id); });
  if (ids.length) console.log('Демо-мастера удалены:', ids.length);
}

/* ---------- бот ---------- */
const botOn = TOKEN_OK && !NO_BOT;
const bot = botOn ? new Bot(BOT_TOKEN) : null;
const pendingPhone = new Map(); // номер, которым поделились до согласия; живёт в памяти 1 час

async function send(tgId, text, kb) {
  if (!bot || !tgId) return;
  try { return await bot.api.sendMessage(tgId, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } }); }
  catch (e) { console.warn('send failed', tgId, e.description || e.message); }
}
function getSalon(id) { const r = id && db.prepare('SELECT * FROM salons WHERE id = ?').get(id); return r && { ...JSON.parse(r.data), id: r.id, ownerTg: r.owner_tg, status: r.status, invite: r.invite, rejectReason: r.reject_reason }; }
function placeOf(m) {
  const sal = m && m.salonId !== undefined ? getSalon(m.salonId) : m && getSalon((db.prepare('SELECT salon_id FROM masters WHERE id = ?').get(m.id) || {}).salon_id);
  if (sal && sal.status === 'approved') return { name: sal.name, area: sal.area, address: sal.address, lat: sal.lat, lng: sal.lng, entrance: sal.entrance, salon: sal };
  return { area: m.area, address: m.address, lat: m.lat, lng: m.lng, entrance: m.entrance };
}
const addrOf = m => { const p = placeOf(m); return [p.name, p.address || p.area].filter(Boolean).join(', '); };
const appUrl = q => WEBAPP_URL + (q ? (WEBAPP_URL.includes('?') ? '&' : '?') + q : '');
const mapUrl = m => WEBAPP_URL ? `${WEBAPP_URL.replace(/\/$/, '')}/go/${m.id}` : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Yerevan ' + addrOf(m));
function what(b, m) {
  if (b.event_id) { const e = getEvent(b.event_id); return e ? e.title : 'Событие'; }
  const s = (m.services || []).find(x => x.id === b.service_id);
  return s ? s.name : 'Визит';
}
function notify(kind, b) {
  const m = getMaster(b.master_id); if (!m) return;
  const w = html(what(b, m)), when = `${cap(human(b.date))}, ${b.time}`;
  const toClient = (t, kb) => send(b.client_tg, t, kb);
  const toMaster = (t, kb) => send(m.tgId, t, kb);
  if (kind === 'created') {
    const kbC = new InlineKeyboard().text('Написать мастеру', 'w:' + b.id).url('Маршрут', mapUrl(m));
    toClient(`<b>${when}</b>\n${addrOf(m) ? html(addrOf(m)) + '\n' : ''}${b.event_id ? 'Место за тобой' : 'Записали'}: ${w}, ${html(m.name)}${!b.event_id && m.prepay ? `\n\nПредоплата ${m.prepay.toLocaleString('ru-RU')} ֏ — напрямую мастеру: ${html(m.payInfo || 'реквизиты пришлёт мастер')}` : ''}\n\nНапомню за день и за 2 часа.`, kbC);
    toMaster(`<b>Новая запись · ${when}</b>\n${html(b.client_name)}, ${w}${b.source === 'afisha' ? '\nПришёл из афиши' : ''}${b.client_tg && hasNoShow(b.client_tg) ? '\nУ клиента была неявка' : ''}`, b.client_tg ? new InlineKeyboard().text('💬 Написать клиенту', 'w:' + b.id) : undefined);
  }
  setTimeout(() => { updatePin(b.client_tg, kind === 'created'); updatePin(m.tgId, kind === 'created'); }, 300);
  if (kind === 'moved') toMaster(`${html(b.client_name)} перенес(ла) запись: теперь ${when}, ${w}`);
  if (kind === 'confirmed') toMaster(`${html(b.client_name)} подтвердил(а) визит: ${when}`);
  if (kind === 'cancelledByClient') { toMaster(`${html(b.client_name)} отменил(а) запись на ${when}. Окно снова свободно`); toClient(`Запись отменена: ${w}, ${when}. Мастер в курсе.`); }
  if (kind === 'cancelledByMaster') toClient(`${when} отменяется: мастер ${html(m.name)} не сможет. Выбери другое время:`, new InlineKeyboard().webApp('Записаться снова', appUrl('rebook=' + b.id)));
}

const hasNoShow = tg => !!noShowStmt.get(tg, dk(Date.now() - 180 * 864e5));

/* ---------- чат через бота ---------- */
const chatMode = new Map(); // tg → { bookingId, until }
const QUICK = {
  client: [['late', 'Опаздываю минут на 10'], ['find', 'Не могу найти вход, подскажите, пожалуйста'], ['move', 'Хочу перенести запись']],
  master: [['delay', 'Задерживаюсь минут на 15, извините'], ['ready', 'Жду вас, можно заходить'], ['sick', 'Заболел(а), придётся отменить']]
};
function chatRole(b, tg) {
  if (!b) return null;
  if (b.client_tg && b.client_tg === tg) return 'client';
  const m = getMaster(b.master_id);
  if (m && m.tgId === tg && b.client_tg) return 'master';
  if (b.client_tg && isSalonManager(tg, b.master_id)) return 'master';
  return null;
}
function chatOpen(b) {
  if (!b || b.status !== 'active' || !b.client_tg) return false;
  return Date.now() < startTs(b.date, b.time) + (b.dur + 24 * 60) * 6e4; // до суток после визита
}
function bookingLabel(b, m) { return `${human(b.date)}, ${b.time} · ${html(what(b, m))}`; }
async function startChat(tg, b) {
  const role = chatRole(b, tg);
  if (!role) return 'Запись не найдена';
  if (!chatOpen(b)) return 'Переписка по этой записи уже закрыта';
  const m = getMaster(b.master_id);
  chatMode.set(tg, { bookingId: b.id, until: Date.now() + 15 * 6e4 });
  const kb = new InlineKeyboard();
  QUICK[role].forEach(([code, label]) => kb.text(label, `q:${b.id}:${code}`).row());
  kb.text('Отмена', 'wq');
  await send(tg, `Напиши сообщение для <b>${html(role === 'client' ? m.name : b.client_name)}</b> — я передам.\nЗапись: ${bookingLabel(b, m)}\n\nИли выбери быстрый ответ:`, kb);
  return null;
}
async function relayMessage(fromTg, b, text) {
  const role = chatRole(b, fromTg); if (!role || !chatOpen(b)) return false;
  const m = getMaster(b.master_id);
  const to = role === 'client' ? (m.tgId || (db.prepare('SELECT s.owner_tg t FROM masters x JOIN salons s ON s.id = x.salon_id WHERE x.id = ?').get(m.id) || {}).t) : b.client_tg;
  if (!to) return false;
  db.prepare('INSERT INTO messages (booking_id, from_role, text, created_at) VALUES (?, ?, ?, ?)').run(b.id, role, text.slice(0, 2000), nowIso());
  const who = role === 'client' ? `<b>${html(b.client_name)}</b> (клиент)` : `<b>${html(m.name)}</b> (мастер)`;
  const msg = await send(to, `${who}\n<i>${bookingLabel(b, m)}</i>\n\n${html(text.slice(0, 2000))}\n\n<i>Ответь свайпом на это сообщение или кнопкой ниже</i>`, new InlineKeyboard().text('Ответить', 'w:' + b.id));
  if (msg) db.prepare('INSERT OR REPLACE INTO relay (chat_id, message_id, booking_id, created_at) VALUES (?, ?, ?, ?)').run(to, msg.message_id, b.id, nowIso());
  return true;
}

/* ---------- закреплённая карточка с записями ---------- */
const pinOffset = new Map();
const WDS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const shortDate = k => { const d = new Date(k + 'T00:00:00'); return `${WDS[d.getDay()]}, ${d.getDate()} ${MON_SHORT[d.getMonth()]}`; };
function buildPin(tg) {
  const now = Date.now();
  const mine = db.prepare(`SELECT * FROM bookings WHERE client_tg = ? AND status = 'active' AND date >= ? ORDER BY date, time`).all(tg, dk(now))
    .filter(b => startTs(b.date, b.time) + b.dur * 6e4 > now).slice(0, 5);
  const my = masterOf(tg);
  const parts = ['<b>Твои записи</b> · обновляется само'];
  const kb = new InlineKeyboard();
  if (mine.length || !my) {
    parts.push('<b>Ближайшие записи:</b>\n' + (mine.length ? mine.map((b, i) => { const m = getMaster(b.master_id); return `${i + 1}. ${shortDate(b.date)} · ${b.time} — ${html(what(b, m))}, ${html(m ? m.name : '')}`; }).join('\n') : 'Пока записей нет'));
    mine.forEach((b, i) => { const m = getMaster(b.master_id); kb.text(`Написать · ${i + 1}`, 'w:' + b.id); if (m) kb.url(`Маршрут · ${i + 1}`, mapUrl(m)); kb.row(); });
  }
  if (my) {
    const off = pinOffset.get(tg) || 0, day = dk(now + off * 864e5);
    const list = db.prepare(`SELECT * FROM bookings WHERE master_id = ? AND date = ? AND status = 'active' ORDER BY time`).all(my.id, day);
    parts.push(`<b>Кабинет · ${off === 0 ? 'Сегодня' : off === 1 ? 'Завтра' : off === -1 ? 'Вчера' : ''}${Math.abs(off) > 1 ? '' : ', '}${shortDate(day)}:</b>\n` +
      (list.length ? list.map(b => `${b.time} — ${html(b.client_name)}, ${html(what(b, my))}${b.confirmed ? ' ✓' : ''}${b.attended === 0 ? ' · не пришёл' : ''}`).join('\n') : 'Записей нет'));
    kb.text('◀', 'pn:' + (off - 1)).text('Сегодня', 'pn:0').text('▶', 'pn:' + (off + 1)).row();
  }
  if (WEBAPP_URL) kb.webApp('Открыть Ari', WEBAPP_URL);
  return { text: parts.join('\n\n'), kb };
}
async function updatePin(tg, create = false) {
  if (!bot || !tg) return;
  const u = getUser(tg); if (!u) return;
  const { text, kb } = buildPin(tg);
  if (u.pin_msg_id) {
    try { await bot.api.editMessageText(tg, u.pin_msg_id, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } }); return; }
    catch (e) { if (/not modified/.test(e.description || '')) return; if (!create) create = true; }
  }
  if (!create) return;
  const msg = await send(tg, text, kb); if (!msg) return;
  db.prepare('UPDATE users SET pin_msg_id = ? WHERE tg_id = ?').run(msg.message_id, tg);
  bot.api.pinChatMessage(tg, msg.message_id, { disable_notification: true }).catch(e => console.warn('pin failed', e.description || e.message));
}

/* ---------- отзывы ---------- */
function saveReview(tg, b, { rating, tags, text, anon }) {
  const existing = db.prepare('SELECT * FROM reviews WHERE booking_id = ?').get(b.id);
  if (existing && existing.publish_at <= nowIso()) fail(400, 'Отзыв уже опубликован');
  const u = getUser(tg) || {};
  const clean = { rating: int(rating, 1, 5, 5), tags: JSON.stringify((Array.isArray(tags) ? tags : []).filter(t => REVIEW_TAGS.includes(t)).slice(0, 6)), text: str(text, 800), anon: anon === false ? 0 : 1 };
  const hit = flagged(clean.text);
  if (existing) db.prepare('UPDATE reviews SET rating = ?, tags = ?, text = ?, anon = ?, hidden = ? WHERE id = ?').run(clean.rating, clean.tags, clean.text, clean.anon, hit ? 2 : existing.hidden, existing.id);
  else db.prepare('INSERT INTO reviews (id, booking_id, master_id, client_tg, rating, tags, text, anon, display_name, created_at, publish_at, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('r_' + rid(), b.id, b.master_id, tg, clean.rating, clean.tags, clean.text, clean.anon, shortName(u.name), nowIso(), new Date(Date.now() + PUBLISH_DELAY).toISOString(), hit ? 2 : 0);
  if (hit) { const r = db.prepare('SELECT id FROM reviews WHERE booking_id = ?').get(b.id); ADMIN_IDS.forEach(a => send(a, `📝 <b>Отзыв на проверке</b> (стоп-слово «${html(hit)}»)\n★${clean.rating} ${html(clean.text)}`, new InlineKeyboard().text('✅ Опубликовать', 'ra:' + r.id).text('🗑 Удалить', 'rd:' + r.id))); }
}
function canReview(b, tg) {
  if (!b || b.client_tg !== tg || b.event_id) return 'Отзыв можно оставить только о своей записи к мастеру';
  if (b.attended === 0) return 'Мастер отметил, что визит не состоялся';
  const end = startTs(b.date, b.time) + b.dur * 6e4;
  if (Date.now() < end) return 'Отзыв можно оставить после визита';
  if (Date.now() > end + 30 * 864e5) return 'Прошло больше 30 дней после визита';
  return null;
}

if (bot) {
  bot.command('start', async (ctx, next) => {
    const p = String(ctx.match || '');
    if (!WEBAPP_URL || !/^[mesj]_[\w-]+$/.test(p)) return next();
    const [k, id] = [p[0], p.slice(2)];
    if (k === 'm') { const m = getMaster(id); if (m) return ctx.reply(`Запись к <b>${html(m.name)}</b> — выбери удобное время:`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('Записаться', appUrl('master=' + id)) }); }
    if (k === 'e') { const e = getEvent(id); if (e) return ctx.reply(`<b>${human(e.date)}, ${e.time}</b>\n${html(e.title)}. Идёшь?`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('Подробнее и записаться', appUrl('event=' + id)) }); }
    if (k === 's') { const sl = getSalon(id); if (sl) return ctx.reply(`Салон <b>${html(sl.name)}</b> — выбери мастера и время:`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('Записаться', appUrl('salon=' + id)) }); }
    if (k === 'j') { const r = db.prepare('SELECT * FROM salons WHERE invite = ?').get(id); if (r) return ctx.reply(`Тебя приглашают в команду салона <b>${html(JSON.parse(r.data).name)}</b>.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('Присоединиться', appUrl('join=' + id)) }); }
    return next();
  });
  bot.command('start', ctx => !WEBAPP_URL ? ctx.reply('Ari почти готов — осталось добавить адрес приложения на сервере.') : ctx.reply(
    'Барев. Я <b>Ari</b> — по-армянски это «приходи».\n\nЗаписывайся к мастерам Еревана, находи события и местные впечатления. Напоминания о записях буду присылать сюда.',
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('Открыть Ari', WEBAPP_URL) }
  ));
  bot.command('bookings', async ctx => { if (!getUser(ctx.from.id)) return ctx.reply('Сначала открой Ari и пройди регистрацию.'); await updatePin(ctx.from.id, true); });
  bot.command('privacy', ctx => ctx.reply('Я храню твоё имя, телефон (если он указан) и записи — только чтобы работали запись и напоминания. Удалить всё можно в приложении: Документы → Удалить мои данные.'));
  bot.on('message:contact', async ctx => {
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply('Нужен твой собственный номер — нажми кнопку в приложении.');
    const phone = c.phone_number.startsWith('+') ? c.phone_number : '+' + c.phone_number;
    if (getUser(ctx.from.id)) db.prepare('UPDATE users SET phone = ? WHERE tg_id = ?').run(phone, ctx.from.id);
    else { pendingPhone.set(ctx.from.id, phone); setTimeout(() => pendingPhone.delete(ctx.from.id), 36e5); }
    await ctx.reply('Спасибо, номер получил. Возвращайся в приложение.', { reply_markup: { remove_keyboard: true } });
  });
  bot.callbackQuery(/^(c|x|r):([\w-]+)(?::(\d))?$/, async ctx => {
    const [, act, id, val] = ctx.match;
    const b = getBooking(id);
    if (!b || b.client_tg !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Запись не найдена' });
    if (act === 'c' && b.status === 'active') {
      db.prepare('UPDATE bookings SET confirmed = 1, confirmed_at = ? WHERE id = ?').run(nowIso(), id);
      notify('confirmed', getBooking(id));
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('✓ Подтверждено', 'noop') }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Отлично, мастер увидит, что ты придёшь' });
    }
    if (act === 'x' && b.status === 'active') {
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(nowIso(), id);
      notify('cancelledByClient', getBooking(id));
      freedSlot(b);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Запись отменена' });
    }
    if (act === 'r') {
      const why = canReview(b, ctx.from.id); if (why) return ctx.answerCallbackQuery({ text: why });
      try { saveReview(ctx.from.id, b, { rating: +val, anon: true }); } catch (e) { return ctx.answerCallbackQuery({ text: e.message }); }
      await ctx.editMessageText(`Спасибо. Твоя оценка: ${'★'.repeat(+val)}\nДобавишь пару слов? Это помогает другим клиентам и мастеру. Отзыв появится через 3 дня.`, { reply_markup: new InlineKeyboard().webApp('✍️ Написать отзыв', appUrl('review=' + id)).row().webApp('Записаться снова', appUrl('rebook=' + id)) }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Спасибо за оценку' });
    }
    return ctx.answerCallbackQuery();
  });
  bot.callbackQuery('noop', ctx => ctx.answerCallbackQuery());

  /* ----- чат ----- */
  bot.callbackQuery(/^w:([\w-]+)$/, async ctx => {
    const err = await startChat(ctx.from.id, getBooking(ctx.match[1]));
    return ctx.answerCallbackQuery(err ? { text: err } : undefined);
  });
  bot.callbackQuery('wq', async ctx => { chatMode.delete(ctx.from.id); await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}); return ctx.answerCallbackQuery({ text: 'Отменено' }); });
  bot.callbackQuery(/^q:([\w-]+):(\w+)$/, async ctx => {
    const [, id, code] = ctx.match, b = getBooking(id), role = chatRole(b, ctx.from.id);
    if (!role || !chatOpen(b)) return ctx.answerCallbackQuery({ text: 'Переписка недоступна' });
    if (code === 'sick') {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('Да, отменить запись', 'qx:' + id).text('Нет', 'wq') }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Точно отменить?' });
    }
    const item = QUICK[role].find(([c]) => c === code); if (!item) return ctx.answerCallbackQuery();
    await relayMessage(ctx.from.id, b, item[1]);
    if (code === 'move') await send(ctx.from.id, 'Перенести можно сразу — выбери новое время:', new InlineKeyboard().webApp('Перенести', appUrl('move=' + id)));
    chatMode.delete(ctx.from.id);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return ctx.answerCallbackQuery({ text: 'Передал ✓' });
  });
  bot.callbackQuery(/^qx:([\w-]+)$/, async ctx => {
    const b = getBooking(ctx.match[1]);
    if (chatRole(b, ctx.from.id) !== 'master' || b.status !== 'active') return ctx.answerCallbackQuery({ text: 'Недоступно' });
    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(nowIso(), b.id);
    const m = getMaster(b.master_id);
    freedSlot(b);
    send(b.client_tg, `${cap(human(b.date))}, ${b.time} отменяется: мастер ${html(m.name)} заболел(а). Извини за неудобства.${m.prepay ? '\nЕсли ты вносил(а) предоплату, мастер вернёт её.' : ''}\n\nВыбери другое время:`, new InlineKeyboard().webApp('Записаться снова', appUrl('rebook=' + b.id)));
    chatMode.delete(ctx.from.id);
    setTimeout(() => { updatePin(b.client_tg); updatePin(m.tgId); }, 300);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return ctx.answerCallbackQuery({ text: 'Запись отменена, клиент получил сообщение' });
  });

  /* ----- закреп: листание дней мастера ----- */
  bot.callbackQuery(/^pn:(-?\d+)$/, async ctx => {
    pinOffset.set(ctx.from.id, Math.max(-7, Math.min(60, +ctx.match[1])));
    await updatePin(ctx.from.id);
    return ctx.answerCallbackQuery();
  });

  /* ----- отметка визита ----- */
  bot.callbackQuery(/^v:([\w-]+):([01])$/, async ctx => {
    const b = getBooking(ctx.match[1]), m = b && getMaster(b.master_id);
    if (!m || m.tgId !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Недоступно' });
    const v = +ctx.match[2];
    db.prepare('UPDATE bookings SET attended = ? WHERE id = ?').run(v, b.id);
    if (v === 0 && b.client_tg) send(b.client_tg, `Мастер ${html(m.name)} отметил(а), что визит ${human(b.date)}, ${b.time} не состоялся.\nЕсли это ошибка — нажми кнопку ниже, мы разберёмся.`, new InlineKeyboard().text('Я был(а) на визите', 'vd:' + b.id));
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(v ? 'Пришёл ✓' : 'Не пришёл', 'noop') }).catch(() => {});
    setTimeout(() => updatePin(m.tgId), 300);
    return ctx.answerCallbackQuery({ text: 'Отмечено' });
  });
  bot.callbackQuery(/^vd:([\w-]+)$/, async ctx => {
    const b = getBooking(ctx.match[1]);
    if (!b || b.client_tg !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Недоступно' });
    const m = getMaster(b.master_id);
    ADMIN_IDS.forEach(a => send(a, `⚖️ <b>Спор о визите</b>\nКлиент ${html(b.client_name)} говорит, что был(а) у ${html(m ? m.name : '?')} ${human(b.date)}, ${b.time}, а мастер отметил неявку.`, new InlineKeyboard().text('Снять неявку', 'va:' + b.id).text('Оставить', 'noop')));
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('Отправлено модератору', 'noop') }).catch(() => {});
    return ctx.answerCallbackQuery({ text: 'Мы разберёмся' });
  });

  /* ----- ответ мастера на отзыв ----- */
  const replyMode = new Map(); // tg → reviewId
  bot.callbackQuery(/^rv:([\w-]+)$/, async ctx => {
    const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(ctx.match[1]), m = r && getMaster(r.master_id);
    if (!m || m.tgId !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Недоступно' });
    if (r.reply) return ctx.answerCallbackQuery({ text: 'На этот отзыв ответ уже есть' });
    replyMode.set(ctx.from.id, r.id);
    await send(ctx.from.id, 'Напиши публичный ответ одним сообщением. Его увидят все на твоей странице.');
    return ctx.answerCallbackQuery();
  });

  /* ----- админка ----- */
  const adminStats = () => {
    const q = sql => db.prepare(sql).get().n;
    return `<b>Панель Ari</b>\n\n👥 Пользователей: ${q('SELECT COUNT(*) n FROM users')}\n🧑‍🎨 Мастеров: ${q(`SELECT COUNT(*) n FROM masters WHERE status = 'approved' AND demo = 0`)} (демо: ${q('SELECT COUNT(*) n FROM masters WHERE demo = 1')})\n` +
      `🏠 Салонов: ${q(`SELECT COUNT(*) n FROM salons WHERE status = 'approved'`)}\n⏳ На проверке: ${q(`SELECT COUNT(*) n FROM masters WHERE status = 'pending'`)} мастеров, ${q(`SELECT COUNT(*) n FROM events WHERE status = 'pending'`)} событий, ${q(`SELECT COUNT(*) n FROM salons WHERE status = 'pending'`)} салонов\n🚩 Открытых жалоб: ${q('SELECT COUNT(*) n FROM complaints WHERE resolved = 0')}\n` +
      `📅 Записей за 7 дней: ${db.prepare(`SELECT COUNT(*) n FROM bookings WHERE created_at >= ?`).get(new Date(Date.now() - 7 * 864e5).toISOString()).n}\n🔔 Ждут запуска: ${q('SELECT COUNT(*) n FROM users WHERE notify_launch = 1')}`;
  };
  bot.command('admin', ctx => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(`Эта команда только для администратора. Твой ID: ${ctx.from.id}`);
    return ctx.reply(adminStats(), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⏳ Очередь проверки', 'aq').text('🚩 Жалобы', 'ac') });
  });
  bot.command('id', ctx => ctx.reply(`Твой Telegram ID: ${ctx.from.id}`));
  const adminOnly = fn => async ctx => { if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для администратора' }); return fn(ctx); };
  const done = async (ctx, text) => { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(text, 'noop') }).catch(() => {}); return ctx.answerCallbackQuery({ text }); };

  bot.callbackQuery('aq', adminOnly(async ctx => {
    const ms = db.prepare(`SELECT id FROM masters WHERE status = 'pending'`).all(), es = db.prepare(`SELECT id FROM events WHERE status = 'pending'`).all(), ss = db.prepare(`SELECT id FROM salons WHERE status = 'pending'`).all();
    await ctx.answerCallbackQuery();
    if (!ms.length && !es.length && !ss.length) return ctx.reply('Очередь пуста ✨');
    for (const r of ss) await sendCard(ctx.from.id, salonCard(r.id));
    for (const r of ms) await sendCard(ctx.from.id, masterCard(r.id));
    for (const r of es) await sendCard(ctx.from.id, eventCard(r.id));
  }));
  bot.callbackQuery('ac', adminOnly(async ctx => {
    const cs = db.prepare('SELECT * FROM complaints WHERE resolved = 0 ORDER BY id').all();
    await ctx.answerCallbackQuery();
    if (!cs.length) return ctx.reply('Открытых жалоб нет ✨');
    cs.forEach(c => notifyComplaint(c.id, db.prepare('SELECT COUNT(*) n FROM complaints WHERE target_type = ? AND target_id = ? AND resolved = 0').get(c.target_type, c.target_id).n));
  }));
  bot.callbackQuery(/^am:(.+)$/, adminOnly(async ctx => {
    const id = ctx.match[1], m = getMaster(id); if (!m) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
    db.prepare(`UPDATE masters SET status = 'approved', reject_reason = NULL WHERE id = ?`).run(id);
    send(m.tgId, '<b>Твоя страница опубликована.</b>\nТеперь клиенты видят тебя в каталоге и могут записываться.', WEBAPP_URL ? new InlineKeyboard().webApp('Открыть кабинет', WEBAPP_URL) : undefined);
    return done(ctx, '✅ Одобрено');
  }));
  bot.callbackQuery(/^ae:(.+)$/, adminOnly(async ctx => {
    const id = ctx.match[1], e = getEvent(id); if (!e) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
    db.prepare(`UPDATE events SET status = 'approved', reject_reason = NULL WHERE id = ?`).run(id);
    const m = getMaster(e.masterId); if (m) send(m.tgId, `Событие «${html(e.title)}» опубликовано в афише`);
    return done(ctx, '✅ Одобрено');
  }));
  bot.callbackQuery(/^as:(.+)$/, adminOnly(async ctx => {
    const sl = getSalon(ctx.match[1]); if (!sl) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
    db.prepare(`UPDATE salons SET status = 'approved', reject_reason = NULL WHERE id = ?`).run(sl.id);
    send(sl.ownerTg, `<b>Салон «${html(sl.name)}» опубликован.</b>\nПригласи мастеров по ссылке из кабинета салона.`, WEBAPP_URL ? new InlineKeyboard().webApp('Открыть кабинет салона', appUrl('salonadmin=1')) : undefined);
    return done(ctx, '✅ Одобрено');
  }));
  bot.callbackQuery(/^(rm|re|rs):(.+)$/, adminOnly(async ctx => {
    const [, kind, id] = ctx.match, kb = new InlineKeyboard();
    REJECT_REASONS.forEach((r, i) => kb.text(r, `rr:${kind === 'rm' ? 'm' : kind === 'rs' ? 's' : 'e'}:${id}:${i}`).row());
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    return ctx.answerCallbackQuery({ text: 'Выбери причину' });
  }));
  bot.callbackQuery(/^rr:(m|e|s):(.+):(\d)$/, adminOnly(async ctx => {
    const [, kind, id, n] = ctx.match, reason = REJECT_REASONS[+n] || REJECT_REASONS[0];
    if (kind === 's') {
      const sl = getSalon(id); if (!sl) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
      db.prepare(`UPDATE salons SET status = 'rejected', reject_reason = ? WHERE id = ?`).run(reason, id);
      send(sl.ownerTg, `Страницу салона нужно поправить: <b>${html(reason)}</b>\nОткрой кабинет салона, внеси правки и сохрани — она снова уйдёт на проверку.`);
      return done(ctx, '❌ Отклонено');
    }
    if (kind === 'm') {
      const m = getMaster(id); if (!m) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
      db.prepare(`UPDATE masters SET status = 'rejected', reject_reason = ? WHERE id = ?`).run(reason, id);
      send(m.tgId, `Страницу нужно поправить: <b>${html(reason)}</b>\n\nОткрой кабинет → «Услуги и профиль», внеси правки и сохрани — страница снова уйдёт на проверку.`, WEBAPP_URL ? new InlineKeyboard().webApp('Открыть кабинет', WEBAPP_URL) : undefined);
    } else {
      const e = getEvent(id); if (!e) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
      db.prepare(`UPDATE events SET status = 'rejected', reject_reason = ? WHERE id = ?`).run(reason, id);
      const m = getMaster(e.masterId); if (m) send(m.tgId, `Событие «${html(e.title)}» не прошло проверку: <b>${html(reason)}</b>\nМожно создать его заново с правками.`);
    }
    return done(ctx, '❌ Отклонено');
  }));
  bot.callbackQuery(/^c(h|k|b):(\d+)$/, adminOnly(async ctx => {
    const [, act, cid] = ctx.match, c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(+cid);
    if (!c) return ctx.answerCallbackQuery({ text: 'Жалоба не найдена' });
    const table = c.target_type === 'event' ? 'events' : 'masters';
    const isRv = c.target_type === 'review';
    if (act === 'h') isRv ? db.prepare('UPDATE reviews SET hidden = 1 WHERE id = ?').run(c.target_id) : db.prepare(`UPDATE ${table} SET status = 'hidden' WHERE id = ?`).run(c.target_id);
    if (act === 'k') isRv ? db.prepare('UPDATE reviews SET hidden = 0 WHERE id = ? AND hidden = 1').run(c.target_id) : db.prepare(`UPDATE ${table} SET status = 'approved' WHERE id = ? AND status = 'hidden'`).run(c.target_id);
    if (act === 'b') {
      const owner = ownerOf(c.target_type, c.target_id);
      if (owner && owner.tgId) {
        db.prepare('UPDATE users SET blocked = 1 WHERE tg_id = ?').run(owner.tgId);
        db.prepare(`UPDATE masters SET status = 'hidden' WHERE tg_id = ?`).run(owner.tgId);
        db.prepare(`UPDATE events SET status = 'hidden' WHERE master_id = ?`).run(owner.id);
        if (isRv) db.prepare('UPDATE reviews SET hidden = 1 WHERE id = ?').run(c.target_id);
      } else if (!isRv) db.prepare(`UPDATE ${table} SET status = 'hidden' WHERE id = ?`).run(c.target_id);
    }
    db.prepare('UPDATE complaints SET resolved = 1 WHERE target_type = ? AND target_id = ?').run(c.target_type, c.target_id);
    return done(ctx, { h: '🙈 Скрыто', k: '👌 Оставлено', b: '⛔ Заблокирован' }[act]);
  }));
  bot.callbackQuery(/^r(a|d):([\w-]+)$/, adminOnly(async ctx => {
    const [, act, id] = ctx.match;
    if (act === 'a') db.prepare('UPDATE reviews SET hidden = 0 WHERE id = ?').run(id); else db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
    return done(ctx, act === 'a' ? '✅ Опубликуется в срок' : '🗑 Удалён');
  }));
  bot.callbackQuery(/^va:([\w-]+)$/, adminOnly(async ctx => {
    db.prepare('UPDATE bookings SET attended = 1 WHERE id = ?').run(ctx.match[1]);
    return done(ctx, 'Неявка снята');
  }));

  // обычные сообщения: переписка по записи или ответ на отзыв
  bot.on('message:text', async ctx => {
    const tg = ctx.from.id, text = ctx.message.text;
    if (text.startsWith('/')) return ctx.reply('Не знаю такой команды. Есть /start, /bookings и /privacy.');
    if (replyMode.has(tg)) {
      const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(replyMode.get(tg)); replyMode.delete(tg);
      if (r && !r.reply) { db.prepare('UPDATE reviews SET reply = ?, reply_at = ? WHERE id = ?').run(text.slice(0, 600), nowIso(), r.id); return ctx.reply('Ответ опубликован ✓'); }
    }
    let bookingId = null;
    const rt = ctx.message.reply_to_message;
    if (rt) { const map = db.prepare('SELECT booking_id FROM relay WHERE chat_id = ? AND message_id = ?').get(tg, rt.message_id); if (map) bookingId = map.booking_id; }
    const mode = chatMode.get(tg);
    if (!bookingId && mode && mode.until > Date.now()) bookingId = mode.bookingId;
    if (!bookingId) return ctx.reply('Чтобы написать мастеру или клиенту, нажми «Написать» у записи — в закрепе сверху или в сообщении о записи.', WEBAPP_URL ? { reply_markup: new InlineKeyboard().webApp('Открыть Ari', WEBAPP_URL) } : undefined);
    const ok = await relayMessage(tg, getBooking(bookingId), text);
    if (!ok) return ctx.reply('Переписка по этой записи уже закрыта.');
    if (mode) mode.until = Date.now() + 15 * 6e4;
    bot.api.setMessageReaction(tg, ctx.message.message_id, [{ type: 'emoji', emoji: '👍' }]).catch(() => ctx.reply('Передал ✓'));
  });
  bot.on('message', ctx => ctx.reply('Пока я умею передавать только текстовые сообщения.'));
  bot.catch(e => console.error('bot error', e.message));
}

/* ---------- напоминания: проверка раз в минуту ---------- */
let lastCleanup = '';
function tick() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM bookings WHERE status = 'active' AND date BETWEEN ? AND ?`).all(dk(now - 3 * 864e5), dk(now + 2 * 864e5));
  const mark = (id, col) => db.prepare(`UPDATE bookings SET ${col} = 1 WHERE id = ?`).run(id);
  for (const b of rows) {
    const m = getMaster(b.master_id); if (!m) continue;
    const st = startTs(b.date, b.time), cr = Date.parse(b.created_at), left = st - now, w = html(what(b, m));
    if (b.client_tg) {
      if (!b.r24 && left <= 864e5 && left > 2 * 36e5 && cr < st - 864e5) {
        mark(b.id, 'r24');
        const kb = new InlineKeyboard().text('Буду ✓', 'c:' + b.id);
        if (!b.event_id) kb.webApp('Перенести', appUrl('move=' + b.id));
        kb.text('Отменить', 'x:' + b.id);
        send(b.client_tg, `Завтра в ${b.time}${addrOf(m) ? ' · ' + html(addrOf(m)) : ''}\n${w}, ${html(m.name)}\n\nВсё в силе?`, kb);
      }
      if (!b.r2 && left <= 2 * 36e5 && left > 0 && cr < st - 2 * 36e5) {
        mark(b.id, 'r2');
        const kb = new InlineKeyboard();
        if (!b.r24 && !b.confirmed) kb.text('Буду ✓', 'c:' + b.id);
        kb.url('Маршрут', mapUrl(m));
        if (!b.r24) kb.text('Отменить', 'x:' + b.id);
        send(b.client_tg, `Через 2 часа, в ${b.time}${addrOf(m) ? ' · ' + html(addrOf(m)) : ''}\n${w}, ${html(m.name)}${placeOf(m).entrance ? '\nКак найти вход: ' + html(placeOf(m).entrance) : ''}`, kb);
      }
      if (!b.rrate && !b.event_id && b.attended !== 0 && now >= st + (b.dur + 60) * 6e4 && now < st + 3 * 864e5) {
        mark(b.id, 'rrate');
        const kb = new InlineKeyboard();
        [1, 2, 3, 4, 5].forEach(i => kb.text('★'.repeat(i), `r:${b.id}:${i}`).row());
        send(b.client_tg, `Как всё прошло? ${w}, ${html(m.name)}.\nОценка займёт секунду:`, kb);
      }
    }
    if (m.tgId && b.client_tg && !b.rv && b.attended === null && !b.event_id && now >= st + b.dur * 6e4 && now < st + 2 * 864e5) {
      mark(b.id, 'rv');
      send(m.tgId, `Как прошёл визит? ${html(b.client_name)}, ${b.time} · ${w}`, new InlineKeyboard().text('Пришёл', `v:${b.id}:1`).text('Не пришёл', `v:${b.id}:0`));
    }
    if (m.tgId && !b.rm && left <= 36e5 && left > 0 && cr < st - 36e5) {
      mark(b.id, 'rm');
      send(m.tgId, `Через час: ${html(b.client_name)}, ${w}${b.confirmed ? '. Клиент подтвердил визит ✓' : ''}`);
    }
  }
  // утренний дайджест мастеру в 9:00
  if (new Date().getHours() === 9) {
    const today = dk(now);
    for (const r of db.prepare('SELECT * FROM masters WHERE tg_id IS NOT NULL').all()) {
      if (db.prepare('SELECT 1 FROM digests WHERE master_id = ? AND date = ?').get(r.id, today)) continue;
      const list = db.prepare(`SELECT * FROM bookings WHERE master_id = ? AND date = ? AND status = 'active' ORDER BY time`).all(r.id, today);
      db.prepare('INSERT INTO digests (master_id, date) VALUES (?, ?)').run(r.id, today);
      if (list.length) send(r.tg_id, `Доброе утро. Записей сегодня: ${list.length}\n` + list.map(b => `${b.time} — ${html(b.client_name)}`).join('\n'));
    }
  }
  // публикация отзывов: сообщаем мастеру
  for (const r of db.prepare('SELECT * FROM reviews WHERE notified = 0 AND hidden = 0 AND publish_at <= ?').all(nowIso())) {
    db.prepare('UPDATE reviews SET notified = 1 WHERE id = ?').run(r.id);
    const m = getMaster(r.master_id); if (!m) continue;
    const tags = JSON.parse(r.tags || '[]');
    send(m.tgId, `<b>Новый отзыв</b> ${'★'.repeat(r.rating)}\n${tags.length ? html(tags.join(' · ')) + '\n' : ''}${r.text ? '«' + html(r.text) + '»\n' : ''}— ${r.anon ? 'Анонимно' : html(r.display_name || 'Клиент')}`, r.text ? new InlineKeyboard().text('Ответить публично', 'rv:' + r.id) : undefined);
  }
  syncAllIcal().catch(() => {});
  backup();
  // раз в сутки: удаляем записи старше года (срок хранения из политики)
  const today = dk(now);
  if (lastCleanup !== today) {
    lastCleanup = today;
    db.prepare('DELETE FROM bookings WHERE date < ?').run(dk(now - 365 * 864e5));
    db.prepare('DELETE FROM digests WHERE date < ?').run(dk(now - 7 * 864e5));
    db.prepare('DELETE FROM messages WHERE created_at < ?').run(new Date(now - 30 * 864e5).toISOString()); // переписку храним 30 дней
    db.prepare('DELETE FROM relay WHERE created_at < ?').run(new Date(now - 30 * 864e5).toISOString());
    pinOffset.clear();
    db.prepare('SELECT tg_id FROM users WHERE pin_msg_id IS NOT NULL').all().forEach((u, i) => setTimeout(() => updatePin(u.tg_id), i * 100)); // обновить «сегодня/завтра»
  }
}

/* ---------- проверка входа из Telegram ---------- */
function checkInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 7 * 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------- API ---------- */
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res, next) => {
  let u = checkInitData(req.get('X-Init-Data'));
  if (!u && DEV_TG_ID && process.env.NODE_ENV !== 'production') u = { id: Number(DEV_TG_ID), first_name: 'Тест' };
  if (!u) return res.status(401).json({ error: 'Открой приложение через бота в Telegram' });
  req.tg = u;
  const row = getUser(u.id);
  if (row && row.blocked && req.method !== 'GET' && !(req.method === 'DELETE' && req.path === '/me')) return res.status(403).json({ error: 'Аккаунт заблокирован. Если это ошибка, напиши в поддержку' });
  next();
});
const route = fn => (req, res) => { try { res.json(fn(req) || { ok: true }); } catch (e) { res.status(e.code || 500).json({ error: e.code ? e.message : 'Ошибка сервера' }); if (!e.code) console.error(e); } };
const requireUser = req => getUser(req.tg.id) || fail(403, 'Сначала заверши регистрацию');

app.get('/api/bootstrap', route(req => {
  const uid = req.tg.id, u = getUser(uid), my = masterOf(uid);
  const me = u
    ? { name: u.name, phone: u.phone || '', consent: u.consent_at, tourist: !!u.tourist, joined: true, no: u.no, since: u.joined_at }
    : { name: [req.tg.first_name, req.tg.last_name].filter(Boolean).join(' '), phone: pendingPhone.get(uid) || '', joined: false };
  const admin = isAdmin(uid);
  const salonRows = db.prepare('SELECT * FROM salons').all();
  const mySalonRow = salonRows.find(r => r.owner_tg === uid) || (my && my.salonId !== undefined ? null : null) || (my && salonRows.find(r => r.id === (db.prepare('SELECT salon_id FROM masters WHERE id = ?').get(my.id) || {}).salon_id));
  const myRole = !mySalonRow ? null : mySalonRow.owner_tg === uid ? 'owner' : (db.prepare('SELECT salon_role FROM masters WHERE id = ?').get(my.id).salon_role || 'master');
  const liveSalons = new Set(salonRows.filter(r => r.status === 'approved').map(r => r.id));
  const masters = db.prepare('SELECT * FROM masters').all().filter(r => (r.status === 'approved' && (!r.salon_id || liveSalons.has(r.salon_id))) || r.tg_id === uid || (mySalonRow && r.salon_id === mySalonRow.id && myRole !== 'master')).map(publicMaster);
  const salons = salonRows.filter(r => r.status === 'approved' || (mySalonRow && r.id === mySalonRow.id)).map(publicSalon).map(sl => ({ ...sl, members: masters.filter(m => m.salonId === sl.id && m.status === 'approved').map(m => m.id) }));
  const myMasterIds = new Set(my ? [my.id] : []);
  if (mySalonRow && myRole !== 'master') db.prepare('SELECT id FROM masters WHERE salon_id = ?').all(mySalonRow.id).forEach(r => myMasterIds.add(r.id));
  const busyRows = db.prepare('SELECT master_id, date, start_min, end_min FROM busy WHERE date >= ? AND date <= ?').all(dk(Date.now()), dk(Date.now() + 30 * 864e5))
    .map(x => ({ masterId: x.master_id, date: x.date, time: toTime(x.start_min), dur: x.end_min - x.start_min }));
  const visible = new Set(masters.filter(m => m.status === 'approved').map(m => m.id));
  const events = db.prepare('SELECT * FROM events WHERE date >= ?').all(dk(Date.now() - 864e5))
    .filter(r => (r.status === 'approved' && visible.has(r.master_id)) || (my && r.master_id === my.id))
    .map(r => ({ ...JSON.parse(r.data), id: r.id, masterId: r.master_id, date: r.date, time: r.time, status: r.status, rejectReason: r.reject_reason || undefined }));
  const bookings = db.prepare('SELECT * FROM bookings WHERE date >= ?').all(dk(Date.now() - 180 * 864e5))
    .filter(b => b.status === 'active' || b.client_tg === uid || myMasterIds.has(b.master_id))
    .map(b => bookingOut(b, uid, myMasterIds));
  if (u) me.notifyLaunch = !!u.notify_launch;
  const mySalon = mySalonRow ? { id: mySalonRow.id, role: myRole, status: mySalonRow.status, rejectReason: mySalonRow.reject_reason || undefined, invite: myRole !== 'master' ? mySalonRow.invite : undefined } : null;
  const waits = u ? db.prepare('SELECT master_id, date FROM waitlist WHERE client_tg = ? AND notified = 0').all(uid).map(w => w.master_id + '|' + (w.date || '')) : [];
  return { me, masters, events, bookings, salons, mySalon, busy: busyRows, waits, botUsername: bot && bot.botInfo ? bot.botInfo.username : '', myMasterId: my ? my.id : null, isAdmin: admin };
}));

app.post('/api/me', route(req => {
  const b = req.body || {}, uid = req.tg.id, u = getUser(uid);
  if (!u && !b.consent) return { ok: true, stored: false }; // без согласия ничего не храним
  const name = str(b.name, 60) || (u && u.name) || req.tg.first_name || 'Гость';
  let phone = str(b.phone, 20) || pendingPhone.get(uid) || (u && u.phone) || '';
  if (phone && phone.replace(/\D/g, '').length < 8) fail(400, 'Проверь номер телефона');
  if (u) db.prepare('UPDATE users SET name = ?, phone = ?, tourist = ? WHERE tg_id = ?').run(name, phone, b.tourist ? 1 : 0, uid);
  else db.prepare('INSERT INTO users (tg_id, name, phone, tourist, consent_at, joined_at, no) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid, name, phone, b.tourist ? 1 : 0, nowIso(), nowIso(), 1000 + db.prepare('SELECT COUNT(*) n FROM users').get().n + 1);
  pendingPhone.delete(uid);
}));

app.delete('/api/me', route(req => {
  const uid = req.tg.id, my = masterOf(uid);
  // будущие записи отменяем, прошлые обезличиваем
  db.prepare(`SELECT * FROM bookings WHERE client_tg = ? AND status = 'active' AND date >= ?`).all(uid, dk(Date.now())).forEach(b => {
    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(nowIso(), b.id);
    notify('cancelledByClient', { ...b, client_tg: null });
  });
  db.prepare(`UPDATE bookings SET client_tg = NULL, client_name = 'Удалённый пользователь' WHERE client_tg = ?`).run(uid);
  if (my) {
    db.prepare(`SELECT * FROM bookings WHERE master_id = ? AND status = 'active' AND date >= ?`).all(my.id, dk(Date.now())).forEach(b => notify('cancelledByMaster', b));
    db.prepare('DELETE FROM bookings WHERE master_id = ?').run(my.id);
    db.prepare('DELETE FROM events WHERE master_id = ?').run(my.id);
    db.prepare('DELETE FROM masters WHERE id = ?').run(my.id);
  }
  db.prepare('DELETE FROM users WHERE tg_id = ?').run(uid);
  pendingPhone.delete(uid);
}));

app.post('/api/masters', route(req => {
  const b = req.body || {}, uid = req.tg.id;
  if (masterOf(uid)) fail(400, 'У тебя уже есть страница мастера');
  if (!b.agree) fail(400, 'Нужно принять оферту');
  const data = cleanMaster(b);
  if (!getUser(uid)) db.prepare('INSERT INTO users (tg_id, name, phone, tourist, consent_at, joined_at, no) VALUES (?, ?, ?, 0, ?, ?, ?)').run(uid, data.name, pendingPhone.get(uid) || '', nowIso(), nowIso(), 1000 + db.prepare('SELECT COUNT(*) n FROM users').get().n + 1);
  const id = isId(b.id) && !getMaster(b.id) ? b.id : 'm_' + rid();
  db.prepare(`INSERT INTO masters (id, tg_id, data, plan, status, created_at) VALUES (?, ?, ?, 'free', 'pending', ?)`).run(id, uid, JSON.stringify({ ...data, rating: 0, reviews: 0 }), nowIso());
  toModeration('master', id);
  return { ok: true, id };
}));

app.patch('/api/masters/me', route(req => {
  const my = masterOf(req.tg.id) || fail(404, 'Страница мастера не найдена');
  const body = { ...req.body };
  ['photo', 'entrancePhoto'].forEach(k => { if (typeof body[k] === 'string' && body[k].startsWith('/img/')) delete body[k]; });
  const data = cleanMaster({ ...my, ...body });
  const row = db.prepare('SELECT status FROM masters WHERE id = ?').get(my.id);
  db.prepare('UPDATE masters SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, rating: my.rating || 0, reviews: my.reviews || 0 }), my.id);
  // отклонённую страницу после правок отправляем на повторную проверку; одобренную — только если появились стоп-слова
  const hit = flagged(data.name, data.about, data.services.map(s => s.name).join(' '));
  if (row.status === 'rejected' || (row.status === 'approved' && hit)) {
    db.prepare(`UPDATE masters SET status = 'pending', reject_reason = NULL WHERE id = ?`).run(my.id);
    toModeration('master', my.id);
  }
}));

app.post('/api/events', route(req => {
  const my = masterOf(req.tg.id) || fail(403, 'События создают мастера');
  const b = req.body || {};
  const title = str(b.title, 100) || fail(400, 'Добавь название');
  if (!isDate(b.date) || !isTime(b.time) || startTs(b.date, b.time) < Date.now()) fail(400, 'Проверь дату и время');
  const id = isId(b.id) && !getEvent(b.id) ? b.id : 'e_' + rid();
  const kind = EVENT_KINDS.includes(b.kind) ? b.kind : (my.cat === 'tour' ? 'tour' : 'workshop');
  const langs = (Array.isArray(b.langs) ? b.langs : ['ru']).filter(l => ['ru', 'en', 'hy'].includes(l));
  const data = { title, dur: int(b.dur, 15, 720, 90), price: int(b.price, 0, 1e7, 0), places: int(b.places, 1, 500, 10), desc: str(b.desc, 600) || 'Подробности у ведущего.', kind, langs: langs.length ? langs : ['ru'], tourist: kind === 'tour' || my.cat === 'tour' };
  const trusted = my.status === 'approved' && db.prepare(`SELECT COUNT(*) n FROM events WHERE master_id = ? AND status = 'approved'`).get(my.id).n >= 3
    && !db.prepare(`SELECT 1 FROM complaints WHERE resolved = 0 AND ((target_type = 'master' AND target_id = ?) OR (target_type = 'event' AND target_id IN (SELECT id FROM events WHERE master_id = ?)))`).get(my.id, my.id);
  const hit = flagged(data.title, data.desc);
  const status = trusted && !hit ? 'approved' : 'pending';
  db.prepare('INSERT INTO events (id, master_id, date, time, data, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, my.id, b.date, b.time, JSON.stringify(data), status, nowIso());
  if (status === 'pending') toModeration('event', id);
  return { ok: true, id, status };
}));

app.post('/api/bookings', route(req => {
  const b = req.body || {}, uid = req.tg.id;
  const id = isId(b.id) && !getBooking(b.id) ? b.id : 'b_' + rid();
  const my = masterOf(uid);
  let row;
  if (b.salonId && !b.masterId && b.source !== 'manual') {
    const u = requireUser(req);
    const sal = getSalon(b.salonId); if (!sal || sal.status !== 'approved') fail(404, 'Салон не найден');
    if (!isDate(b.date) || !isTime(b.time)) fail(400, 'Проверь дату и время');
    const name = str(b.serviceName, 60).toLowerCase();
    const cands = db.prepare(`SELECT id FROM masters WHERE salon_id = ? AND status = 'approved'`).all(sal.id).map(r => getMaster(r.id))
      .map(m => ({ m, s: (m.services || []).find(x => x.name.toLowerCase() === name) })).filter(x => x.s && slotFree(x.m, b.date, b.time, x.s.dur))
      .sort((x, y) => db.prepare(`SELECT COUNT(*) n FROM bookings WHERE master_id = ? AND date = ? AND status = 'active'`).get(x.m.id, b.date).n - db.prepare(`SELECT COUNT(*) n FROM bookings WHERE master_id = ? AND date = ? AND status = 'active'`).get(y.m.id, b.date).n);
    if (!cands.length) fail(409, 'Это время только что заняли — выбери другое');
    const { m, s: sv } = cands[0];
    db.prepare(`INSERT INTO bookings (id, master_id, service_id, event_id, client_tg, client_name, date, time, dur, source, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'salon', ?)`).run(id, m.id, sv.id, uid, u.name, b.date, b.time, sv.dur, nowIso());
    notify('created', getBooking(id));
    return { ok: true, id, masterId: m.id };
  }
  if (b.source === 'manual') {
    const target = getMaster(b.masterId);
    const salonAdmin = target && my && target.salonId !== undefined ? false : false;
    const canManage = target && ((my && my.id === target.id) || isSalonManager(uid, target.id));
    if (!canManage) fail(403, 'Добавлять записи вручную может только мастер или администратор салона');
    const s = target.services.find(x => x.id === b.serviceId) || fail(400, 'Услуга не найдена');
    if (!isDate(b.date) || !isTime(b.time)) fail(400, 'Проверь дату и время');
    if (!slotFree({ ...target, schedule: { days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 24 } }, b.date, b.time, s.dur)) fail(409, 'Это время уже занято или прошло');
    row = { id, master_id: target.id, service_id: s.id, event_id: null, client_tg: null, client_name: str(b.clientName, 60) || fail(400, 'Кто клиент?'), date: b.date, time: b.time, dur: s.dur, source: 'manual' };
  } else if (b.eventId) {
    const u = requireUser(req);
    const e = getEvent(b.eventId) || fail(404, 'Событие не найдено');
    if (db.prepare('SELECT status FROM events WHERE id = ?').get(e.id).status !== 'approved') fail(403, 'Событие пока недоступно для записи');
    if (startTs(e.date, e.time) < Date.now()) fail(400, 'Событие уже прошло');
    const taken = db.prepare(`SELECT COUNT(*) n FROM bookings WHERE event_id = ? AND status = 'active'`).get(e.id).n;
    if (taken >= e.places) fail(409, 'Мест больше нет');
    if (db.prepare(`SELECT 1 FROM bookings WHERE event_id = ? AND client_tg = ? AND status = 'active'`).get(e.id, uid)) fail(409, 'Эта запись у тебя уже есть');
    row = { id, master_id: e.masterId, service_id: null, event_id: e.id, client_tg: uid, client_name: u.name, date: e.date, time: e.time, dur: e.dur || 90, source: 'afisha' };
  } else {
    const u = requireUser(req);
    const m = getMaster(b.masterId) || fail(404, 'Мастер не найден');
    if (db.prepare('SELECT status FROM masters WHERE id = ?').get(m.id).status !== 'approved' && m.tgId !== uid) fail(403, 'Мастер пока недоступен для записи');
    const s = (m.services || []).find(x => x.id === b.serviceId) || fail(400, 'Услуга не найдена');
    if (!isDate(b.date) || !isTime(b.time) || !slotFree(m, b.date, b.time, s.dur)) fail(409, 'Это время только что заняли — выбери другое');
    row = { id, master_id: m.id, service_id: s.id, event_id: null, client_tg: uid, client_name: u.name, date: b.date, time: b.time, dur: s.dur, source: b.source === 'afisha' ? 'afisha' : 'catalog' };
  }
  db.prepare(`INSERT INTO bookings (id, master_id, service_id, event_id, client_tg, client_name, date, time, dur, source, created_at)
    VALUES (@id, @master_id, @service_id, @event_id, @client_tg, @client_name, @date, @time, @dur, @source, @created_at)`).run({ ...row, created_at: nowIso() });
  if (row.source !== 'manual') notify('created', getBooking(id));
  return { ok: true, id };
}));

const ownBooking = (req, forMaster) => {
  const b = getBooking(req.params.id) || fail(404, 'Запись не найдена');
  const my = masterOf(req.tg.id);
  const isClient = b.client_tg === req.tg.id, isMaster = (my && my.id === b.master_id) || isSalonManager(req.tg.id, b.master_id);
  if (!(isClient || (forMaster && isMaster))) fail(403, 'Это не твоя запись');
  return { b, isClient, isMaster };
};
app.post('/api/bookings/:id/move', route(req => {
  const { b } = ownBooking(req);
  if (b.event_id || b.status !== 'active') fail(400, 'Эту запись нельзя перенести');
  const m = getMaster(b.master_id);
  if (!isDate(req.body.date) || !isTime(req.body.time) || !slotFree(m, req.body.date, req.body.time, b.dur, b.id)) fail(409, 'Это время только что заняли — выбери другое');
  db.prepare('UPDATE bookings SET date = ?, time = ?, moved_at = ?, confirmed = 0, r24 = 0, r2 = 0, rm = 0 WHERE id = ?').run(req.body.date, req.body.time, nowIso(), b.id);
  notify('moved', getBooking(b.id));
  freedSlot(b);
}));
app.post('/api/bookings/:id/cancel', route(req => {
  const { b, isClient } = ownBooking(req, true);
  if (b.status !== 'active') return;
  db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(nowIso(), b.id);
  notify(isClient ? 'cancelledByClient' : 'cancelledByMaster', getBooking(b.id));
  freedSlot(b);
}));
app.post('/api/bookings/:id/confirm', route(req => {
  const { b } = ownBooking(req);
  if (b.status !== 'active' || b.confirmed) return;
  db.prepare('UPDATE bookings SET confirmed = 1, confirmed_at = ? WHERE id = ?').run(nowIso(), b.id);
  notify('confirmed', getBooking(b.id));
}));
app.post('/api/bookings/:id/rate', route(req => {
  const { b } = ownBooking(req);
  const why = canReview(b, req.tg.id); if (why) fail(400, why);
  if (!db.prepare('SELECT 1 FROM reviews WHERE booking_id = ?').get(b.id)) saveReview(req.tg.id, b, { rating: req.body.v, anon: true });
}));
app.post('/api/reviews', route(req => {
  const b = getBooking(req.body.bookingId);
  const why = canReview(b, req.tg.id); if (why) fail(400, why);
  saveReview(req.tg.id, b, req.body);
}));
app.post('/api/bookings/:id/chat', async (req, res) => {
  try {
    const b = getBooking(req.params.id);
    if (!bot) return res.status(503).json({ error: 'Бот сейчас недоступен' });
    const err = await startChat(req.tg.id, b);
    if (err) return res.status(400).json({ error: err });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/complaints', route(req => {
  const uid = req.tg.id, b = req.body || {};
  requireUser(req);
  const type = ['event', 'review'].includes(b.type) ? b.type : 'master';
  const exists = db.prepare(`SELECT 1 FROM ${type === 'event' ? 'events' : type === 'review' ? 'reviews' : 'masters'} WHERE id = ?`).get(b.id);
  if (!exists) fail(404, 'Не найдено');
  const reason = str(b.reason, 300) || 'Без причины';
  const r = db.prepare('INSERT OR IGNORE INTO complaints (target_type, target_id, from_tg, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(type, b.id, uid, reason, nowIso());
  if (!r.changes) return { ok: true, duplicate: true };
  const n = db.prepare('SELECT COUNT(*) n FROM complaints WHERE target_type = ? AND target_id = ? AND resolved = 0').get(type, b.id).n;
  if (n >= 3) { if (type === 'review') db.prepare('UPDATE reviews SET hidden = 1 WHERE id = ?').run(b.id); else db.prepare(`UPDATE ${type === 'event' ? 'events' : 'masters'} SET status = 'hidden' WHERE id = ? AND status = 'approved'`).run(b.id); }
  notifyComplaint(r.lastInsertRowid, n);
}));

app.post('/api/notify-launch', route(req => {
  requireUser(req);
  db.prepare('UPDATE users SET notify_launch = 1 WHERE tg_id = ?').run(req.tg.id);
}));

/* ---------- салоны ---------- */
function isSalonManager(tg, masterId) {
  const r = db.prepare('SELECT salon_id FROM masters WHERE id = ?').get(masterId); if (!r || !r.salon_id) return false;
  const sl = db.prepare('SELECT owner_tg FROM salons WHERE id = ?').get(r.salon_id); if (!sl) return false;
  if (sl.owner_tg === tg) return true;
  const me = db.prepare('SELECT salon_id, salon_role FROM masters WHERE tg_id = ?').get(tg);
  return !!(me && me.salon_id === r.salon_id && me.salon_role === 'admin');
}
function mySalonOf(tg) {
  const own = db.prepare('SELECT id FROM salons WHERE owner_tg = ?').get(tg);
  if (own) return { id: own.id, role: 'owner' };
  const me = db.prepare('SELECT salon_id, salon_role FROM masters WHERE tg_id = ?').get(tg);
  return me && me.salon_id ? { id: me.salon_id, role: me.salon_role || 'master' } : null;
}
function publicSalon(r) {
  const sl = { ...JSON.parse(r.data), id: r.id, status: r.status };
  sl.photos = (sl.photos || []).map((p, i) => imgUrl('s', r.id, 'g' + i, p)).filter(Boolean);
  sl.entrancePhoto = imgUrl('s', r.id, 'entrancePhoto', sl.entrancePhoto);
  return sl;
}
function cleanSalon(b, prev = {}) {
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 6).map((p, i) => {
    if (typeof p === 'string' && p.startsWith('/img/')) { const m = p.match(/\/g(\d)\?/); return m && prev.photos ? prev.photos[+m[1]] || '' : ''; }
    return okImg(p);
  }).filter(Boolean);
  const entrancePhoto = typeof b.entrancePhoto === 'string' && b.entrancePhoto.startsWith('/img/') ? prev.entrancePhoto || '' : b.entrancePhoto;
  const out = { name: str(b.name, 60), cat: CATS.includes(b.cat) ? b.cat : 'beauty', about: str(b.about, 600), area: str(b.area, 40), address: str(b.address, 120), hours: str(b.hours, 120), photos, ...cleanPlace({ ...b, entrancePhoto }) };
  if (!out.name) fail(400, 'Как называется салон?');
  if (!out.address) fail(400, 'Укажи адрес салона');
  return out;
}
app.post('/api/salons', route(req => {
  const uid = req.tg.id, b = req.body || {};
  if (db.prepare('SELECT 1 FROM salons WHERE owner_tg = ?').get(uid)) fail(400, 'У тебя уже есть салон');
  if (!b.agree) fail(400, 'Нужно принять оферту');
  const data = cleanSalon(b);
  if (!getUser(uid)) db.prepare('INSERT INTO users (tg_id, name, phone, tourist, consent_at, joined_at, no) VALUES (?, ?, ?, 0, ?, ?, ?)').run(uid, str(b.ownerName, 60) || req.tg.first_name || 'Владелец', pendingPhone.get(uid) || '', nowIso(), nowIso(), 1000 + db.prepare('SELECT COUNT(*) n FROM users').get().n + 1);
  const id = 's_' + rid();
  db.prepare(`INSERT INTO salons (id, owner_tg, data, status, invite, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`).run(id, uid, JSON.stringify(data), crypto.randomBytes(6).toString('hex'), nowIso());
  const my = masterOf(uid);
  if (my && b.joinAsMaster) db.prepare(`UPDATE masters SET salon_id = ?, salon_role = 'admin' WHERE id = ?`).run(id, my.id);
  toModeration('salon', id);
  return { ok: true, id };
}));
app.patch('/api/salons/mine', route(req => {
  const ms = mySalonOf(req.tg.id); if (!ms || ms.role === 'master') fail(403, 'Редактировать салон может владелец или администратор');
  const r = db.prepare('SELECT * FROM salons WHERE id = ?').get(ms.id), prev = JSON.parse(r.data);
  const data = cleanSalon({ ...prev, ...req.body }, prev);
  db.prepare('UPDATE salons SET data = ? WHERE id = ?').run(JSON.stringify(data), ms.id);
  const hit = flagged(data.name, data.about);
  if (r.status === 'rejected' || (r.status === 'approved' && (hit || data.photos.length > (prev.photos || []).length))) {
    db.prepare(`UPDATE salons SET status = 'pending', reject_reason = NULL WHERE id = ?`).run(ms.id);
    toModeration('salon', ms.id);
  }
}));
app.get('/api/salons/invite/:code', route(req => {
  const r = db.prepare('SELECT id, data FROM salons WHERE invite = ?').get(req.params.code) || fail(404, 'Приглашение не найдено или устарело');
  return { id: r.id, name: JSON.parse(r.data).name };
}));
app.post('/api/salons/join', route(req => {
  const r = db.prepare('SELECT * FROM salons WHERE invite = ?').get(str(req.body.code, 40)) || fail(404, 'Приглашение не найдено или устарело');
  const my = masterOf(req.tg.id) || fail(400, 'Сначала создай страницу мастера');
  db.prepare(`UPDATE masters SET salon_id = ?, salon_role = 'master' WHERE id = ?`).run(r.id, my.id);
  send(r.owner_tg, `<b>${html(my.name)}</b> присоединился(ась) к салону «${html(JSON.parse(r.data).name)}».`);
  return { ok: true, salonId: r.id };
}));
app.post('/api/salons/leave', route(req => {
  const my = masterOf(req.tg.id) || fail(400, 'Нет страницы мастера');
  db.prepare('UPDATE masters SET salon_id = NULL, salon_role = NULL WHERE id = ?').run(my.id);
}));
app.post('/api/salons/members/:id', route(req => {
  const ms = mySalonOf(req.tg.id); if (!ms || ms.role === 'master') fail(403, 'Недостаточно прав');
  const m = db.prepare('SELECT * FROM masters WHERE id = ? AND salon_id = ?').get(req.params.id, ms.id) || fail(404, 'Мастер не в твоём салоне');
  const act = req.body.action;
  if (act === 'remove') { db.prepare('UPDATE masters SET salon_id = NULL, salon_role = NULL WHERE id = ?').run(m.id); send(m.tg_id, 'Тебя убрали из команды салона. Твоя личная страница мастера продолжает работать.'); }
  else if (act === 'admin' || act === 'master') { if (ms.role !== 'owner') fail(403, 'Назначать администраторов может только владелец'); db.prepare('UPDATE masters SET salon_role = ? WHERE id = ?').run(act, m.id); }
  else fail(400, 'Неизвестное действие');
}));
app.post('/api/salons/invite/reset', route(req => {
  const ms = mySalonOf(req.tg.id); if (!ms || ms.role !== 'owner') fail(403, 'Только владелец');
  const code = crypto.randomBytes(6).toString('hex');
  db.prepare('UPDATE salons SET invite = ? WHERE id = ?').run(code, ms.id);
  return { ok: true, invite: code };
}));

/* ---------- лист ожидания ---------- */
app.post('/api/waitlist', route(req => {
  requireUser(req);
  const m = getMaster(req.body.masterId) || fail(404, 'Мастер не найден');
  const date = isDate(req.body.date) ? req.body.date : null;
  db.prepare('INSERT OR IGNORE INTO waitlist (master_id, client_tg, date, created_at) VALUES (?, ?, ?, ?)').run(m.id, req.tg.id, date, nowIso());
}));
function freedSlot(b) {
  if (!b || b.event_id) return;
  const m = getMaster(b.master_id); if (!m) return;
  const rows = db.prepare('SELECT * FROM waitlist WHERE master_id = ? AND notified = 0 AND (date IS NULL OR date = ?) AND client_tg IS NOT ? ORDER BY id LIMIT 5').all(m.id, b.date, b.client_tg || -1);
  rows.forEach(w => {
    db.prepare('UPDATE waitlist SET notified = 1 WHERE id = ?').run(w.id);
    send(w.client_tg, `Освободилось окно: ${human(b.date)}, ${b.time} у <b>${html(m.name)}</b>. Успей записаться.`, WEBAPP_URL ? new InlineKeyboard().webApp('Записаться', appUrl('master=' + m.id)) : undefined);
  });
}

/* ---------- календари: подписка на свои записи и импорт занятости ---------- */
app.get('/api/calendar', route(req => {
  const u = requireUser(req);
  let token = u.cal_token;
  if (!token) { token = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE users SET cal_token = ? WHERE tg_id = ?').run(token, u.tg_id); }
  const base = (WEBAPP_URL || '').replace(/\/$/, '');
  const my = masterOf(u.tg_id);
  return { client: `${base}/cal/${token}/client.ics`, master: my ? `${base}/cal/${token}/master.ics` : null, icalUrl: my ? (db.prepare('SELECT ical_url FROM masters WHERE id = ?').get(my.id).ical_url || '') : null, icalSynced: my ? db.prepare('SELECT ical_synced FROM masters WHERE id = ?').get(my.id).ical_synced : null };
}));
const icsEsc = t => String(t || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
const icsTs = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
app.get('/cal/:token/:which.ics', (req, res) => {
  const u = /^[a-f0-9]{32}$/.test(req.params.token) && db.prepare('SELECT * FROM users WHERE cal_token = ?').get(req.params.token);
  if (!u) return res.status(404).send('Not found');
  const master = req.params.which === 'master' ? masterOf(u.tg_id) : null;
  if (req.params.which === 'master' && !master) return res.status(404).send('Not found');
  const rows = master
    ? db.prepare(`SELECT * FROM bookings WHERE master_id = ? AND status = 'active' AND date >= ?`).all(master.id, dk(Date.now() - 30 * 864e5))
    : db.prepare(`SELECT * FROM bookings WHERE client_tg = ? AND status = 'active' AND date >= ?`).all(u.tg_id, dk(Date.now() - 30 * 864e5));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ari//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${master ? 'Ari — клиенты' : 'Ari — мои записи'}`, 'X-WR-TIMEZONE:Asia/Yerevan', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  rows.forEach(b => {
    const m = getMaster(b.master_id); if (!m) return;
    const st = startTs(b.date, b.time);
    lines.push('BEGIN:VEVENT', `UID:${b.id}@ari`, `DTSTAMP:${icsTs(Date.now())}`, `DTSTART:${icsTs(st)}`, `DTEND:${icsTs(st + b.dur * 6e4)}`,
      `SUMMARY:${icsEsc(master ? `${shortName(b.client_name)} — ${what(b, m)}` : `${what(b, m)} — ${m.name}`)}`, `LOCATION:${icsEsc('Ереван, ' + addrOf(m))}`, `DESCRIPTION:${icsEsc('Запись через Ari. Перенести или отменить — в боте.')}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8').set('Cache-Control', 'no-store').send(lines.join('\r\n'));
});
const ICAL_HOSTS = /^(calendar\.google\.com|p\d+-caldav\.icloud\.com|caldav\.icloud\.com|outlook\.office365\.com|outlook\.live\.com|calendar\.yandex\.ru|calendar\.yandex\.com)$/;
async function syncIcal(masterId) {
  const r = db.prepare('SELECT ical_url FROM masters WHERE id = ?').get(masterId);
  if (!r || !r.ical_url) return 0;
  const url = r.ical_url.replace(/^webcal:/, 'https:');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' }).finally(() => clearTimeout(t));
  if (!resp.ok) throw new Error('Календарь не отвечает (' + resp.status + ')');
  const text = (await resp.text()).slice(0, 3e6);
  const data = ical.sync.parseICS(text);
  const from = new Date(), to = new Date(Date.now() + 60 * 864e5), out = [];
  const addRange = (s, e) => {
    for (let d = new Date(s); d < e; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()), dayEnd = new Date(dayStart.getTime() + 864e5);
      const a = Math.max(s, dayStart), b = Math.min(e, dayEnd); if (b <= a) continue;
      out.push([dk(dayStart), Math.floor((a - dayStart) / 6e4), Math.ceil((b - dayStart) / 6e4)]);
    }
  };
  Object.values(data).forEach(ev => {
    if (ev.type !== 'VEVENT' || !ev.start) return;
    if (ev.transparency === 'TRANSPARENT' || ev.status === 'CANCELLED') return;
    const dur = (ev.end ? ev.end - ev.start : 36e5);
    // модуль повторений отдаёт время со сдвигом на пояс сервера, если у события указан TZID — компенсируем
    const fix = d => ev.rrule.options.tzid ? new Date(d.getTime() + d.getTimezoneOffset() * 6e4) : d;
    const starts = ev.rrule ? ev.rrule.between(new Date(from - dur - 864e5), new Date(to.getTime() + 864e5), true).map(fix) : [ev.start];
    starts.forEach(s0 => { const s = new Date(s0), e = new Date(s.getTime() + dur); if (e > from && s < to) addRange(s, e); });
  });
  db.transaction(() => { db.prepare('DELETE FROM busy WHERE master_id = ?').run(masterId); const ins = db.prepare('INSERT INTO busy (master_id, date, start_min, end_min) VALUES (?, ?, ?, ?)'); out.slice(0, 3000).forEach(x => ins.run(masterId, ...x)); })();
  db.prepare('UPDATE masters SET ical_synced = ? WHERE id = ?').run(nowIso(), masterId);
  return out.length;
}
app.post('/api/masters/me/ical', async (req, res) => {
  try {
    const my = masterOf(req.tg.id); if (!my) return res.status(404).json({ error: 'Нет страницы мастера' });
    const raw = str(req.body.url, 600);
    if (!raw) { db.prepare('UPDATE masters SET ical_url = NULL, ical_synced = NULL WHERE id = ?').run(my.id); db.prepare('DELETE FROM busy WHERE master_id = ?').run(my.id); return res.json({ ok: true, count: 0 }); }
    let host = ''; try { const u = new URL(raw.replace(/^webcal:/, 'https:')); if (u.protocol !== 'https:') throw 0; host = u.hostname; } catch { return res.status(400).json({ error: 'Это не похоже на ссылку календаря' }); }
    if (!ICAL_HOSTS.test(host)) return res.status(400).json({ error: 'Пока поддерживаем Google, Apple (iCloud), Outlook и Яндекс Календарь' });
    db.prepare('UPDATE masters SET ical_url = ? WHERE id = ?').run(raw, my.id);
    const count = await syncIcal(my.id);
    res.json({ ok: true, count });
  } catch (e) { res.status(400).json({ error: e.message && e.message.length < 120 ? e.message : 'Не получилось прочитать календарь — проверь ссылку' }); }
});
let lastIcal = 0;
async function syncAllIcal() {
  if (Date.now() - lastIcal < 15 * 6e4) return; lastIcal = Date.now();
  for (const r of db.prepare('SELECT id FROM masters WHERE ical_url IS NOT NULL').all()) { try { await syncIcal(r.id); } catch (e) { console.warn('ical', r.id, e.message); } }
}

/* ---------- картинки: отдаём отдельно, чтобы приложение грузилось быстро ---------- */
app.get('/img/:kind/:id/:field', (req, res) => {
  const { kind, id, field } = req.params;
  let d = '';
  if (kind === 'm' && ['photo', 'entrancePhoto'].includes(field)) { const m = getMaster(id); d = m && m[field]; }
  if (kind === 's') { const sl = getSalon(id); if (sl) d = field === 'entrancePhoto' ? sl.entrancePhoto : /^g\d$/.test(field) ? (sl.photos || [])[+field[1]] : ''; }
  const mt = d && d.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!mt) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(mt[1]).send(Buffer.from(mt[2], 'base64'));
});

/* ---------- страница маршрута: выбор карт ---------- */
app.get('/go/:id', (req, res) => {
  const m = getMaster(req.params.id) || (() => { const sl = getSalon(req.params.id); return sl && { id: sl.id, name: sl.name, salonId: sl.id }; })();
  if (!m) return res.status(404).send('Не найдено');
  const p = m.salonId && m.salonId === m.id ? { ...getSalon(m.id) } : placeOf(m);
  const q = encodeURIComponent('Ереван, ' + (p.address || p.area || ''));
  const ll = p.lat && p.lng ? `${p.lat},${p.lng}` : '';
  const links = [
    ['Яндекс Карты', ll ? `https://yandex.ru/maps/?rtext=~${ll}&rtt=auto` : `https://yandex.ru/maps/?text=${q}`],
    ['2ГИС', ll ? `https://2gis.ru/geo/${p.lng},${p.lat}` : `https://2gis.ru/search/${q}`],
    ['Google Maps', ll ? `https://www.google.com/maps/dir/?api=1&destination=${ll}` : `https://www.google.com/maps/search/?api=1&query=${q}`],
    ['Apple Карты', ll ? `https://maps.apple.com/?daddr=${ll}` : `https://maps.apple.com/?q=${q}`]
  ];
  if (ll) links.push(['Такси — Яндекс Go', `https://3.redirect.appmetrica.yandex.com/route?end-lat=${p.lat}&end-lon=${p.lng}&appmetrica_tracking_id=1178268795219780156`]);
  const photo = p.salon ? imgUrl('s', p.salon.id, 'entrancePhoto', p.salon.entrancePhoto) : imgUrl('m', m.id, 'entrancePhoto', m.entrancePhoto);
  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Маршрут — ${html(p.name || m.name)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F4E9E4;color:#231A1E;margin:0;padding:24px 18px;max-width:480px;margin:auto}h1{font-size:22px;margin:0 0 6px}p{color:#7A6A6E;margin:0 0 18px}a{display:block;background:#fff;border-radius:16px;padding:16px;margin:10px 0;color:#231A1E;text-decoration:none;font-weight:600;box-shadow:0 8px 24px -12px rgba(35,26,30,.18)}.in{background:#FBE3C6;border-radius:16px;padding:14px;margin-top:18px}img{max-width:100%;border-radius:16px;margin-top:10px}@media(prefers-color-scheme:dark){body{background:#1A1417;color:#F4E9E4}a{background:#251D21;color:#F4E9E4}.in{background:#3D2E22}}</style></head>
<body><h1>${html(p.name || m.name)}</h1><p>${html([p.area, p.address].filter(Boolean).join(', '))}</p>${links.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`).join('')}${p.entrance || photo ? `<div class="in"><b>Как найти вход</b><br>${html(p.entrance || '')}${photo ? `<img src="${photo}" alt="Вход">` : ''}</div>` : ''}</body></html>`);
});

/* ---------- модерация: карточки для админа ---------- */
function masterCard(id) {
  const r = db.prepare('SELECT * FROM masters WHERE id = ?').get(id); if (!r) return null;
  const m = rowToMaster(r), hit = flagged(m.name, m.about, (m.services || []).map(s => s.name).join(' '));
  const text = `🧑‍🎨 <b>Мастер на проверке</b>${hit ? `\n⚠️ Стоп-слово: «${html(hit)}»` : ''}\n\n<b>${html(m.name)}</b> · ${html(m.cat)}\n${html(m.about || '— без описания —')}\n📍 ${html(m.area)}${m.address ? ', ' + html(m.address) : ''}\n\nУслуги:\n` +
    (m.services || []).map(s => `• ${html(s.name)} — ${s.dur} мин, ${s.price} ֏`).join('\n');
  return { text, photo: m.photo, kb: new InlineKeyboard().text('✅ Одобрить', 'am:' + id).text('❌ Отклонить', 'rm:' + id) };
}
function eventCard(id) {
  const e = getEvent(id); if (!e) return null;
  const m = getMaster(e.masterId), hit = flagged(e.title, e.desc);
  const text = `🎟 <b>Событие на проверке</b>${hit ? `\n⚠️ Стоп-слово: «${html(hit)}»` : ''}\n\n<b>${html(e.title)}</b>\n${human(e.date)}, ${e.time} · ${e.price} ֏ · ${e.places} мест\nВедёт: ${html(m ? m.name : '?')}\n\n${html(e.desc)}`;
  return { text, kb: new InlineKeyboard().text('✅ Одобрить', 'ae:' + id).text('❌ Отклонить', 're:' + id) };
}
async function sendCard(to, card) {
  if (!bot || !card) return;
  try {
    if (card.photo && card.photo.startsWith('data:image/')) {
      const buf = Buffer.from(card.photo.split(',')[1], 'base64');
      await bot.api.sendPhoto(to, new InputFile(buf, 'photo.jpg'), { caption: card.text.slice(0, 1000), parse_mode: 'HTML', reply_markup: card.kb });
    } else await bot.api.sendMessage(to, card.text.slice(0, 4000), { parse_mode: 'HTML', reply_markup: card.kb });
  } catch (e) { console.warn('admin card failed', e.description || e.message); }
}
function salonCard(id) {
  const sl = getSalon(id); if (!sl) return null;
  const hit = flagged(sl.name, sl.about);
  const text = `🏠 <b>Салон на проверке</b>${hit ? `\n⚠️ Стоп-слово: «${html(hit)}»` : ''}\n\n<b>${html(sl.name)}</b> · ${html(sl.cat)}\n${html(sl.about || '— без описания —')}\n📍 ${html(sl.area)}${sl.address ? ', ' + html(sl.address) : ''}\nФото: ${(sl.photos || []).length}`;
  return { text, photo: (sl.photos || [])[0], kb: new InlineKeyboard().text('✅ Одобрить', 'as:' + id).text('❌ Отклонить', 'rs:' + id) };
}
function toModeration(type, id) { ADMIN_IDS.forEach(a => sendCard(a, type === 'event' ? eventCard(id) : type === 'salon' ? salonCard(id) : masterCard(id))); }
function notifyComplaint(cid, count) {
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(cid); if (!c) return;
  const rv = c.target_type === 'review' && db.prepare('SELECT * FROM reviews WHERE id = ?').get(c.target_id);
  const name = c.target_type === 'event' ? (getEvent(c.target_id) || {}).title : c.target_type === 'review' ? (rv ? `★${rv.rating} ${(rv.text || '').slice(0, 80)}` : '?') : (getMaster(c.target_id) || {}).name;
  const kb = new InlineKeyboard().text('🙈 Скрыть', 'ch:' + cid).text('👌 Всё в порядке', 'ck:' + cid).row().text('⛔ Заблокировать автора', 'cb:' + cid);
  ADMIN_IDS.forEach(a => send(a, `🚩 <b>Жалоба</b> на ${{ event: 'событие', review: 'отзыв', master: 'мастера' }[c.target_type]} «${html(name || '?')}»\nПричина: ${html(c.reason)}\nВсего жалоб: ${count}${count >= 3 ? ' — скрыто автоматически' : ''}`, kb));
}
function ownerOf(type, id) {
  if (type === 'review') { const r = db.prepare('SELECT client_tg FROM reviews WHERE id = ?').get(id); return r && { tgId: r.client_tg, id: null }; }
  if (type === 'event') { const e = getEvent(id); return e && getMaster(e.masterId); }
  return getMaster(id);
}

/* ---------- бэкапы: раз в сутки, храним 14 дней ---------- */
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
let lastBackup = '';
async function backup() {
  const today = dk(Date.now());
  if (lastBackup === today) return;
  lastBackup = today;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    await db.backup(path.join(BACKUP_DIR, `ari-${today}.db`));
    fs.readdirSync(BACKUP_DIR).filter(f => /^ari-\d{4}-\d{2}-\d{2}\.db$/.test(f) && f.slice(4, 14) < dk(Date.now() - 14 * 864e5)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    console.log('💾 Бэкап базы сохранён:', today);
  } catch (e) { console.error('Бэкап не удался:', e.message); }
}

/* ---------- запуск ---------- */
app.listen(PORT, () => console.log(`Ari работает на порту ${PORT}`));
setInterval(() => { try { tick(); } catch (e) { console.error('tick', e); } }, 60e3);
if (bot) {
  if (WEBAPP_URL) bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Ari', web_app: { url: WEBAPP_URL } } }).catch(e => console.warn('Кнопка меню не настроилась:', e.message));
  bot.api.setMyCommands([{ command: 'start', description: 'Открыть Ari' }, { command: 'bookings', description: 'Мои записи (закрепить)' }, { command: 'privacy', description: 'Какие данные мы храним' }]).catch(() => {});
  bot.start({ onStart: me => { console.log(`✅ Бот @${me.username} запущен`); ADMIN_IDS.forEach(a => send(a, '🔄 Ari обновлён и работает. /admin — панель')); } }).catch(e => {
    const code = e.error_code;
    if (code === 404) console.error('❌ Telegram не нашёл бота с таким токеном (404). Проверь BOT_TOKEN — скопируй заново в @BotFather: /mybots → бот → API Token.');
    else if (code === 401) console.error('❌ Токен отозван или устарел (401). Возьми свежий в @BotFather: /mybots → бот → API Token.');
    else if (code === 409) console.error('❌ Бот уже запущен в другом месте (409). Оставь только одну копию сервиса.');
    else console.error('❌ Бот не запустился:', e.message);
    console.error('Сайт при этом работает, бот — нет.');
  });
}
module.exports = { app, db, tick, checkInitData, flagged, buildPin, canReview, chatOpen, bot, syncIcal };
