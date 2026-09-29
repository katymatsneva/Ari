// Ari — сервер: Telegram-бот, API для мини-приложения, напоминания.
// Все даты и время считаются по Еревану.
process.env.TZ = process.env.TZ || 'Asia/Yerevan';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { Bot, InlineKeyboard, InputFile } = require('grammy');

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
const REJECT_REASONS = ['Нарушает правила сервиса', 'Мало информации — добавьте описание и фото', 'Не похоже на реальную услугу или событие', 'Запрещённая категория (18+, азартные игры, вещества и т. п.)'];

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

function cleanMaster(b) {
  const sch = b.schedule || {};
  const out = {
    name: str(b.name, 60), cat: CATS.includes(b.cat) ? b.cat : 'massage', about: str(b.about, 400),
    area: str(b.area, 40), address: str(b.address, 120), prepay: int(b.prepay, 0, 1e6, 0),
    payInfo: str(b.payInfo, 120), langs: str(b.langs, 80),
    photo: typeof b.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.photo) && b.photo.length < 400000 ? b.photo : '',
    services: (Array.isArray(b.services) ? b.services : []).slice(0, 20)
      .map(s => ({ id: isId(s.id) ? s.id : rid(), name: str(s.name, 60), dur: int(s.dur, 15, 720, 60), price: int(s.price, 0, 1e7, 0) }))
      .filter(s => s.name),
    schedule: { days: [...new Set((Array.isArray(sch.days) ? sch.days : []).map(Number).filter(d => d >= 0 && d <= 6))], from: int(sch.from, 0, 23, 10), to: int(sch.to, 1, 24, 19) }
  };
  if (!out.name) fail(400, 'Укажите имя');
  if (!out.services.length) fail(400, 'Нужна хотя бы одна услуга');
  if (!out.schedule.days.length || out.schedule.to <= out.schedule.from) fail(400, 'Проверьте график работы');
  if (CARD_RE.test(out.payInfo)) fail(400, 'Не указывайте номер карты — лучше Idram, Telcell или ссылку');
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
  return !busy.some(b => s < toMin(b.time) + b.dur && e > toMin(b.time));
}

function publicMaster(r) {
  const m = rowToMaster(r);
  const rated = db.prepare('SELECT COUNT(*) n, SUM(rating) s FROM bookings WHERE master_id = ? AND rating IS NOT NULL').get(m.id);
  const base = (m.rating || 0) * (m.reviews || 0);
  const n = (m.reviews || 0) + rated.n;
  m.rating = n ? Math.round(((base + (rated.s || 0)) / n) * 10) / 10 : 0;
  m.reviews = n;
  m.status = r.status || 'approved';
  m.rejectReason = r.reject_reason || undefined;
  delete m.tgId;
  return m;
}

function bookingOut(b, viewer, myMasterId) {
  const base = { id: b.id, masterId: b.master_id, serviceId: b.service_id || undefined, eventId: b.event_id || undefined, date: b.date, time: b.time, dur: b.dur, status: b.status };
  if (b.client_tg && b.client_tg === viewer) return { ...base, mine: true, clientName: b.client_name, source: b.source, confirmed: !!b.confirmed, rating: b.rating || undefined, createdAt: b.created_at, movedAt: b.moved_at || undefined, cancelledAt: b.cancelled_at || undefined, confirmedAt: b.confirmed_at || undefined };
  if (myMasterId && b.master_id === myMasterId) return { ...base, mine: false, clientName: b.client_name, source: b.source, confirmed: !!b.confirmed, createdAt: b.created_at, movedAt: b.moved_at || undefined, cancelledAt: b.cancelled_at || undefined, confirmedAt: b.confirmed_at || undefined };
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
  try { await bot.api.sendMessage(tgId, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } }); }
  catch (e) { console.warn('send failed', tgId, e.description || e.message); }
}
const appUrl = q => WEBAPP_URL + (q ? (WEBAPP_URL.includes('?') ? '&' : '?') + q : '');
const mapUrl = m => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Yerevan ' + (m.address || m.area || ''));
function what(b, m) {
  if (b.event_id) { const e = getEvent(b.event_id); return e ? e.title : 'Событие'; }
  const s = (m.services || []).find(x => x.id === b.service_id);
  return s ? s.name : 'Визит';
}
function notify(kind, b) {
  const m = getMaster(b.master_id); if (!m) return;
  const w = html(what(b, m)), when = `${human(b.date)}, ${b.time}`;
  const toClient = (t, kb) => send(b.client_tg, t, kb);
  const toMaster = t => send(m.tgId, t);
  if (kind === 'created') {
    toClient(`✅ <b>${b.event_id ? 'Вы идёте' : 'Вы записаны'}</b>\n${w}, ${html(m.name)}\n${when}\n${html(m.address || m.area)}${!b.event_id && m.prepay ? `\n\nПредоплата ${m.prepay.toLocaleString('ru-RU')} ֏ — напрямую мастеру: ${html(m.payInfo || 'реквизиты пришлёт мастер')}` : ''}\n\nНапомню за день и за 2 часа.`);
    toMaster(`🆕 <b>Новая запись</b>\n${html(b.client_name)}, ${w}\n${when}${b.source === 'afisha' ? '\nПришёл из афиши' : ''}`);
  }
  if (kind === 'moved') toMaster(`${html(b.client_name)} перенес(ла) запись: теперь ${when}, ${w}`);
  if (kind === 'confirmed') toMaster(`${html(b.client_name)} подтвердил(а) визит: ${when}`);
  if (kind === 'cancelledByClient') { toMaster(`${html(b.client_name)} отменил(а) запись на ${when}. Окно снова свободно`); toClient(`Запись отменена: ${w}, ${when}. Мастер в курсе.`); }
  if (kind === 'cancelledByMaster') toClient(`😔 Мастер ${html(m.name)} отменил(а) запись на ${when}. Выберите другое время:`, new InlineKeyboard().webApp('Записаться снова', appUrl('rebook=' + b.id)));
}

if (bot) {
  bot.command('start', ctx => !WEBAPP_URL ? ctx.reply('Ari почти готов — осталось добавить адрес приложения на сервере.') : ctx.reply(
    'Барев! Я <b>Ari</b> — по-армянски это «приходи».\n\nЗаписывайтесь к мастерам Еревана, находите события и местные впечатления. Напоминания о записях буду присылать сюда.',
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('Открыть Ari', WEBAPP_URL) }
  ));
  bot.command('privacy', ctx => ctx.reply('Я храню ваше имя, телефон (если вы им поделились) и записи — только чтобы работали запись и напоминания. Удалить всё можно в приложении: Документы → Удалить мои данные.'));
  bot.on('message:contact', async ctx => {
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply('Нужен ваш собственный номер — нажмите кнопку в приложении.');
    const phone = c.phone_number.startsWith('+') ? c.phone_number : '+' + c.phone_number;
    if (getUser(ctx.from.id)) db.prepare('UPDATE users SET phone = ? WHERE tg_id = ?').run(phone, ctx.from.id);
    else { pendingPhone.set(ctx.from.id, phone); setTimeout(() => pendingPhone.delete(ctx.from.id), 36e5); }
    await ctx.reply('Спасибо, номер получен. Возвращайтесь в приложение 👌', { reply_markup: { remove_keyboard: true } });
  });
  bot.callbackQuery(/^(c|x|r):([\w-]+)(?::(\d))?$/, async ctx => {
    const [, act, id, val] = ctx.match;
    const b = getBooking(id);
    if (!b || b.client_tg !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Запись не найдена' });
    if (act === 'c' && b.status === 'active') {
      db.prepare('UPDATE bookings SET confirmed = 1, confirmed_at = ? WHERE id = ?').run(nowIso(), id);
      notify('confirmed', getBooking(id));
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('✓ Вы подтвердили', 'noop') }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Отлично, мастер увидит, что вы придёте' });
    }
    if (act === 'x' && b.status === 'active') {
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(nowIso(), id);
      notify('cancelledByClient', getBooking(id));
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Запись отменена' });
    }
    if (act === 'r' && !b.rating) {
      db.prepare('UPDATE bookings SET rating = ? WHERE id = ?').run(int(val, 1, 5, 5), id);
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().webApp('Записаться снова', appUrl('rebook=' + id)) }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Спасибо за оценку!' });
    }
    return ctx.answerCallbackQuery();
  });
  bot.callbackQuery('noop', ctx => ctx.answerCallbackQuery());

  /* ----- админка ----- */
  const adminStats = () => {
    const q = sql => db.prepare(sql).get().n;
    return `<b>Панель Ari</b>\n\n👥 Пользователей: ${q('SELECT COUNT(*) n FROM users')}\n🧑‍🎨 Мастеров: ${q(`SELECT COUNT(*) n FROM masters WHERE status = 'approved' AND demo = 0`)} (демо: ${q('SELECT COUNT(*) n FROM masters WHERE demo = 1')})\n` +
      `⏳ На проверке: ${q(`SELECT COUNT(*) n FROM masters WHERE status = 'pending'`)} мастеров, ${q(`SELECT COUNT(*) n FROM events WHERE status = 'pending'`)} событий\n🚩 Открытых жалоб: ${q('SELECT COUNT(*) n FROM complaints WHERE resolved = 0')}\n` +
      `📅 Записей за 7 дней: ${db.prepare(`SELECT COUNT(*) n FROM bookings WHERE created_at >= ?`).get(new Date(Date.now() - 7 * 864e5).toISOString()).n}\n🔔 Ждут запуска: ${q('SELECT COUNT(*) n FROM users WHERE notify_launch = 1')}`;
  };
  bot.command('admin', ctx => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(`Эта команда только для администратора. Ваш ID: ${ctx.from.id}`);
    return ctx.reply(adminStats(), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⏳ Очередь проверки', 'aq').text('🚩 Жалобы', 'ac') });
  });
  bot.command('id', ctx => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));
  const adminOnly = fn => async ctx => { if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для администратора' }); return fn(ctx); };
  const done = async (ctx, text) => { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(text, 'noop') }).catch(() => {}); return ctx.answerCallbackQuery({ text }); };

  bot.callbackQuery('aq', adminOnly(async ctx => {
    const ms = db.prepare(`SELECT id FROM masters WHERE status = 'pending'`).all(), es = db.prepare(`SELECT id FROM events WHERE status = 'pending'`).all();
    await ctx.answerCallbackQuery();
    if (!ms.length && !es.length) return ctx.reply('Очередь пуста ✨');
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
    send(m.tgId, '✅ <b>Ваша страница опубликована!</b>\nТеперь клиенты видят вас в каталоге и могут записываться.', WEBAPP_URL ? new InlineKeyboard().webApp('Открыть кабинет', WEBAPP_URL) : undefined);
    return done(ctx, '✅ Одобрено');
  }));
  bot.callbackQuery(/^ae:(.+)$/, adminOnly(async ctx => {
    const id = ctx.match[1], e = getEvent(id); if (!e) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
    db.prepare(`UPDATE events SET status = 'approved', reject_reason = NULL WHERE id = ?`).run(id);
    const m = getMaster(e.masterId); if (m) send(m.tgId, `✅ Событие «${html(e.title)}» опубликовано в афише`);
    return done(ctx, '✅ Одобрено');
  }));
  bot.callbackQuery(/^(rm|re):(.+)$/, adminOnly(async ctx => {
    const [, kind, id] = ctx.match, kb = new InlineKeyboard();
    REJECT_REASONS.forEach((r, i) => kb.text(r, `rr:${kind === 'rm' ? 'm' : 'e'}:${id}:${i}`).row());
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    return ctx.answerCallbackQuery({ text: 'Выберите причину' });
  }));
  bot.callbackQuery(/^rr:(m|e):(.+):(\d)$/, adminOnly(async ctx => {
    const [, kind, id, n] = ctx.match, reason = REJECT_REASONS[+n] || REJECT_REASONS[0];
    if (kind === 'm') {
      const m = getMaster(id); if (!m) return ctx.answerCallbackQuery({ text: 'Уже удалено' });
      db.prepare(`UPDATE masters SET status = 'rejected', reject_reason = ? WHERE id = ?`).run(reason, id);
      send(m.tgId, `Страницу нужно поправить: <b>${html(reason)}</b>\n\nОткройте кабинет → «Услуги и профиль», внесите правки и сохраните — страница снова уйдёт на проверку.`, WEBAPP_URL ? new InlineKeyboard().webApp('Открыть кабинет', WEBAPP_URL) : undefined);
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
    if (act === 'h') db.prepare(`UPDATE ${table} SET status = 'hidden' WHERE id = ?`).run(c.target_id);
    if (act === 'k') db.prepare(`UPDATE ${table} SET status = 'approved' WHERE id = ? AND status = 'hidden'`).run(c.target_id);
    if (act === 'b') {
      const owner = ownerOf(c.target_type, c.target_id);
      if (owner && owner.tgId) {
        db.prepare('UPDATE users SET blocked = 1 WHERE tg_id = ?').run(owner.tgId);
        db.prepare(`UPDATE masters SET status = 'hidden' WHERE tg_id = ?`).run(owner.tgId);
        db.prepare(`UPDATE events SET status = 'hidden' WHERE master_id = ?`).run(owner.id);
      } else db.prepare(`UPDATE ${table} SET status = 'hidden' WHERE id = ?`).run(c.target_id);
    }
    db.prepare('UPDATE complaints SET resolved = 1 WHERE target_type = ? AND target_id = ?').run(c.target_type, c.target_id);
    return done(ctx, { h: '🙈 Скрыто', k: '👌 Оставлено', b: '⛔ Заблокирован' }[act]);
  }));
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
        send(b.client_tg, `⏰ Завтра в ${b.time}: ${w}, ${html(m.name)}.\n${html(m.address || m.area)}\n\nВсё в силе?`, kb);
      }
      if (!b.r2 && left <= 2 * 36e5 && left > 0 && cr < st - 2 * 36e5) {
        mark(b.id, 'r2');
        const kb = new InlineKeyboard();
        if (!b.r24 && !b.confirmed) kb.text('Буду ✓', 'c:' + b.id);
        kb.url('Маршрут', mapUrl(m));
        if (!b.r24) kb.text('Отменить', 'x:' + b.id);
        send(b.client_tg, `🕑 Через 2 часа: ${w}, ${html(m.name)}.\n${html(m.address || m.area)}`, kb);
      }
      if (!b.rrate && !b.event_id && now >= st + (b.dur + 60) * 6e4 && now < st + 3 * 864e5) {
        mark(b.id, 'rrate');
        const kb = new InlineKeyboard();
        [1, 2, 3, 4, 5].forEach(i => kb.text('★'.repeat(i), `r:${b.id}:${i}`).row());
        send(b.client_tg, `Как всё прошло? ${w} у ${html(m.name)}.\nОценка займёт секунду:`, kb);
      }
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
      if (list.length) send(r.tg_id, `☀️ Доброе утро! Сегодня ${list.length} зап.:\n` + list.map(b => `${b.time} — ${html(b.client_name)}`).join('\n'));
    }
  }
  backup();
  // раз в сутки: удаляем записи старше года (срок хранения из политики)
  const today = dk(now);
  if (lastCleanup !== today) {
    lastCleanup = today;
    db.prepare('DELETE FROM bookings WHERE date < ?').run(dk(now - 365 * 864e5));
    db.prepare('DELETE FROM digests WHERE date < ?').run(dk(now - 7 * 864e5));
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
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res, next) => {
  let u = checkInitData(req.get('X-Init-Data'));
  if (!u && DEV_TG_ID && process.env.NODE_ENV !== 'production') u = { id: Number(DEV_TG_ID), first_name: 'Тест' };
  if (!u) return res.status(401).json({ error: 'Откройте приложение через бота в Telegram' });
  req.tg = u;
  const row = getUser(u.id);
  if (row && row.blocked && req.method !== 'GET' && !(req.method === 'DELETE' && req.path === '/me')) return res.status(403).json({ error: 'Аккаунт заблокирован. Если это ошибка, напишите в поддержку' });
  next();
});
const route = fn => (req, res) => { try { res.json(fn(req) || { ok: true }); } catch (e) { res.status(e.code || 500).json({ error: e.code ? e.message : 'Ошибка сервера' }); if (!e.code) console.error(e); } };
const requireUser = req => getUser(req.tg.id) || fail(403, 'Сначала завершите регистрацию');

app.get('/api/bootstrap', route(req => {
  const uid = req.tg.id, u = getUser(uid), my = masterOf(uid);
  const me = u
    ? { name: u.name, phone: u.phone || '', consent: u.consent_at, tourist: !!u.tourist, joined: true, no: u.no, since: u.joined_at }
    : { name: [req.tg.first_name, req.tg.last_name].filter(Boolean).join(' '), phone: pendingPhone.get(uid) || '', joined: false };
  const admin = isAdmin(uid);
  const masters = db.prepare('SELECT * FROM masters').all().filter(r => r.status === 'approved' || r.tg_id === uid).map(publicMaster);
  const visible = new Set(masters.filter(m => m.status === 'approved').map(m => m.id));
  const events = db.prepare('SELECT * FROM events WHERE date >= ?').all(dk(Date.now() - 864e5))
    .filter(r => (r.status === 'approved' && visible.has(r.master_id)) || (my && r.master_id === my.id))
    .map(r => ({ ...JSON.parse(r.data), id: r.id, masterId: r.master_id, date: r.date, time: r.time, status: r.status, rejectReason: r.reject_reason || undefined }));
  const bookings = db.prepare('SELECT * FROM bookings WHERE date >= ?').all(dk(Date.now() - 180 * 864e5))
    .filter(b => b.status === 'active' || b.client_tg === uid || (my && b.master_id === my.id))
    .map(b => bookingOut(b, uid, my && my.id));
  if (u) me.notifyLaunch = !!u.notify_launch;
  return { me, masters, events, bookings, myMasterId: my ? my.id : null, isAdmin: admin };
}));

app.post('/api/me', route(req => {
  const b = req.body || {}, uid = req.tg.id, u = getUser(uid);
  if (!u && !b.consent) return { ok: true, stored: false }; // без согласия ничего не храним
  const name = str(b.name, 60) || (u && u.name) || req.tg.first_name || 'Гость';
  let phone = str(b.phone, 20) || pendingPhone.get(uid) || (u && u.phone) || '';
  if (phone && phone.replace(/\D/g, '').length < 8) fail(400, 'Проверьте номер телефона');
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
  if (masterOf(uid)) fail(400, 'У вас уже есть страница мастера');
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
  const data = cleanMaster({ ...my, ...req.body });
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
  const title = str(b.title, 100) || fail(400, 'Добавьте название');
  if (!isDate(b.date) || !isTime(b.time) || startTs(b.date, b.time) < Date.now()) fail(400, 'Проверьте дату и время');
  const id = isId(b.id) && !getEvent(b.id) ? b.id : 'e_' + rid();
  const data = { title, dur: int(b.dur, 15, 720, 90), price: int(b.price, 0, 1e7, 0), places: int(b.places, 1, 500, 10), desc: str(b.desc, 600) || 'Подробности у ведущего.', tourist: my.cat === 'tour' };
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
  if (b.source === 'manual') {
    if (!my || my.id !== b.masterId) fail(403, 'Добавлять записи вручную может только мастер');
    const s = my.services.find(x => x.id === b.serviceId) || fail(400, 'Услуга не найдена');
    if (!isDate(b.date) || !isTime(b.time)) fail(400, 'Проверьте дату и время');
    if (!slotFree({ ...my, schedule: { days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 24 } }, b.date, b.time, s.dur)) fail(409, 'Это время уже занято или прошло');
    row = { id, master_id: my.id, service_id: s.id, event_id: null, client_tg: null, client_name: str(b.clientName, 60) || fail(400, 'Кто клиент?'), date: b.date, time: b.time, dur: s.dur, source: 'manual' };
  } else if (b.eventId) {
    const u = requireUser(req);
    const e = getEvent(b.eventId) || fail(404, 'Событие не найдено');
    if (db.prepare('SELECT status FROM events WHERE id = ?').get(e.id).status !== 'approved') fail(403, 'Событие пока недоступно для записи');
    if (startTs(e.date, e.time) < Date.now()) fail(400, 'Событие уже прошло');
    const taken = db.prepare(`SELECT COUNT(*) n FROM bookings WHERE event_id = ? AND status = 'active'`).get(e.id).n;
    if (taken >= e.places) fail(409, 'Мест больше нет');
    if (db.prepare(`SELECT 1 FROM bookings WHERE event_id = ? AND client_tg = ? AND status = 'active'`).get(e.id, uid)) fail(409, 'Вы уже записаны');
    row = { id, master_id: e.masterId, service_id: null, event_id: e.id, client_tg: uid, client_name: u.name, date: e.date, time: e.time, dur: e.dur || 90, source: 'afisha' };
  } else {
    const u = requireUser(req);
    const m = getMaster(b.masterId) || fail(404, 'Мастер не найден');
    if (db.prepare('SELECT status FROM masters WHERE id = ?').get(m.id).status !== 'approved' && m.tgId !== uid) fail(403, 'Мастер пока недоступен для записи');
    const s = (m.services || []).find(x => x.id === b.serviceId) || fail(400, 'Услуга не найдена');
    if (!isDate(b.date) || !isTime(b.time) || !slotFree(m, b.date, b.time, s.dur)) fail(409, 'Это время только что заняли — выберите другое');
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
  const isClient = b.client_tg === req.tg.id, isMaster = my && my.id === b.master_id;
  if (!(isClient || (forMaster && isMaster))) fail(403, 'Это не ваша запись');
  return { b, isClient, isMaster };
};
app.post('/api/bookings/:id/move', route(req => {
  const { b } = ownBooking(req);
  if (b.event_id || b.status !== 'active') fail(400, 'Эту запись нельзя перенести');
  const m = getMaster(b.master_id);
  if (!isDate(req.body.date) || !isTime(req.body.time) || !slotFree(m, req.body.date, req.body.time, b.dur, b.id)) fail(409, 'Это время только что заняли — выберите другое');
  db.prepare('UPDATE bookings SET date = ?, time = ?, moved_at = ?, confirmed = 0, r24 = 0, r2 = 0, rm = 0 WHERE id = ?').run(req.body.date, req.body.time, nowIso(), b.id);
  notify('moved', getBooking(b.id));
}));
app.post('/api/bookings/:id/cancel', route(req => {
  const { b, isClient } = ownBooking(req, true);
  if (b.status !== 'active') return;
  db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(nowIso(), b.id);
  notify(isClient ? 'cancelledByClient' : 'cancelledByMaster', getBooking(b.id));
}));
app.post('/api/bookings/:id/confirm', route(req => {
  const { b } = ownBooking(req);
  if (b.status !== 'active' || b.confirmed) return;
  db.prepare('UPDATE bookings SET confirmed = 1, confirmed_at = ? WHERE id = ?').run(nowIso(), b.id);
  notify('confirmed', getBooking(b.id));
}));
app.post('/api/bookings/:id/rate', route(req => {
  const { b } = ownBooking(req);
  if (b.rating || startTs(b.date, b.time) > Date.now()) return;
  db.prepare('UPDATE bookings SET rating = ? WHERE id = ?').run(int(req.body.v, 1, 5, 5), b.id);
}));

app.post('/api/complaints', route(req => {
  const uid = req.tg.id, b = req.body || {};
  requireUser(req);
  const type = b.type === 'event' ? 'event' : 'master';
  const exists = type === 'event' ? db.prepare('SELECT 1 FROM events WHERE id = ?').get(b.id) : db.prepare('SELECT 1 FROM masters WHERE id = ?').get(b.id);
  if (!exists) fail(404, 'Не найдено');
  const reason = str(b.reason, 300) || 'Без причины';
  const r = db.prepare('INSERT OR IGNORE INTO complaints (target_type, target_id, from_tg, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(type, b.id, uid, reason, nowIso());
  if (!r.changes) return { ok: true, duplicate: true };
  const n = db.prepare('SELECT COUNT(*) n FROM complaints WHERE target_type = ? AND target_id = ? AND resolved = 0').get(type, b.id).n;
  if (n >= 3) db.prepare(`UPDATE ${type === 'event' ? 'events' : 'masters'} SET status = 'hidden' WHERE id = ? AND status = 'approved'`).run(b.id);
  notifyComplaint(r.lastInsertRowid, n);
}));

app.post('/api/notify-launch', route(req => {
  requireUser(req);
  db.prepare('UPDATE users SET notify_launch = 1 WHERE tg_id = ?').run(req.tg.id);
}));

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
function toModeration(type, id) { ADMIN_IDS.forEach(a => sendCard(a, type === 'event' ? eventCard(id) : masterCard(id))); }
function notifyComplaint(cid, count) {
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(cid); if (!c) return;
  const name = c.target_type === 'event' ? (getEvent(c.target_id) || {}).title : (getMaster(c.target_id) || {}).name;
  const kb = new InlineKeyboard().text('🙈 Скрыть', 'ch:' + cid).text('👌 Всё в порядке', 'ck:' + cid).row().text('⛔ Заблокировать автора', 'cb:' + cid);
  ADMIN_IDS.forEach(a => send(a, `🚩 <b>Жалоба</b> на ${c.target_type === 'event' ? 'событие' : 'мастера'} «${html(name || '?')}»\nПричина: ${html(c.reason)}\nВсего жалоб: ${count}${count >= 3 ? ' — скрыто автоматически' : ''}`, kb));
}
function ownerOf(type, id) {
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
  bot.api.setMyCommands([{ command: 'start', description: 'Открыть Ari' }, { command: 'privacy', description: 'Какие данные мы храним' }]).catch(() => {});
  bot.start({ onStart: me => { console.log(`✅ Бот @${me.username} запущен`); ADMIN_IDS.forEach(a => send(a, '🔄 Ari обновлён и работает. /admin — панель')); } }).catch(e => {
    const code = e.error_code;
    if (code === 404) console.error('❌ Telegram не нашёл бота с таким токеном (404). Проверь BOT_TOKEN — скопируй заново в @BotFather: /mybots → бот → API Token.');
    else if (code === 401) console.error('❌ Токен отозван или устарел (401). Возьми свежий в @BotFather: /mybots → бот → API Token.');
    else if (code === 409) console.error('❌ Бот уже запущен в другом месте (409). Оставь только одну копию сервиса.');
    else console.error('❌ Бот не запустился:', e.message);
    console.error('Сайт при этом работает, бот — нет.');
  });
}
module.exports = { app, db, tick, checkInitData, flagged: typeof flagged !== "undefined" ? flagged : null };
