
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
const express = require("express");
const { useMongoDBAuthState } = require("./mongoAuth");
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || "bot_servicios";
const OWNER_PHONE = cleanPhone(process.env.OWNER_PHONE);
const PREFIX = process.env.COMMAND_PREFIX || "!";
const COLLECTION = process.env.COLLECTION_NAME || "bot_servicios";

if (!MONGO_URI) {
  console.error("ERROR: falta MONGO_URI.");
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || "silent" });
const mongo = new MongoClient(MONGO_URI);
let db;
let sock;
let starting = false;
let currentQR = null;
let currentPairingCode = null;
let requestedPairingPhone = null;
let pairingInProgress = false;
let botConnected = false;
let authState = null;
let loginMode = null;
let loginPhone = "";
const botSentMessageIds = new Set();

const app = express();
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

function panelStatus() {
  return {
    connected: botConnected,
    qr: currentQR,
    pairingCode: currentPairingCode
  };
}

app.get("/status", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.json(panelStatus());
});

app.get("/pairing", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  if (botConnected) return res.json({ ok: true, connected: true });

  const phone = cleanPhone(req.query.phone);
  if (!phone || phone.length < 10) {
    return res.status(400).json({ ok: false, error: "Escribe un número de teléfono válido." });
  }

  try {
    loginMode = "phone";
    loginPhone = phone;
    requestedPairingPhone = phone;
    currentPairingCode = null;

    if (!sock) {
      await start("phone", phone);
      return res.json({ ok: true, waiting: true });
    }

    const code = await generatePairingCode();
    return res.json({ ok: true, pairingCode: code });
  } catch (error) {
    console.error("❌ No se pudo generar el código:", error?.message || error);
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get("/qr", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  if (botConnected) return res.json({ ok: true, connected: true });

  try {
    loginMode = "qr";
    loginPhone = "";
    requestedPairingPhone = null;
    currentPairingCode = null;
    if (!sock) await start("qr", "");
    return res.json({ ok: true, waiting: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get("/", async (req, res) => {
  if (botConnected) {
    return res.send(`
      <div style="font-family: Arial; text-align: center; margin-top: 50px;">
        <h2>🤖 Bot de WhatsApp activo</h2>
        <p>El bot ya está vinculado y trabajando en el servidor.</p>
      </div>
    `);
  }
  const html = `
    <html>
    <head><title>Vincular Bot</title><meta charset="utf-8"></head>
    <body style="font-family: Arial; padding: 20px; max-width: 600px; margin: auto; text-align: center;">
        <h2>🔌 Vincular Bot de WhatsApp</h2>
        <form action="/iniciar" method="POST" style="text-align: left; background: #f9f9f9; padding: 20px; border-radius: 10px; border: 1px solid #ddd;">
            <p><b>1. Elige el método de inicio de sesión:</b></p>
            <label><input type="radio" name="metodo" value="1" checked> 📱 Código QR</label><br><br>
            <label><input type="radio" name="metodo" value="2"> 🔢 Código de 8 dígitos</label><br><br>
            <p><b>2. Si elegiste 8 dígitos, ingresa tu número (código país + número, ej. 525512345678):</b></p>
            <input type="text" name="numero" placeholder="Ej: 525512345678" style="padding: 10px; width: 100%; box-sizing: border-box; border-radius: 5px; border: 1px solid #ccc;"><br><br>
            <button type="submit" style="padding: 12px 20px; background: #25D366; color: white; border: none; cursor: pointer; font-size: 16px; border-radius: 5px; width: 100%;">Generar Código</button>
        </form>
    </body>
    </html>
  `;
  res.send(html);
});

app.post("/iniciar", async (req, res) => {
  const { metodo, numero } = req.body;
  const numeroLimpio = numero ? String(numero).replace(/[^0-9]/g, "") : "";

  loginMode = metodo === "2" ? "phone" : "qr";
  loginPhone = numeroLimpio;

  if (botConnected) {
    return res.send('<h2 style="font-family: Arial; text-align: center; margin-top: 50px;">✅ El bot ya está vinculado y activo.</h2>');
  }

  if (loginMode === "phone") {
    if (numeroLimpio.length < 10) {
      return res.send('<h2 style="font-family: Arial; text-align: center; margin-top: 50px;">❌ Escribe un número válido con código de país.</h2>');
    }

    requestedPairingPhone = numeroLimpio;
    currentPairingCode = null;

    try {
      if (!sock) {
        await new Promise(resolve => {
          start("phone", numeroLimpio, htmlRespuesta => {
            res.send(htmlRespuesta);
            resolve();
          });
        });
        return;
      }

      const code = await generatePairingCode();
      if (code) {
        const codigoFormat = code.match(/.{1,4}/g)?.join("-") || code;
        return res.send(`
          <div style="font-family: Arial; text-align: center; margin-top: 50px;">
            <h2>🔢 Tu código de vinculación es:</h2>
            <h1 style="font-size: 48px; letter-spacing: 5px; color: #25D366; background: #eee; display: inline-block; padding: 10px 20px; border-radius: 10px;">${codigoFormat}</h1>
            <p>Abre WhatsApp en tu teléfono, ve a <b>Dispositivos Vinculados &gt; Vincular con número de teléfono</b>, e ingresa este código.</p>
          </div>
        `);
      }

      return res.send('<h2 style="font-family: Arial; text-align: center; margin-top: 50px;">⏳ WhatsApp está iniciando. Espera unos segundos y vuelve a generar el código.</h2>');
    } catch (error) {
      console.error("❌ Error en inicio por número:", error?.message || error);
      return res.send('<h2 style="font-family: Arial; text-align: center; margin-top: 50px;">❌ No se pudo generar el código. Revisa el log de Render.</h2>');
    }
  }

  if (sock) {
    if (currentQR) {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(currentQR)}`;
      return res.send(`
        <div style="font-family: Arial; text-align: center; margin-top: 50px;">
          <h2>📱 Escanea este código QR</h2>
          <img src="${qrUrl}" alt="QR Code" style="border: 1px solid #ccc; border-radius: 10px; padding: 10px;" />
          <p>Abre WhatsApp &gt; Dispositivos Vinculados &gt; Vincular un dispositivo.</p>
        </div>
      `);
    }
    return res.send('<h2 style="font-family: Arial; text-align: center; margin-top: 50px;">⏳ WhatsApp está iniciando. Vuelve a intentarlo en unos segundos.</h2>');
  }

  return await new Promise(resolve => {
    start("qr", "", htmlRespuesta => {
      res.send(htmlRespuesta);
      resolve();
    });
  });
});

app.listen(Number(PORT), "0.0.0.0", () => console.log(`🌐 Panel listo en puerto ${PORT}`));

async function generatePairingCode() {
  if (!sock || !requestedPairingPhone || pairingInProgress) return null;

  pairingInProgress = true;
  try {
    const code = await sock.requestPairingCode(requestedPairingPhone);
    currentPairingCode = code;
    currentQR = null;
    console.log("🔐 Código de vinculación generado desde el panel.");
    return code;
  } finally {
    pairingInProgress = false;
  }
}

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

  const exact = {
    menu: "menu",
    ayuda: "menu",
    activarbotservicios: "activar",
    deudores: "deudores",
    pagados: "pagados",
    listaservicios: "listaservicios"
  };

  if (exact[t]) return exact[t];
  if (t === "pag" || t.startsWith("pag ")) return "pag";
  if (t === "pago" || t.startsWith("pago ")) return "pag";
  if (t === "transferencia" || t.startsWith("transferencia ")) return "transferencia";
  if (t === "cuenta nueva" || t.startsWith("cuenta nueva ")) return "cuenta_nueva";
  if (t === "cuentanueva" || t.startsWith("cuentanueva ")) return "cuenta_nueva";
  if (t === "cerrar ciclo" || t.startsWith("cerrar ciclo ")) return "cerrar_ciclo";

  return null;
}

function quotedText(msg) {
  const q =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
    msg.message?.imageMessage?.contextInfo?.quotedMessage ||
    msg.message?.videoMessage?.contextInfo?.quotedMessage ||
    null;

  if (!q) return "";

  return (
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    ""
  ).trim();
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
    withdrawals: db.collection(COLLECTION + "_withdrawals"),
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
  let previousSummary = null;

  if (old) {
    // Guardamos el estado final de la cuenta anterior antes de abrir la nueva.
    previousSummary = await servicesSummary();
    const closedAt = new Date();

    await accounts.updateOne(
      { _id: old._id },
      {
        $set: {
          active: false,
          closedAt,
          finalSummary: {
            count: previousSummary.rows.length,
            total: previousSummary.total,
            withdrawals: previousSummary.withdrawnTotal,
            netTotal: previousSummary.netTotal,
            pending: previousSummary.pendingTotal,
            paid: previousSummary.paidTotal
          }
        }
      }
    );

    await cycles.updateOne(
      { accountNumber: old.number },
      {
        $set: {
          status: "closed",
          closedAt,
          summary: {
            count: previousSummary.rows.length,
            total: previousSummary.total,
            withdrawals: previousSummary.withdrawnTotal,
            netTotal: previousSummary.netTotal,
            pending: previousSummary.pendingTotal,
            paid: previousSummary.paidTotal
          }
        }
      }
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
  const withdrawalRows = await c.withdrawals.find({ accountNumber: account.number }).sort({ createdAt: 1 }).toArray();
  const withdrawnTotal = withdrawalRows.reduce((s, x) => s + Number(x.amount || 0), 0);
  const netTotal = total - withdrawnTotal;
  const pending = rows.filter(x => x.status === "pending");
  const paid = rows.filter(x => x.status === "paid");

  return {
    account,
    rows,
    total,
    withdrawnTotal,
    netTotal,
    withdrawalRows,
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
    "📋 *MENÚ DE SERVICIOS*",
    "",
    "🧾 *Registrar servicio*",
    "   250 Juan",
    "   Juan 250",
    "",
    "💵 *Registrar pago*",
    "   pag Juan",
    "",
    "💸 *Registrar retiro*",
    "   retiro 5000",
    "",
    "🔄 *Registrar transferencia*",
    "   transferencia Juan 500",
    "",
    "👥 *Consultar deudores*",
    "   deudores",
    "",
    "✅ *Ver pagados*",
    "   pagados",
    "",
    "📋 *Ver servicios*",
    "   listaservicios",
    "",
    "🆕 *Nueva cuenta*",
    "   cuenta nueva 5000",
    "",
    "🔒 *Cerrar ciclo*",
    "   cerrar ciclo",
    "",
    "💡 Puedes escribir los comandos sin el signo !.",
    "🔄 Las transferencias no se suman al total."
  ].join("\n");
}

async function send(jid, text) {
  if (!sock) return null;

  const result = await sock.sendMessage(jid, { text });

  // Solo ignoramos los mensajes que ESTE BOT acaba de enviar.
  // Así, si el dueño escribe manualmente desde el mismo número,
  // ese mensaje sí puede ser procesado.
  if (result?.key?.id) {
    botSentMessageIds.add(result.key.id);

    // Evita que el Set crezca indefinidamente.
    setTimeout(() => botSentMessageIds.delete(result.key.id), 10 * 60 * 1000);
  }

  return result;
}

async function handleMessage(msg) {
  // No procesar mensajes enviados por el propio bot.
  // Los mensajes escritos manualmente por el usuario desde ese mismo
  // número NO están en este Set y sí se procesan.
  if (msg.key?.id && botSentMessageIds.has(msg.key.id)) return;

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
  const quoted = quotedText(msg);

  if (command === "activar" || command === "menu") {
    await send(jid, command === "activar"
      ? "🤖 *BOT ACTIVADO*\n" + menu()
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
      "💰 Suma: *" + money(s.total) + "*\n" +
      "💸 Retiros: *" + money(s.withdrawnTotal) + "*\n" +
      "📊 Disponible: *" + money(s.netTotal) + "*\n" +
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

    // Si se respondió/citó un mensaje con "pag", usa el texto citado.
    if (!args && quoted) args = quoted.replace(/^!/, "").trim();

    if (!args) {
      await send(jid, "❌ Escribe: pag Fulano o responde a un mensaje y escribe pag.");
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
      "✅ *PAGO REGISTRADO*\n" +
      "👤 " + result.person.name + "\n" +
      "💵 " + money(result.total) + "\n" +
      "🧾 " + result.count + " servicio" + (result.count === 1 ? "" : "s") + " liquidado" + (result.count === 1 ? "" : "s")
    );
    return;
  }

  if (command === "transferencia") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();

    // Permite dos formas:
    // 1) "transferencia Fulano 250"
    // 2) Responder a "Fulano 250" y escribir solo "transferencia"
    args = args.split(/\s+/).slice(1).join(" ").trim();
    if (!args && quoted) args = quoted.replace(/^!/, "").trim();

    const a = amountFrom(args);
    if (!a) {
      await send(jid, "❌ Escribe: transferencia Fulano 250 o responde al mensaje de Fulano 250 y escribe transferencia.");
      return;
    }

    const name = cleanName(args, a.raw);
    if (!name) {
      await send(jid, "❌ No pude identificar el nombre.");
      return;
    }

    await addService(name, a.amount, jid, true);
    await send(jid,
      "🔄 *TRANSFERENCIA*\n" +
      "👤 " + name + "\n" +
      "💵 " + money(a.amount) + "\n" +
      "🚫 No se suma al total."
    );
    return;
  }

  if (command === "retiro") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();
    const rest = args.split(/\s+/).slice(1).join(" ").trim();
    const a = amountFrom(rest);

    if (!a) {
      await send(jid, "❌ Escribe: retiro 5000");
      return;
    }

    const s = await servicesSummary();

    if (a.amount > s.netTotal) {
      await send(jid, "❌ El retiro supera el total disponible de " + money(s.netTotal) + ".");
      return;
    }

    const now = new Date();
    await c.withdrawals.insertOne({
      accountNumber: s.account.number,
      amount: a.amount,
      createdAt: now,
      jid
    });

    const updated = await servicesSummary();
    await send(jid,
      "💸 *RETIRO*\n" +
      "💵 " + money(a.amount) + "\n" +
      "📅 " + now.toLocaleString("es-MX", { timeZone: "America/Mexico_City" }) + "\n" +
      "📊 Disponible: " + money(updated.netTotal)
    );
    return;
  }

  if (command === "cuenta_nueva") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();
    const rest = args.split(/\s+/).slice(2).join(" ");
    const a = amountFrom(rest);
    const account = await newAccount(a ? a.amount : 0);

    const { accounts } = await collections();
    const previous = await accounts.findOne(
      { number: account.number - 1 },
      { sort: { closedAt: -1 } }
    );
    const ps = previous?.finalSummary;

    await send(jid,
      "🆕 *CUENTA NUEVA*\n" +
      "📁 Cuenta: *" + account.number + "*\n" +
      "💵 Inicio: *" + money(account.initialAmount) + "*\n" +
      (ps
        ? "\n📌 *CUENTA ANTERIOR*\n" +
          "🧾 Servicios: " + ps.count + "\n" +
          "💰 Suma: " + money(ps.total) + "\n" +
          "💸 Retiros: " + money(ps.withdrawals) + "\n" +
          "📊 Final: " + money(ps.netTotal) + "\n" +
          "⏳ Pendiente: " + money(ps.pending) + "\n" +
          "✅ Pagado: " + money(ps.paid)
        : "\n📚 No había una cuenta anterior.") +
      "\n\n📚 El historial se conserva."
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
          "🔄 *TRANSFERENCIA*\n" +
          "👤 " + name + "\n" +
          "💵 " + money(a.amount) + "\n" +
          "🚫 No se suma al total.");
      } else {
        await send(jid,
          "🧾 *SERVICIO REGISTRADO*\n" +
          "👤 " + name + "\n" +
          "💵 " + money(a.amount));
      }
    }
  }
}

async function resetWhatsAppAuth() {
  const auth = (await collections()).auth;
  await auth.deleteMany({});
  currentQR = null;
  currentPairingCode = null;
  requestedPairingPhone = null;
  pairingInProgress = false;
  botConnected = false;
  console.log("🧹 Sesión de WhatsApp inválida eliminada.");
}

async function start(mode = "qr", phone = "", onCodeReady = null) {
  if (starting || sock) return;
  starting = true;
  loginMode = mode;
  loginPhone = phone;

  try {
    if (!authState) authState = await useMongoDBAuthState("sesion");
    const { state, saveCreds } = authState;
    const latest = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version: latest.version,
      logger,
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: true,
      printQRInTerminal: false,
      getMessage: async () => ({ conversation: "" })
    });

    sock.ev.on("creds.update", saveCreds);

    if (mode === "phone" && !state.creds.me && phone) {
      setTimeout(async () => {
        try {
          requestedPairingPhone = phone;
          const code = await generatePairingCode();
          if (code) {
            console.log("🔢 Código de vinculación generado.");
            if (onCodeReady) {
              const codigoFormat = code?.match(/.{1,4}/g)?.join("-") || code;
              onCodeReady(`
                <div style="font-family: Arial; text-align: center; margin-top: 50px;">
                  <h2>🔢 Tu código de vinculación es:</h2>
                  <h1 style="font-size: 48px; letter-spacing: 5px; color: #25D366; background: #eee; display: inline-block; padding: 10px 20px; border-radius: 10px;">${codigoFormat}</h1>
                  <p>Abre WhatsApp en tu teléfono, ve a <b>Dispositivos Vinculados &gt; Vincular con número de teléfono</b>, e ingresa este código.</p>
                </div>
              `);
              onCodeReady = null;
            }
          }
        } catch (e) {
          console.error("❌ Error al generar código de vinculación:", e?.message || e);
        }
      }, 3000);
    }

    sock.ev.on("connection.update", async update => {
      const connection = update.connection;

      if (update.qr && loginMode === "qr") {
        currentQR = update.qr;
        currentPairingCode = null;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(update.qr)}`;
        if (onCodeReady) {
          onCodeReady(`
            <div style="font-family: Arial; text-align: center; margin-top: 50px;">
              <h2>📱 Escanea este código QR</h2>
              <img src="${qrUrl}" alt="QR Code" style="border: 1px solid #ccc; border-radius: 10px; padding: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);" />
              <p>Abre WhatsApp &gt; Dispositivos Vinculados &gt; Vincular un dispositivo.</p>
            </div>
          `);
          onCodeReady = null;
        }
        console.log("📱 QR generado — disponible únicamente en la página.");
      }

      if (connection === "open") {
        starting = false;
        botConnected = true;
        currentQR = null;
        currentPairingCode = null;
        requestedPairingPhone = null;
        pairingInProgress = false;
        console.log("✅ WhatsApp conectado.");

        if (onCodeReady) {
          onCodeReady(`
            <div style="font-family: Arial; text-align: center; margin-top: 50px;">
              <h2 style="color: #25D366;">✅ ¡Bot vinculado correctamente!</h2>
              <p>El bot ya está en línea y listo para trabajar.</p>
            </div>
          `);
          onCodeReady = null;
        }

        if (OWNER_PHONE) {
          await send(OWNER_PHONE + "@s.whatsapp.net", "🤖 Bot de servicios conectado.\n\nEscribe: menu");
        }
      }

      if (connection === "close") {
        starting = false;
        botConnected = false;
        sock = null;

        const code = update.lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ WhatsApp desconectado (código ${code ?? "desconocido"}). Se reintentará.`);

        if (code === DisconnectReason.loggedOut) {
          currentQR = null;
          currentPairingCode = null;
          requestedPairingPhone = null;
          console.log("🔴 WhatsApp reportó SESIÓN CERRADA (loggedOut). Las credenciales se conservan en MongoDB.");
          return;
        }

        setTimeout(() => start(loginMode || "qr", loginPhone || ""), 3000);
      }
    });

    sock.ev.on("messages.upsert", async event => {
      for (const msg of event.messages) {
        try {
          await handleMessage(msg);
        } catch (error) {
          console.error("❌ Error procesando mensaje:", error?.message || error);
        }
      }
    });
  } catch (error) {
    starting = false;
    sock = null;
    console.error("❌ Error iniciando WhatsApp:", error?.message || error);
    setTimeout(() => start(loginMode || mode, loginPhone || phone), 5000);
  }
}

(async () => {
  await mongo.connect();
  db = mongo.db(DB_NAME);
  await mongoose.connect(MONGO_URI);
  authState = await useMongoDBAuthState("sesion");
  await ensureIndexes();
  await ensureAccount();
  logger.info("MongoDB conectado.");

  if (authState.state.creds.me) {
    console.log("✅ Sesión previa detectada. Arrancando bot automáticamente...");
    await start("qr", "");
  } else {
    console.log("⚠️ No hay sesión de WhatsApp. Entra al panel web para vincular el bot.");
  }
})();