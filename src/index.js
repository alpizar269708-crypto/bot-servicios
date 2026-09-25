
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

const app = express();
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

app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="cache-control" content="no-cache"><title>Bot de Servicios</title><style>body{font-family:Arial,sans-serif;text-align:center;background:#f5f5f5;margin:0;padding:30px;color:#222}.card{max-width:650px;margin:auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 4px 18px rgba(0,0,0,.12)}h1{font-size:28px}.qr{width:min(500px,90vw);height:auto;border:1px solid #ddd;border-radius:12px;padding:10px;background:#fff}.ok{font-size:22px;padding:35px;color:#16803c}.wait{font-size:20px;padding:45px}.code{font-size:34px;font-weight:bold;letter-spacing:6px;padding:25px;background:#f0f0f0;border-radius:12px;margin:20px 0}.buttons{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:20px 0}.btn{border:0;border-radius:10px;padding:14px 18px;font-size:16px;cursor:pointer;background:#222;color:#fff}.btn:hover{opacity:.85}small{color:#777}</style></head><body><div class="card"><h1>🔌 Bot de Servicios</h1><h2>Vinculación de WhatsApp</h2><p>Elige cómo quieres vincular el bot.</p><div class="buttons"><button class="btn" onclick="showQR()">📱 Vincular con QR</button><button class="btn" onclick="showPhone()">🔐 Vincular con número de teléfono</button></div><div id="phoneBox" style="display:none;margin:20px 0"><input id="phoneInput" inputmode="numeric" autocomplete="tel" placeholder="521XXXXXXXXXX" style="width:min(360px,90%);padding:14px;border:1px solid #ccc;border-radius:10px;font-size:18px;text-align:center"><button class="btn" onclick="generatePairing()">Generar código</button><p><small>Escribe el número con código de país, solo números. Ejemplo para México: 521XXXXXXXXXX.</small></p></div><div id="status" class="wait">👆 Elige una opción para vincular WhatsApp.</div></div><script>
let selectedMode = null;

async function showQR(){
  selectedMode = "qr";
  document.getElementById("phoneBox").style.display = "none";
  const el = document.getElementById("status");
  el.className = "wait";
  el.innerHTML = "⏳ Preparando vinculación por QR...";
  await fetch("/qr?_="+Date.now(),{cache:"no-store"}); await update();
}

function showPhone(){
  selectedMode = "phone";
  document.getElementById("phoneBox").style.display = "block";
  document.getElementById("phoneInput").focus();
  const el = document.getElementById("status");
  el.className = "wait";
  el.innerHTML = "📞 Escribe el número que quieres vincular y genera el código.";
}

async function generatePairing(){
  selectedMode = "phone";
  const phone = document.getElementById("phoneInput").value.replace(/\D/g,"");
  const el = document.getElementById("status");
  if(phone.length < 10){
    el.className = "wait";
    el.innerHTML = "❌ Escribe un número válido con código de país.";
    return;
  }
  el.className = "wait";
  el.innerHTML = "⏳ Generando código de vinculación...";
  try{
    const r = await fetch("/pairing?phone="+encodeURIComponent(phone)+"&_="+Date.now(), {cache:"no-store"});
    const data = await r.json();
    if(!data.ok){
      el.className = "wait";
      el.innerHTML = "❌ " + (data.error || "No se pudo generar el código.");
      return;
    }
    await update();
  }catch(e){
    el.className = "wait";
    el.innerHTML = "❌ No se pudo contactar al bot.";
  }
}

async function update(){
  try{
    const r=await fetch("/status?_"+Date.now(),{cache:"no-store"});
    const s=await r.json();
    const el=document.getElementById("status");
    if(s.connected){el.className="ok";el.innerHTML="✅ Bot vinculado correctamente y en línea.";return;}

    if(selectedMode === "qr" && s.qr){
      el.className="";
      el.innerHTML='<img class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=800x800&data='+encodeURIComponent(s.qr)+'&t='+Date.now()+'" alt="Código QR"><p>📱 WhatsApp → Dispositivos vinculados → Vincular un dispositivo.</p>';
      return;
    }

    if(selectedMode === "phone" && s.pairingCode){
      el.className="";
      el.innerHTML='<p>🔐 Código de vinculación</p><div class="code">'+s.pairingCode+'</div><p>En WhatsApp: Dispositivos vinculados → Vincular un dispositivo → Vincular con número de teléfono.</p>';
      return;
    }

    if(!selectedMode){
      el.className="wait";
      el.innerHTML="👆 Elige una opción para vincular WhatsApp.";
      return;
    }

    el.className="wait";
    el.innerHTML=selectedMode === "qr"
      ? "⏳ Esperando a que WhatsApp genere el QR..."
      : "⏳ Esperando a que WhatsApp genere el código...";
  }catch(e){document.getElementById("status").innerHTML="⚠️ Panel esperando al bot...";}
}
update();setInterval(update,120000);
</script></body></html>`);
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
  if (t === "cerrarciclo" || t.startsWith("cerrarciclo ")) return "cerrar_ciclo";

  return null;
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

async function start(mode = "qr", phone = "") {
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