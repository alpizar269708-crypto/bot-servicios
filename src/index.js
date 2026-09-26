
require("dotenv").config();

// libsignal (usado internamente por Baileys) puede escribir directamente en stdout/stderr
// objetos enormes de SessionEntry. Filtramos solo esos dumps para no exponer material de sesión.
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function isSessionDump(value) {
  const s = String(value || "");
  return (
    s.includes("Closing session: SessionEntry") ||
    s.includes("Removing old closed session: SessionEntry") ||
    s.includes("Closing stale open session") ||
    s.includes("Closing open session in favor of incoming prekey bundle")
  );
}

console.log = (...args) => {
  if (args.some(isSessionDump)) return;
  originalConsoleLog(...args);
};

console.error = (...args) => {
  if (args.some(isSessionDump)) return;
  originalConsoleError(...args);
};

process.stdout.write = (chunk, ...args) => {
  if (isSessionDump(chunk)) return true;
  return originalStdoutWrite(chunk, ...args);
};

process.stderr.write = (chunk, ...args) => {
  if (isSessionDump(chunk)) return true;
  return originalStderrWrite(chunk, ...args);
};

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
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

// Baileys puede imprimir objetos enormes de sesiones/llaves cuando el nivel de log es alto.
// Lo dejamos silencioso para mantener los logs de Render limpios y no exponer material de sesión.
const logger = pino({ level: "silent" });
const mongo = new MongoClient(MONGO_URI);
let db;
let sock;
let starting = false;
let currentQR = null;
let currentPairingCode = null;
let requestedPairingPhone = null;
let pairingInProgress = false;
let botConnected = false;
let reconnectTimer = null;
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

app.get("/health", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.type("text/plain").send("OK");
});

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
  return "$" + Math.round(Number(n || 0)).toLocaleString("es-MX");
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

function editDistance(a, b) {
  a = String(a || "");
  b = String(b || "");

  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);

      // Acepta letras cambiadas de lugar, por ejemplo "pga" = "pag".
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[a.length][b.length];
}

function fuzzyWord(word, accepted, maxDistance = 1) {
  const w = norm(word);
  return accepted.some(x => editDistance(w, x) <= maxDistance);
}

function fuzzyPhrase(words, acceptedPhrases) {
  return acceptedPhrases.some(phrase => {
    const p = phrase.split(" ");
    if (words.length < p.length) return false;
    return p.every((part, i) => fuzzyWord(words[i], [part], part.length <= 3 ? 1 : 2));
  });
}

function isPaymentWord(word) {
  const w = norm(word);
  if (w === "p") return true;
  return fuzzyWord(w, ["pa", "pag", "pago", "pagado", "pagar", "paf"], 1);
}

function isTransferWord(word) {
  return fuzzyWord(norm(word), ["t", "tr", "tra", "trans", "transf", "transfer", "transferencia"], 1);
}

function isRetiroWord(word) {
  return fuzzyWord(norm(word), ["retiro", "retirar", "ret", "r"], 1);
}

function commandOf(text) {
  let t = norm(text);
  if (t.startsWith(PREFIX)) t = t.slice(PREFIX.length).trim();

  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const first = words[0];
  const joined = words.join(" ");

  if (fuzzyWord(joined, ["menu", "ayuda"], 2)) return "menu";
  if (fuzzyWord(joined, ["activarbotservicios", "activarbotaqui"], 2)) return "activar";
  if (fuzzyWord(joined, ["desactivarbotservicios", "desactivarbotaqui"], 2)) return "desactivar";

  // Comandos simples: solo se comparan cuando no llevan argumentos.
  if (words.length === 1) {
    if (fuzzyWord(first, ["deudores", "deudor"], 1)) return "deudores";
    if (fuzzyWord(first, ["todopagado", "todospagados"], 2)) return "todopagado";
    if (fuzzyWord(first, ["pagados", "pagado"], 2)) return "pagados";
    if (fuzzyWord(first, ["corte"], 1)) return "corte";
  }

  // Pago múltiple: permite argumentos como "deudoresp 1-3 5".
  if (fuzzyWord(first, ["deudoresp"], 1)) return "deudoresp";

  if (fuzzyWord(joined, ["listaservicios"], 2) || fuzzyPhrase(words, ["lista servicios", "lista servicio"])) {
    return "listaservicios";
  }

  if (words.some(isPaymentWord)) return "pag";
  if (words.some(isTransferWord)) return "transferencia";

  if (fuzzyPhrase(words, ["cuenta nueva"]) || fuzzyWord(joined, ["cuentanueva"], 2)) {
    return "cuenta_nueva";
  }

  if (fuzzyPhrase(words, ["corte"])) return "corte";
  if (fuzzyPhrase(words, ["cerrar ciclo"])) return "corte";
  if (isRetiroWord(first)) return "retiro";

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

function quotedServiceName(text) {
  const t = String(text || "").trim();
  if (!t) return "";

  // Mensajes del propio bot.
  const botName = t.match(/(?:👤|Usuario:?)[\\s:*]*([^\\n]+?)(?=\\n|💵|$)/i);
  if (botName) return botName[1].replace(/[*_]/g, "").trim();

  // Mensajes humanos tipo "Persona 250" o "250 Persona".
  const a = amountFrom(t);
  if (a) return cleanName(t, a.raw);

  return t.replace(/^!/, "").trim();
}

function paymentNameFromText(text) {
  let t = String(text || "").trim();
  if (t.startsWith(PREFIX)) t = t.slice(PREFIX.length).trim();

  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return "";

  // Quita la palabra de pago, esté antes o después del nombre.
  t = words.filter(w => !isPaymentWord(w)).join(" ").trim();

  const a = amountFrom(t);
  if (a) t = cleanName(t, a.raw);

  return t.trim();
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
    auth: db.collection(COLLECTION + "_auth"),
    activation: db.collection(COLLECTION + "_activation")
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

async function isActivatedChat(jid) {
  if (!jid || !jid.endsWith("@g.us")) return false;
  const { activation } = await collections();
  const doc = await activation.findOne({ _id: "active" });
  return !!doc && doc.jid === jid;
}

async function activateChat(jid) {
  if (!jid || !jid.endsWith("@g.us")) {
    return { ok: false, reason: "group_only" };
  }

  const { activation } = await collections();
  const current = await activation.findOne({ _id: "active" });

  if (current && current.jid !== jid) {
    return { ok: false, reason: "already_active", jid: current.jid };
  }

  await activation.updateOne(
    { _id: "active" },
    {
      $set: {
        jid,
        activatedAt: current?.activatedAt || new Date()
      }
    },
    { upsert: true }
  );

  return { ok: true };
}

async function deactivateChat(jid) {
  if (!jid || !jid.endsWith("@g.us")) {
    return { ok: false, reason: "group_only" };
  }

  const { activation } = await collections();
  const current = await activation.findOne({ _id: "active" });

  if (!current) {
    return { ok: false, reason: "none" };
  }

  if (current.jid !== jid) {
    return { ok: false, reason: "other_group" };
  }

  await activation.deleteOne({ _id: "active" });
  return { ok: true };
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
  const c = await collections();
  const { services } = c;

  const rows = await services.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();

  // El monto de inicio de "cuenta nueva" forma parte del dinero de la cuenta.
  // No es un servicio ni un deudor, pero sí debe sumarse al total disponible
  // y a la suma acumulada que muestran los reportes.
  const serviceTotal = rows.reduce((s, x) => s + Number(x.amount || 0), 0);
  const total = Number(account.initialAmount || 0) + serviceTotal;
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
    { $match: { status: "pending", personName: { $not: /^retiro$/i } } },
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
    "📋 *MENÚ*",
    "",
    "💵 *PAGO*",
    "Marca un servicio como pagado.",
    "Responde al mensaje del servicio y escribe:",
    "pag, p, pagado o pagar",
    "También puedes escribir: Fulano pag",
    "",
    "🔄 *TRANSFERENCIA*",
    "Registra el pago por transferencia.",
    "No se suma al dinero del corte.",
    "",
    "💸 *RETIRO*",
    "Registra dinero que se entrega o se deposita a Beto.",
    "Ejemplo: retiro 5000",
    "",
    "👥 *DEUDORES*",
    "deudores — ve quiénes deben.",
    "deudoresp 1 3 9 — marca como pagados varios deudores de la lista.",
    "todopagado — marca como pagados a todos los deudores y limpia la lista.",
    "",
    "📋 *LISTA*",
    "lista servicios — consulta los servicios.",
    "",
    "🆕 *CUENTA NUEVA*",
    "Inicia una cuenta nueva con el saldo",
    "que quedó al final de la cuenta anterior.",
    "",
    "✂️ *CORTE*",
    "corte — muestra y cierra la cuenta."
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

  if (command === "activar") {
    const result = await activateChat(jid);

    if (!result.ok) {
      await send(jid,
        result.reason === "group_only"
          ? "❌ Este comando solo funciona dentro de un grupo."
          : "ℹ️ El bot ya está activado en otro grupo."
      );
      return;
    }

    await send(jid, "🤖 *BOT ACTIVADO*\n" + menu());
    return;
  }

  if (command === "desactivar") {
    const result = await deactivateChat(jid);

    if (!result.ok) {
      await send(jid,
        result.reason === "group_only"
          ? "❌ Solo funciona dentro de un grupo."
          : result.reason === "none"
            ? "ℹ️ No hay ningún grupo activo."
            : "ℹ️ Este no es el grupo activo."
      );
      return;
    }

    await send(jid, "🛑 *BOT DESACTIVADO*\nYa puedes activarlo en otro grupo.");
    return;
  }

  // El bot solo funciona en el único grupo que fue activado.
  // Fuera de ese grupo no responde a ningún comando ni registra datos.
  if (!(await isActivatedChat(jid))) return;

  if (command === "menu") {
    await send(jid, menu());
    return;
  }

  if (command === "todopagado") {
    const { services } = await collections();
    const pending = await services.find({
      status: "pending",
      personName: { $not: /^retiro$/i }
    }).sort({ createdAt: 1 }).toArray();

    if (!pending.length) {
      await send(jid, "✅ La lista de deudores ya está vacía.");
      return;
    }

    const grouped = new Map();
    for (const x of pending) {
      const key = String(x.personId);
      if (!grouped.has(key)) {
        grouped.set(key, {
          name: x.personName,
          total: 0
        });
      }
      grouped.get(key).total += Number(x.amount || 0);
    }

    const results = [];
    for (const g of grouped.values()) {
      const result = await pay(g.name);
      if (result.ok) {
        results.push("✅ " + g.name + " — " + money(result.total));
      }
    }

    const total = pending.reduce((sum, x) => sum + Number(x.amount || 0), 0);

    await send(jid,
      "💵 *TODO PAGADO*\n\n" +
      "✅ Se marcaron como pagados todos los deudores.\n" +
      "👥 Deudores liquidados: *" + results.length + "*\n" +
      "💰 Total liquidado: *" + money(total) + "*\n\n" +
      "🧹 La lista de deudores quedó vacía."
    );
    return;
  }

  if (command === "deudores") {
    const { services } = await collections();
    const rows = await services.find({ status: "pending", personName: { $not: /^retiro$/i } }).sort({ createdAt: 1 }).toArray();

    if (!rows.length) {
      await send(jid, "✅ No hay deudores pendientes.");
      return;
    }

    const grouped = new Map();
    for (const x of rows) {
      const key = String(x.personId);
      if (!grouped.has(key)) {
        grouped.set(key, {
          name: x.personName,
          total: 0,
          rows: []
        });
      }
      const g = grouped.get(key);
      g.total += Number(x.amount || 0);
      g.rows.push(x);
    }

    let total = 0;
    const body = [...grouped.values()].map((g, i) => {
      total += g.total;
      const details = g.rows.map(x =>
        "   💵 " + money(x.amount) + "   📅 " + new Date(x.createdAt).toLocaleDateString("es-MX", {
          timeZone: "America/Mexico_City",
          dateStyle: "short"
        })
      ).join("\n");

      return (i + 1) + ". 👤 *" + g.name + "* — " + money(g.total) + "\n" + details;
    }).join("\n\n");

    await send(jid,
      "👥 *DEUDORES*\n\n" + body +
      "\n\n💰 Total pendiente: *" + money(total) + "*"
    );
    return;
  }

  if (command === "deudoresp") {
    const numbers = [];
    const argsText = text
      .replace(/\bdeudoresp\b/i, "")
      .trim();

    for (const part of argsText.split(/\s+/).filter(Boolean)) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);

      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        const step = from <= to ? 1 : -1;

        for (let n = from; step > 0 ? n <= to : n >= to; n += step) {
          if (n > 0) numbers.push(n);
        }
      } else {
        const n = Number(part);
        if (Number.isInteger(n) && n > 0) numbers.push(n);
      }
    }

    const uniqueNumbers = [...new Set(numbers)];

    if (!uniqueNumbers.length) {
      await send(jid,
        "❌ Escribe los números de los deudores.\n" +
        "Ejemplo:\n" +
        "deudoresp\n1\n3\n9"
      );
      return;
    }

    const { services } = await collections();
    const rows = await services.find({
      status: "pending",
      personName: { $not: /^retiro$/i }
    }).sort({ createdAt: 1 }).toArray();

    const grouped = new Map();
    for (const x of rows) {
      const key = String(x.personId);
      if (!grouped.has(key)) {
        grouped.set(key, {
          name: x.personName,
          total: 0,
          rows: []
        });
      }
      const g = grouped.get(key);
      g.total += Number(x.amount || 0);
      g.rows.push(x);
    }

    const debtorsList = [...grouped.values()];
    const selected = [];
    const missing = [];

    for (const n of uniqueNumbers) {
      const g = debtorsList[n - 1];
      if (!g) {
        missing.push(n);
      } else {
        selected.push(g);
      }
    }

    if (!selected.length) {
      await send(jid, "❌ Esos números no existen en la lista de deudores.");
      return;
    }

    const results = [];
    for (const g of selected) {
      const result = await pay(g.name);
      if (result.ok) {
        results.push("✅ " + g.name + " — " + money(result.total));
      } else {
        results.push("⚠️ " + g.name + " — ya no tiene pendientes");
      }
    }

    await send(jid,
      "💵 *PAGOS REGISTRADOS*\n\n" +
      results.join("\n") +
      (missing.length ? "\n\n❌ No existe: " + missing.join(", ") : "")
    );
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
      "📋 *CUENTA*\n\n" +
      body + "\n\n" +
      "📊 Suma: *" + money(s.total) + "*\n" +
      "💸 Retiros: *" + money(s.withdrawnTotal) + "*\n" +
      "💰 Disponible: *" + money(s.netTotal) + "*\n" +
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
      "\n\n💰 Total: *" + money(total) + "*");
    return;
  }

  if (command === "pag") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();

    // Acepta "pag Persona", "Persona pag", "p Persona", "Persona p", etc.
    // Si se responde a cualquier mensaje de servicio, usa el nombre citado.
    let name = paymentNameFromText(args);
    if (!name && quoted) name = quotedServiceName(quoted);

    if (!name) {
      await send(jid, "❌ Escribe el nombre o responde al servicio y escribe cualquier comando de pago que empiece con P.");
      return;
    }

    const result = await pay(name);

    if (!result.ok) {
      await send(jid, result.reason === "not_found"
        ? "❌ No encuentro a *" + name + "*."
        : "ℹ️ *" + result.person.name + "* no tiene servicios pendientes.");
      return;
    }

    await send(jid,
      "✅ *PAGO REGISTRADO*\n" +
      "👤 " + result.person.name + "\n" +
      "💵 " + money(result.total) + "\n" +
      "🧾 " + result.count + " servicio" + (result.count === 1 ? "" : "s")
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
    const c = await collections();

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
      "💰 Queda: " + money(updated.netTotal)
    );
    return;
  }

  if (command === "cuenta_nueva") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();

    // "cuenta nueva" acepta el monto de inicio aunque venga:
    // - con comas: 1,000 / 10,000
    // - sin comas: 1000 / 10000
    // - con espacios: 1 000 / 10 000
    // - en renglones separados: 1\n000
    // - con signo de pesos: $1,000
    // También acepta variantes como "cuenta nueva: 1,000".
    const rest = args
      .replace(/^cuenta\s+nueva\b/i, "")
      .replace(/^cuentanueva\b/i, "")
      .trim();

    const digits = rest.replace(/[^0-9]/g, "");
    const initialAmount = digits ? Number(digits) : 0;
    const account = await newAccount(initialAmount);

    const { accounts } = await collections();
    const previous = await accounts.findOne(
      { number: account.number - 1 },
      { sort: { closedAt: -1 } }
    );
    const ps = previous?.finalSummary;

    await send(jid,
      "🆕 *CUENTA*\n" +
      "💵 Inicio: *" + money(account.initialAmount) + "*\n" +
      (ps
        ? "\n📌 *CUENTA ANTERIOR*\n" +
          "🧾 Servicios: " + ps.count + "\n" +
          "💰 Suma: " + money(ps.total) + "\n" +
          "💸 Retiros: " + money(ps.withdrawals) + "\n" +
          "📊 Final: " + money(ps.netTotal) + "\n" +
          "⏳ Pendiente: " + money(ps.pending) + "\n" +
          "✅ Pagado: " + money(ps.paid)
        : "\n📌 Sin cuenta anterior.")
    );
    return;
  }

  if (command === "corte") {
    const s = await servicesSummary();
    const { accounts, cycles } = await collections();
    const closedAt = new Date();

    await accounts.updateOne(
      { _id: s.account._id },
      { $set: { active: false, closedAt } }
    );
    await cycles.updateOne(
      { accountNumber: s.account.number },
      {
        $set: {
          status: "closed",
          closedAt,
          summary: {
            count: s.rows.length,
            total: s.total,
            withdrawals: s.withdrawnTotal,
            netTotal: s.netTotal,
            pending: s.pendingTotal,
            paid: s.paidTotal
          }
        }
      }
    );

    const serviceAmounts = [250, 35, 300];
    const serviceLines = serviceAmounts
      .map(amount => {
        const count = s.rows.filter(x => Number(x.amount) === amount).length;
        return money(amount) + "*" + count + "=" + money(amount * count);
      })
      .join("\n");

    await send(jid,
      "✂️ *CORTE*\n\n" +
      "📋 *Servicios:*\n" +
      serviceLines + "\n" +
      "💰 Suma: *" + money(s.total) + "*\n" +
      "💸 Retiros: *" + money(s.withdrawnTotal) + "*\n" +
      "⏳ Pendiente: *" + money(s.pendingTotal) + "*\n" +
      "✅ Pagado: *" + money(s.paidTotal) + "*\n\n" +
      "📊 Final: *" + money(s.netTotal) + "*"
    );
    return;
  }

  const raw = text.replace(/^!/, "").trim();
  const a = amountFrom(raw);

  // Nunca registrar como servicio una palabra que parezca un comando.
  // Esto evita que faltas como "retior 1" terminen creando un deudor llamado "retior".
  if (a) {
    const firstWord = norm(raw.split(/\s+/)[0] || "");
    const looksLikeCommand =
      fuzzyWord(firstWord, ["retiro", "retirar", "ret", "r"], 1) ||
      fuzzyWord(firstWord, ["transferencia", "transfer", "transf", "trans"], 2) ||
      fuzzyWord(firstWord, ["p", "pa", "pag", "pago", "pagado", "pagar", "paf"], 1);

    if (looksLikeCommand) return;
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
        const summary = await servicesSummary();
        const serviceCount = summary.rows.length;

        await send(jid,
          "🧾 *SERVICIO REGISTRADO*\n" +
          "👤 " + name + "\n" +
          "💵 " + money(a.amount) + "\n\n" +
          "📊 Servicios registrados: *" + serviceCount + "*\n" +
          "💰 Suma acumulada: *" + money(summary.total) + "*");
      }
    }
  }
}

async function resetWhatsAppAuth() {
  // La sesión REAL de Baileys se guarda en la colección auth_sessions
  // mediante src/mongoAuth.js. La colección bot_servicios_auth es antigua
  // y no debe usarse para borrar la sesión de WhatsApp.
  await mongoose.connection.db.collection("auth_sessions").deleteMany({});
  authState = null;
  currentQR = null;
  currentPairingCode = null;
  requestedPairingPhone = null;
  pairingInProgress = false;
  botConnected = false;
  console.log("🧹 Sesión de WhatsApp inválida eliminada.");
}

function scheduleReconnect() {
  if (reconnectTimer || botConnected || starting) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await start(loginMode || "qr", loginPhone || "");
    } catch (error) {
      console.error("❌ Error en la reconexión:", error?.message || error);
      scheduleReconnect();
    }
  }, 3000);
}

async function start(mode = "qr", phone = "", onCodeReady = null) {
  if (starting || sock) return;
  starting = true;
  loginMode = mode;
  loginPhone = phone;

  try {
    if (!authState) authState = await useMongoDBAuthState("sesion");
    const { state, saveCreds } = authState;
    const latest = await fetchLatestWaWebVersion();

    sock = makeWASocket({
      version: latest.version,
      logger,
      auth: state,
      browser: Browsers.macOS("Chrome"),
      syncFullHistory: false,
      // Este bot no necesita descargar historial de chats. Bloqueamos la
      // sincronización automática de historial para evitar que WhatsApp
      // muestre el aviso de "Sincronizando con WhatsApp..." en el teléfono.
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
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
          console.log("🔴 WhatsApp reportó SESIÓN CERRADA (loggedOut). Eliminando únicamente la sesión de WhatsApp para permitir una nueva vinculación.");
          try {
            await resetWhatsAppAuth();
          } catch (e) {
            console.error("❌ No se pudo limpiar la sesión de WhatsApp:", e?.message || e);
          }
          return;
        }

        scheduleReconnect();
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
    scheduleReconnect();
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