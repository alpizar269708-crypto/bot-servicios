
require("dotenv").config();

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  proto,
  Browsers
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || "bot_servicios";
const OWNER_PHONE = cleanPhone(process.env.OWNER_PHONE);
const PAIRING_PHONE = cleanPhone(process.env.PAIRING_PHONE);
const PREFIX = process.env.COMMAND_PREFIX || "!";
const COLLECTION = process.env.COLLECTION_NAME || "bot_servicios";

if (!MONGO_URI) {
  console.error("ERROR: falta MONGO_URI.");
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const mongo = new MongoClient(MONGO_URI);
let db;
let sock;
let starting = false;

function cleanPhone(v) {
  return String(v || "").replace(/\D/g, "");
}

function norm(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function phoneFromJid(jid) {
  return cleanPhone(String(jid || "").split("@")[0].split(":")[0]);
}

function money(n) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2
  }).format(Number(n || 0));
}

function parseAmount(v) {
  const n = Number(String(v || "").replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function amountFrom(text) {
  const m = String(text).match(/(?:^|\s)\$?\d+(?:[.,]\d{1,2})?(?=\s|$)/);
  if (!m) return null;
  const raw = m[0].trim();
  const amount = parseAmount(raw);
  return amount ? { raw, amount } : null;
}

function cleanName(text, amountRaw) {
  return String(text || "")
    .replace(amountRaw || "", " ")
    .replace(/\b(transferencia|transfer|transf|servicio|servicios)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.:;-]+|[,.:;-]+$/g, "")
    .trim();
}

function commandOf(text) {
  let t = norm(text);
  if (t.startsWith(PREFIX)) t = t.slice(PREFIX.length).trim();

  const map = {
    menu: "menu",
    ayuda: "menu",
    activarbotservicios: "activar",
    pag: "pag",
    pago: "pag",
    transferencia: "transferencia",
    deudores: "deudores",
    pagados: "pagados",
    listaservicios: "listaservicios",
    "cuenta nueva": "cuenta_nueva",
    cuentanueva: "cuenta_nueva",
    "cerrar ciclo": "cerrar_ciclo",
    cerrarciclo: "cerrar_ciclo"
  };

  return map[t] || null;
}

function isOwner(jid) {
  return phoneFromJid(jid) === OWNER_PHONE;
}

async function collections() {
  return {
    accounts: db.collection(COLLECTION + "_accounts"),
    cycles: db.collection(COLLECTION + "_cycles"),
    people: db.collection(COLLECTION + "_people"),
    services: db.collection(COLLECTION + "_services"),
    payments: db.collection(COLLECTION + "_payments"),
    transfers: db.collection(COLLECTION + "_transfers"),
    auth: db.collection(COLLECTION + "_auth")
  };
}

/*
 * Credenciales de Baileys guardadas en MongoDB.
 * Esto evita depender del disco efímero de Render para la sesión de WhatsApp.
 */
async function useMongoAuth() {
  const c = (await collections()).auth;

  let credsDoc = await c.findOne({ _id: "creds" });
  const creds = credsDoc
    ? JSON.parse(credsDoc.value, BufferJSON.reviver)
    : initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const docs = await c.find({
        _id: { $in: ids.map(id => "key:" + type + ":" + id) }
      }).toArray();

      const result = {};
      for (const id of ids) {
        const doc = docs.find(x => x._id === "key:" + type + ":" + id);
        if (!doc) {
          result[id] = null;
          continue;
        }
        let value = JSON.parse(doc.value, BufferJSON.reviver);
        if (type === "app-state-sync-key") {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        result[id] = value;
      }
      return result;
    },

    set: async data => {
      const operations = [];

      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          const key = "key:" + type + ":" + id;

          if (value) {
            let toSave = value;
            if (type === "app-state-sync-key") {
              toSave = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            operations.push({
              updateOne: {
                filter: { _id: key },
                update: {
                  $set: {
                    value: JSON.stringify(toSave, BufferJSON.replacer),
                    updatedAt: new Date()
                  }
                },
                upsert: true
              }
            });
          } else {
            operations.push({
              deleteOne: { filter: { _id: key } }
            });
          }
        }
      }

      if (operations.length) await c.bulkWrite(operations);
    }
  };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(keys, logger)
    },
    saveCreds: async () => {
      await c.updateOne(
        { _id: "creds" },
        {
          $set: {
            value: JSON.stringify(creds, BufferJSON.replacer),
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    }
  };
}

async function ensureIndexes() {
  const c = await collections();
  await c.accounts.createIndex({ number: 1 }, { unique: true });
  await c.accounts.createIndex({ active: 1 });
  await c.people.createIndex({ normalizedName: 1 }, { unique: true });
  await c.services.createIndex({ accountNumber: 1, status: 1 });
  await c.services.createIndex({ personId: 1, status: 1 });
  await c.payments.createIndex({ accountNumber: 1 });
  await c.cycles.createIndex({ accountNumber: 1 }, { unique: true });
}

async function activeAccount() {
  const { accounts } = await collections();
  return accounts.findOne({ active: true }, { sort: { createdAt: -1 } });
}

async function newAccount(initialAmount) {
  const { accounts, cycles } = await collections();
  const old = await activeAccount();

  if (old) {
    await accounts.updateOne(
      { _id: old._id },
      { $set: { active: false, closedAt: new Date() } }
    );
    await cycles.updateOne(
      { accountNumber: old.number },
      { $set: { status: "closed", closedAt: new Date() } }
    );
  }

  const number = (await accounts.countDocuments()) + 1;
  const account = {
    number,
    initialAmount: Number(initialAmount || 0),
    active: true,
    createdAt: new Date(),
    closedAt: null
  };

  await accounts.insertOne(account);
  await cycles.insertOne({
    accountNumber: number,
    initialAmount: account.initialAmount,
    status: "active",
    createdAt: new Date(),
    closedAt: null
  });

  return account;
}

async function ensureAccount() {
  const a = await activeAccount();
  return a || newAccount(0);
}

async function person(name, jid) {
  const { people } = await collections();
  const normalizedName = norm(name);
  let p = await people.findOne({ normalizedName });

  if (!p) {
    const result = await people.insertOne({
      name: String(name).trim(),
      normalizedName,
      jid: jid || null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    p = {
      _id: result.insertedId,
      name: String(name).trim(),
      normalizedName,
      jid: jid || null
    };
  } else {
    await people.updateOne(
      { _id: p._id },
      { $set: { jid: jid || p.jid || null, updatedAt: new Date() } }
    );
  }

  return p;
}

async function addService(name, amount, jid, transfer) {
  const account = await ensureAccount();
  const p = await person(name, jid);
  const c = await collections();

  const doc = {
    accountNumber: account.number,
    personId: p._id,
    personName: p.name,
    amount: Number(amount),
    createdAt: new Date()
  };

  if (transfer) {
    await c.transfers.insertOne({ ...doc, status: "recorded" });
    return "transfer";
  }

  await c.services.insertOne({ ...doc, status: "pending" });
  return "service";
}

async function servicesSummary() {
  const account = await ensureAccount();
  const { services } = await collections();

  const rows = await services.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();

  const total = rows.reduce((s, x) => s + Number(x.amount || 0), 0);
  const pending = rows.filter(x => x.status === "pending");
  const paid = rows.filter(x => x.status === "paid");

  return {
    account,
    rows,
    total,
    pendingTotal: pending.reduce((s, x) => s + Number(x.amount || 0), 0),
    paidTotal: paid.reduce((s, x) => s + Number(x.amount || 0), 0)
  };
}

async function pay(name) {
  const account = await ensureAccount();
  const c = await collections();
  const p = await c.people.findOne({ normalizedName: norm(name) });

  if (!p) return { ok: false, reason: "not_found" };

  const pending = await c.services.find({
    personId: p._id,
    status: "pending"
  }).sort({ createdAt: 1 }).toArray();

  if (!pending.length) return { ok: false, reason: "none", person: p };

  const total = pending.reduce((s, x) => s + Number(x.amount || 0), 0);
  const ids = pending.map(x => x._id);

  await c.services.updateMany(
    { _id: { $in: ids } },
    { $set: { status: "paid", paidAt: new Date() } }
  );

  await c.payments.insertOne({
    accountNumber: account.number,
    personId: p._id,
    personName: p.name,
    amount: total,
    serviceIds: ids,
    createdAt: new Date()
  });

  return { ok: true, person: p, total, count: pending.length };
}

async function debtors() {
  const { services } = await collections();
  return services.aggregate([
    { $match: { status: "pending" } },
    {
      $group: {
        _id: "$personId",
        name: { $first: "$personName" },
        total: { $sum: "$amount" },
        count: { $sum: 1 }
      }
    },
    { $sort: { name: 1 } }
  ]).toArray();
}

function menu() {
  return [
    "📋 *MENÚ — BOT DE SERVICIOS*",
    "",
    PREFIX + "activarbotservicios",
    PREFIX + "menu",
    PREFIX + "pag NOMBRE",
    PREFIX + "transferencia NOMBRE IMPORTE",
    PREFIX + "deudores",
    PREFIX + "pagados",
    PREFIX + "listaservicios",
    PREFIX + "cuenta nueva MONTO",
    PREFIX + "cerrar ciclo",
    "",
    "💡 Servicio rápido: escribe el importe y el nombre en cualquier orden.",
    "Ejemplos: 250 Juan / Juan 250",
    "",
    "🔄 Las transferencias se guardan pero NO cuentan en la suma.",
    "👥 Los deudores permanecen hasta registrar su pago.",
    "💾 El historial se conserva en MongoDB."
  ].join("\n");
}

async function send(jid, text) {
  if (sock) await sock.sendMessage(jid, { text });
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    "";

  if (!text) return;

  const command = commandOf(text);

  if (command === "activar" || command === "menu") {
    await send(jid, command === "activar"
      ? "🤖 *Bot de servicios activado.*\n\n" + menu()
      : menu());
    return;
  }

  if (command === "deudores") {
    const rows = await debtors();
    if (!rows.length) {
      await send(jid, "✅ No hay deudores pendientes.");
      return;
    }

    let total = 0;
    const body = rows.map((x, i) => {
      total += Number(x.total || 0);
      return (i + 1) + ". " + x.name + " — " + money(x.total) +
        " (" + x.count + " servicio" + (x.count === 1 ? "" : "s") + ")";
    }).join("\n");

    await send(jid, "👥 *DEUDORES*\n\n" + body +
      "\n\n💰 Total pendiente: *" + money(total) + "*");
    return;
  }

  if (command === "listaservicios") {
    const s = await servicesSummary();

    const body = s.rows.length
      ? s.rows.map((x, i) =>
          (i + 1) + ". " + x.personName + " — " + money(x.amount) +
          (x.status === "paid" ? " ✅" : " ⏳")
        ).join("\n")
      : "No hay servicios registrados.";

    await send(jid,
      "📋 *SERVICIOS — CUENTA " + s.account.number + "*\n\n" +
      body + "\n\n" +
      "🔢 Cantidad total: *" + s.rows.length + "*\n" +
      "💰 Suma total: *" + money(s.total) + "*\n" +
      "⏳ Pendiente: *" + money(s.pendingTotal) + "*\n" +
      "✅ Pagado: *" + money(s.paidTotal) + "*"
    );
    return;
  }

  if (command === "pagados") {
    const account = await ensureAccount();
    const { payments } = await collections();
    const rows = await payments.find({ accountNumber: account.number })
      .sort({ createdAt: 1 }).toArray();

    if (!rows.length) {
      await send(jid, "📭 No hay pagos registrados en este ciclo.");
      return;
    }

    const total = rows.reduce((s, x) => s + Number(x.amount || 0), 0);
    const body = rows.map((x, i) =>
      (i + 1) + ". " + x.personName + " — " + money(x.amount)
    ).join("\n");

    await send(jid, "💵 *PAGADOS*\n\n" + body +
      "\n\nTotal pagado: *" + money(total) + "*");
    return;
  }

  if (command === "pag") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();
    args = args.split(/\s+/).slice(1).join(" ").trim();

    if (!args) {
      await send(jid, "❌ Usa: " + PREFIX + "pag NOMBRE");
      return;
    }

    const result = await pay(args);

    if (!result.ok) {
      await send(jid, result.reason === "not_found"
        ? "❌ No encuentro a *" + args + "*."
        : "ℹ️ *" + result.person.name + "* no tiene servicios pendientes.");
      return;
    }

    await send(jid,
      "✅ *PAGO REGISTRADO*\n\n" +
      "👤 " + result.person.name + "\n" +
      "💵 Total: *" + money(result.total) + "*\n" +
      "🧾 Servicios liquidados: *" + result.count + "*"
    );
    return;
  }

  if (command === "transferencia") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();
    args = args.split(/\s+/).slice(1).join(" ").trim();

    const a = amountFrom(args);
    if (!a) {
      await send(jid, "❌ Usa: " + PREFIX + "transferencia NOMBRE IMPORTE");
      return;
    }

    const name = cleanName(args, a.raw);
    if (!name) {
      await send(jid, "❌ Falta el nombre.");
      return;
    }

    await addService(name, a.amount, jid, true);
    await send(jid,
      "🔄 *TRANSFERENCIA REGISTRADA*\n\n" +
      "👤 " + name + "\n" +
      "💵 " + money(a.amount) + "\n" +
      "🚫 No se suma al total de servicios."
    );
    return;
  }

  if (command === "cuenta_nueva") {
    if (!isOwner(jid)) {
      await send(jid, "⛔ Solo el propietario puede iniciar una cuenta nueva.");
      return;
    }

    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();
    const rest = args.split(/\s+/).slice(2).join(" ");
    const a = amountFrom(rest);
    const account = await newAccount(a ? a.amount : 0);

    await send(jid,
      "🆕 *CUENTA NUEVA*\n\n" +
      "Cuenta: *" + account.number + "*\n" +
      "Monto inicial: *" + money(account.initialAmount) + "*\n\n" +
      "📚 El historial anterior se conserva."
    );
    return;
  }

  if (command === "cerrar_ciclo") {
    if (!isOwner(jid)) {
      await send(jid, "⛔ Solo el propietario puede cerrar el ciclo.");
      return;
    }

    const s = await servicesSummary();
    const { accounts, cycles } = await collections();
    await accounts.updateOne(
      { _id: s.account._id },
      { $set: { active: false, closedAt: new Date() } }
    );
    await cycles.updateOne(
      { accountNumber: s.account.number },
      {
        $set: {
          status: "closed",
          closedAt: new Date(),
          summary: {
            count: s.rows.length,
            total: s.total,
            pending: s.pendingTotal,
            paid: s.paidTotal
          }
        }
      }
    );

    await send(jid,
      "🔒 *CICLO CERRADO*\n\n" +
      "🧾 Servicios: *" + s.rows.length + "*\n" +
      "💰 Total: *" + money(s.total) + "*\n" +
      "⏳ Pendiente: *" + money(s.pendingTotal) + "*\n" +
      "✅ Pagado: *" + money(s.paidTotal) + "*\n\n" +
      "📚 Todo queda guardado en MongoDB."
    );
    return;
  }

  const raw = text.replace(/^!/, "").trim();
  const a = amountFrom(raw);

  if (a) {
    const name = cleanName(raw, a.raw);
    if (name.length >= 2) {
      const transfer = /\b(transferencia|transfer|transf)\b/i.test(raw);
      const type = await addService(name, a.amount, jid, transfer);

      if (type === "transfer") {
        await send(jid,
          "🔄 Transferencia registrada: *" + name + "* — *" +
          money(a.amount) + "*\n🚫 No se suma al total.");
      } else {
        await send(jid,
          "🧾 Servicio registrado: *" + name + "* — *" +
          money(a.amount) + "*");
      }
    }
  }
}

async function start() {
  if (starting) return;
  starting = true;

  try {
    const { state, saveCreds } = await useMongoAuth();
    const latest = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version: latest.version,
      logger,
      auth: state,
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async update => {
      const connection = update.connection;

      if (update.qr) {
        console.log("\nESCANEA ESTE QR EN WHATSAPP:\n");
        qrcode.generate(update.qr, { small: true });
      }

      if (connection === "open") {
        starting = false;
        logger.info("WhatsApp conectado.");

        if (OWNER_PHONE) {
          await send(
            OWNER_PHONE + "@s.whatsapp.net",
            "🤖 Bot de servicios conectado.\n\nEscribe " + PREFIX + "menu"
          );
        }
      }

      if (connection === "close") {
        starting = false;

        const code = update.lastDisconnect?.error?.output?.statusCode;
        const retry = code !== DisconnectReason.loggedOut;

        logger.warn({ code, retry }, "WhatsApp desconectado.");

        if (retry) setTimeout(start, 5000);
      }
    });

    sock.ev.on("messages.upsert", async event => {
      for (const msg of event.messages) {
        try {
          await handleMessage(msg);
        } catch (error) {
          logger.error({ error }, "Error procesando mensaje");
        }
      }
    });

    if (PAIRING_PHONE && !state.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(PAIRING_PHONE);
          console.log("\n================================");
          console.log("CODIGO DE VINCULACION:");
          console.log(code);
          console.log("================================\n");
        } catch (error) {
          logger.error({ error }, "No se pudo obtener el código de vinculación");
        }
      }, 5000);
    }
  } catch (error) {
    starting = false;
    logger.error({ error }, "Error iniciando WhatsApp");
    setTimeout(start, 10000);
  }
}

(async () => {
  await mongo.connect();
  db = mongo.db(DB_NAME);
  await ensureIndexes();
  await ensureAccount();
  logger.info("MongoDB conectado.");
  await start();
})();
