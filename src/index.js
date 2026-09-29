
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

function isDateText(text) {
  return /^(?:\d{1,2}[\\/-]\d{1,2}[\\/-]\d{2,4}|\d{1,2}[\\/-]\d{1,2})$/.test(String(text || "").trim());
}

function amountFrom(text) {
  const value = String(text || "").trim();

  // Las fechas no se interpretan como importes.
  // Ej.: 26/09/26, 26-09-26 o 26/09.
  if (isDateText(value)) return null;

  const m = value.match(/(?:^|\s)\$?\d+(?:[.,]\d{1,2})?(?=\s|$)/);
  if (!m) return null;
  const raw = m[0].trim();

  // Si el texto completo contiene una fecha, no tomamos ninguna
  // de sus partes numéricas como importe.
  const withoutDate = value.replace(/\b\d{1,2}[\\/-]\d{1,2}[\\/-]\d{2,4}\b/g, " ").trim();
  if (!withoutDate || !/(?:^|\s)\$?\d+(?:[.,]\d{1,2})?(?=\s|$)/.test(withoutDate)) return null;

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
  // Los números nunca deben interpretarse como comandos de pago.
  if (!/[a-záéíóúñ]/i.test(w)) return false;
  if (w === "p") return true;
  return fuzzyWord(w, ["pa", "pag", "pago", "pagado", "pagar", "paf"], 1);
}

function isTransferWord(word) {
  const w = norm(word);
  // Los números nunca deben interpretarse como "transferencia".
  if (!/[a-záéíóúñ]/i.test(w)) return false;
  return fuzzyWord(w, ["t", "tr", "tra", "trans", "transf", "transfer", "transferencia"], 1);
}

function isRetiroWord(word) {
  return fuzzyWord(norm(word), ["retiro", "retirar", "ret", "r"], 1);
}

function numberWordToInt(text) {
  const w = norm(text);
  const numbers = {
    uno: 1, una: 1, primero: 1,
    dos: 2, segundo: 2,
    tres: 3, tercero: 3,
    cuatro: 4, cuarto: 4,
    cinco: 5, quinto: 5,
    seis: 6, sexto: 6,
    siete: 7, septimo: 7,
    ocho: 8, octavo: 8,
    nueve: 9, noveno: 9,
    diez: 10, decimo: 10
  };
  return numbers[w] || null;
}

function selectionNumberFromText(text) {
  const raw = norm(text);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return Number(raw);

  const explicit = raw.match(/^(?:la|el|numero|num|número)\s+(\d+)$/i);
  if (explicit) return Number(explicit[1]);

  const word = numberWordToInt(raw);
  if (word) return word;

  const wordExplicit = raw.match(/^(?:la|el|numero|num|número)\s+([a-záéíóúñ]+)$/i);
  if (wordExplicit) return numberWordToInt(wordExplicit[1]);

  return null;
}

function isCancelText(text) {
  return fuzzyWord(norm(text), ["cancelar", "cancela", "cancel", "salir", "no"], 1);
}

function commandOf(text) {
  let t = norm(text);
  if (t.startsWith(PREFIX)) t = t.slice(PREFIX.length).trim();

  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const first = words[0];
  const joined = words.join(" ");

  // "deuda" puede quedar a 2 letras de "ayuda", por eso DEUDORES
  // debe evaluarse antes que MENU/AYUDA.
  if (words.length === 1 && fuzzyWord(first, ["deudores", "deudor", "adeudos", "adeudo", "deudas", "deuda", "pendientes"], 2)) {
    return "deudores";
  }

  if (fuzzyWord(joined, ["menu", "ayuda"], 2)) return "menu";
  if (fuzzyWord(joined, ["menuextra", "comandos", "ayudaextra", "ayudacomandos"], 2)) return "menuextra";
  if (fuzzyWord(joined, ["menusecreto"], 2)) return "menusecreto";
  if (words.length === 1 && isCancelText(first)) return "cancelar";
  if (fuzzyWord(joined, ["activarbotservicios", "activarbotaqui"], 2)) return "activar";
  if (fuzzyWord(joined, ["desactivarbotservicios", "desactivarbotaqui"], 2)) return "desactivar";

  // Comandos simples: solo se comparan cuando no llevan argumentos.
  if (words.length === 1) {
    if (fuzzyWord(first, ["deudores", "deudor", "adeudos", "adeudo", "deudas", "deuda", "pendientes"], 2)) return "deudores";
    if (fuzzyWord(first, ["eliminar", "elimina", "borrar", "borra", "quita", "quitar"], 2)) return "eliminar";
    if (fuzzyWord(first, ["todopagado", "todospagados"], 2)) return "todopagado";
    if (fuzzyWord(first, ["pagados"], 1)) return "pagados";
    if (fuzzyWord(first, ["pagado"], 1)) return "pag";
    if (fuzzyWord(first, ["total"], 1)) return "total";
    if (fuzzyWord(first, ["corte"], 1)) return "corte";
  }

  // Eliminar también acepta argumentos: "eliminar Mari 250".
  if (fuzzyWord(first, ["eliminar", "elimina", "borrar", "borra", "quita", "quitar"], 2)) return "eliminar";

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

  // Mensajes del propio bot, por ejemplo:
  // 🧾 SERVICIO REGISTRADO
  // 👤 Kevin
  // 💵 $135
  const botName = t.match(/^\s*👤\s*(?:Usuario\s*:\s*)?(.+?)\s*$/im);
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

  // Permite "Mari 26/09/26 pagado" o "26/09/26 Mari pagado".
  t = t.replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
    activation: db.collection(COLLECTION + "_activation"),
    pendingActions: db.collection(COLLECTION + "_pending_actions")
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
            transfers: previousSummary.transferTotal,
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
            transfers: previousSummary.transferTotal,
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
    // Si existe un servicio pendiente de esta persona por el mismo importe,
    // la transferencia paga ese servicio en lugar de crear una deuda nueva.
    const pendingService = await c.services.findOne({
      accountNumber: account.number,
      personId: p._id,
      amount: Number(amount),
      status: "pending"
    }, {
      sort: { createdAt: 1 }
    });

    const transferDoc = {
      ...doc,
      status: "recorded"
    };

    if (pendingService) {
      await c.services.updateOne(
        { _id: pendingService._id },
        {
          $set: {
            status: "transfer",
            transferId: pendingService._id
          }
        }
      );

      transferDoc.serviceId = pendingService._id;
    }

    await c.transfers.insertOne(transferDoc);
    return pendingService ? "transfer_paid" : "transfer";
  }

  await c.services.insertOne({ ...doc, status: "pending" });
  return "service";
}

async function servicesSummary() {
  const account = await ensureAccount();
  const c = await collections();
  const { services, transfers } = c;

  const rows = await services.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();

  // Los servicios normales sí suman al total.
  // Las transferencias NO forman parte de la suma de servicios:
  // son salidas de dinero y deben descontarse directamente.
  const serviceTotal = rows.reduce((s, x) => s + Number(x.amount || 0), 0);
  const transferRows = await transfers.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();
  const transferTotal = transferRows.reduce((s, x) => s + Number(x.amount || 0), 0);

  const withdrawalRows = await c.withdrawals.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();
  const withdrawnTotal = withdrawalRows.reduce((s, x) => s + Number(x.amount || 0), 0);

  // Total de servicios = inicio + servicios normales.
  // Disponible/final = total de servicios - transferencias - retiros.
  const total = Number(account.initialAmount || 0) + serviceTotal;
  const netTotal = total - transferTotal - withdrawnTotal;

  const pending = rows.filter(x => x.status === "pending");
  const paid = rows.filter(x => x.status === "paid");

  return {
    account,
    rows,
    total,
    serviceTotal,
    transferRows,
    transferTotal,
    withdrawnTotal,
    netTotal,
    withdrawalRows,
    pendingTotal: pending.reduce((s, x) => s + Number(x.amount || 0), 0),
    paidTotal: paid.reduce((s, x) => s + Number(x.amount || 0), 0)
  };
}

async function undoPayment(name) {
  const account = await ensureAccount();
  const c = await collections();
  const p = await c.people.findOne({ normalizedName: norm(name) });

  if (!p) return { ok: false, reason: "not_found" };

  const payment = await c.payments.findOne(
    { accountNumber: account.number, personId: p._id },
    { sort: { createdAt: -1 } }
  );

  if (!payment || !Array.isArray(payment.serviceIds) || !payment.serviceIds.length) {
    return { ok: false, reason: "none", person: p };
  }

  const result = await c.services.updateMany(
    { _id: { $in: payment.serviceIds }, personId: p._id, status: "paid" },
    { $set: { status: "pending" }, $unset: { paidAt: "" } }
  );

  if (!result.modifiedCount) {
    return { ok: false, reason: "none", person: p };
  }

  await c.payments.deleteOne({ _id: payment._id });

  return {
    ok: true,
    person: p,
    total: Number(payment.amount || 0),
    count: payment.serviceIds.length
  };
}

async function payServices(name, serviceIds) {
  const account = await ensureAccount();
  const c = await collections();
  const p = await c.people.findOne({ normalizedName: norm(name) });

  if (!p) return { ok: false, reason: "not_found" };

  const ids = Array.isArray(serviceIds) ? serviceIds : [];
  if (!ids.length) return { ok: false, reason: "none", person: p };

  const pending = await c.services.find({
    _id: { $in: ids },
    personId: p._id,
    status: "pending"
  }).toArray();

  if (!pending.length) return { ok: false, reason: "none", person: p };

  const total = pending.reduce((s, x) => s + Number(x.amount || 0), 0);
  const realIds = pending.map(x => x._id);

  await c.services.updateMany(
    { _id: { $in: realIds } },
    { $set: { status: "paid", paidAt: new Date() } }
  );

  await c.payments.insertOne({
    accountNumber: account.number,
    personId: p._id,
    personName: p.name,
    amount: total,
    serviceIds: realIds,
    createdAt: new Date()
  });

  return { ok: true, person: p, total, count: pending.length, services: pending };
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

async function deleteService(serviceId) {
  const account = await ensureAccount();
  const c = await collections();

  const service = await c.services.findOne({
    _id: serviceId,
    accountNumber: account.number
  });

  if (!service) return { ok: false, reason: "not_found" };

  // Si ya estaba pagado, quitamos también su referencia del registro de pago.
  if (service.status === "paid") {
    const payment = await c.payments.findOne({
      accountNumber: account.number,
      serviceIds: service._id
    });

    if (payment) {
      const remainingIds = payment.serviceIds.filter(id => String(id) !== String(service._id));
      if (!remainingIds.length) {
        await c.payments.deleteOne({ _id: payment._id });
      } else {
        const remaining = await c.services.find({
          _id: { $in: remainingIds }
        }).toArray();
        const amount = remaining.reduce((s, x) => s + Number(x.amount || 0), 0);
        await c.payments.updateOne(
          { _id: payment._id },
          { $set: { serviceIds: remainingIds, amount } }
        );
      }
    }
  }

  await c.services.deleteOne({ _id: service._id });

  // Evita que una selección pendiente conserve un servicio que ya fue eliminado.
  await c.pendingActions.deleteMany({
    serviceIds: service._id
  });

  return { ok: true, service };
}

async function pendingServicesForPerson(name) {
  const c = await collections();
  const p = await c.people.findOne({ normalizedName: norm(name) });
  if (!p) return { ok: false, reason: "not_found" };

  const rows = await c.services.find({
    personId: p._id,
    status: "pending"
  }).sort({ createdAt: 1 }).toArray();

  return { ok: true, person: p, rows };
}

async function paymentNameMatches(name) {
  const c = await collections();
  const query = norm(name);
  if (!query) return [];

  // Primero buscamos coincidencias directas o por inicio del nombre.
  const escaped = query.replace(/[.*+?^()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^" + escaped + "(?:\\s|$)", "i");

  const directPeople = await c.people.find({
    normalizedName: regex
  }).sort({ normalizedName: 1 }).limit(20).toArray();

  const directCandidates = [];
  for (const p of directPeople) {
    const pending = await c.services.findOne({
      personId: p._id,
      status: "pending"
    });
    if (pending) directCandidates.push(p);
  }

  if (directCandidates.length) return directCandidates;

  // Si no coincide exactamente, buscamos errores pequeños de escritura.
  // Ej.: "ofilia" -> "odilia", "mariaa" -> "maria".
  const people = await c.people.find({}).sort({ normalizedName: 1 }).limit(500).toArray();
  const fuzzyCandidates = [];

  for (const p of people) {
    const normalized = norm(p.normalizedName || p.name);
    if (!normalized) continue;

    const distance = editDistance(query, normalized);
    const maxDistance =
      query.length >= 8 ? 2 :
      query.length >= 5 ? 1 :
      0;

    if (distance > maxDistance) continue;

    const pending = await c.services.findOne({
      personId: p._id,
      status: "pending"
    });

    if (pending) {
      fuzzyCandidates.push({ person: p, distance });
    }
  }

  fuzzyCandidates.sort((a, b) =>
    a.distance - b.distance ||
    norm(a.person.name).localeCompare(norm(b.person.name), "es")
  );

  return fuzzyCandidates.slice(0, 20).map(x => x.person);
}
function formatServiceDate(date) {
  return new Date(date).toLocaleDateString("es-MX", {
    timeZone: "America/Mexico_City",
    dateStyle: "short"
  });
}
function parseDateInput(text) {
  const m = String(text || "").match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return new Date(year, Number(m[2]) - 1, Number(m[1]));
}

function sameLocalDate(a, b) {
  const da = new Date(a);
  return da.toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" }) ===
    b.toLocaleDateString("es-MX");
}

async function allServicesForPerson(name) {
  const c = await collections();
  const p = await c.people.findOne({ normalizedName: norm(name) });
  if (!p) return { ok: false, reason: "not_found" };
  const rows = await c.services.find({ personId: p._id }).sort({ createdAt: 1 }).toArray();
  return { ok: true, person: p, rows };
}



function formatDebtChoices(person, rows) {
  return rows.map((x, i) =>
    (i + 1) + ". 💵 " + money(x.amount) + "   📅 " + formatServiceDate(x.createdAt)
  ).join("\n");
}

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

async function savePendingAction(jid, action) {
  const { pendingActions } = await collections();
  const now = new Date();

  await pendingActions.deleteMany({ jid });
  await pendingActions.insertOne({
    jid,
    ...action,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PENDING_ACTION_TTL_MS)
  });
}

async function getPendingAction(jid) {
  const { pendingActions } = await collections();
  const action = await pendingActions.findOne({ jid });
  if (!action) return null;

  // Las selecciones solo son válidas durante 5 minutos.
  // Para documentos antiguos que no tengan expiresAt, usamos createdAt.
  const createdAt = action.createdAt ? new Date(action.createdAt) : null;
  const expiresAt = action.expiresAt
    ? new Date(action.expiresAt)
    : (createdAt ? new Date(createdAt.getTime() + PENDING_ACTION_TTL_MS) : null);

  if (expiresAt && Date.now() >= expiresAt.getTime()) {
    await pendingActions.deleteOne({ _id: action._id });
    return null;
  }

  return action;
}

async function clearPendingAction(jid) {
  const { pendingActions } = await collections();
  await pendingActions.deleteMany({ jid });
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
    "corte — envía servicios, deudores y cierre de cuenta."
  ].join("\n");
}
function menuExtra() {
  return [
    "🧓 *AYUDA FÁCIL*",
    "",
    "💵 *CUANDO EL BOT PREGUNTA QUÉ DEUDA PAGAR*",
    "Puedes escribir solamente:",
    "• 2",
    "• dos",
    "• la 2",
    "• numero 2",
    "",
    "⏱️ La selección dura 5 minutos.",
    "Puedes responder al mensaje o no responderlo.",
    "",
    "🧹 *SI TE EQUIVOCAS*",
    "Escribe: cancelar",
    "También acepta: cancela, cancel o salir.",
    "",
    "💳 *PAGO CON NOMBRE*",
    "Si el nombre coincide con una persona más específica, el bot te pregunta antes de pagar.",
    "Si hay varias personas con el mismo nombre, te deja escoger por número.",
    "Ejemplo: pagar Mari numero 2",
    "También: pagar Mari la 2",
    "",
    "🗑️ *ELIMINAR UN SERVICIO*",
    "Si hay varios, el bot también te deja escoger por número.",
    "",
    "🔢 *PAGAR VARIOS DEUDORES*",
    "deudoresp 1 3 5",
    "o deudoresp 1-5",
    "",
    "💡 *IMPORTANTE*",
    "Los números solo se usan como selección cuando el bot está esperando una respuesta.",
    "Fuera de ese contexto, no se inventa una acción.",
    "",
    "📋 Para ver el menú normal: menu",
    "🔐 Para ver comandos administrativos: menusecreto"
  ].join("\n");
}
function menuSecreto() {
  return [
    "🔐 *MENÚ SECRETO*",
    "",
    "⚙️ *COMANDOS OCULTOS*",
    "",
    "🔓 activarbotservicios — activa el bot en un grupo.",
    "🔒 desactivarbotservicios — desactiva el bot.",
    "💵 pagados — muestra los servicios que ya fueron pagados."
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

  const quoted = quotedText(msg);

  // Si se responde a un PAGO REGISTRADO y se escribe "error" o una
  // variante con faltas, se deshace ese pago y el servicio vuelve a pendiente.
  let command;
  // Si el bot está esperando que el usuario elija una deuda, una respuesta
  // numérica o por importe se procesa antes que cualquier otro comando.
  const pendingAction = await getPendingAction(jid);
  if (pendingAction && !/PAGO\s+REGISTRADO/i.test(quoted || "") && text.trim()) {
    const choiceText = text.trim();

    if (isCancelText(choiceText)) {
      await clearPendingAction(jid);
      await send(jid, "✅ Selección cancelada. No se hizo ningún cambio.");
      return;
    }


    const selectedNumber = selectionNumberFromText(choiceText);
    const selectedAmount = amountFrom(choiceText);
    const selectedDate = parseDateInput(choiceText);

    if (pendingAction.type === "name_confirm") {
      const answer = norm(choiceText);

      if (answer === "si" || answer === "sí") {
        await clearPendingAction(jid);

        const pending = await pendingServicesForPerson(pendingAction.personName);
        if (!pending.ok || !pending.rows.length) {
          await send(jid, "ℹ️ " + pendingAction.personName + " ya no tiene servicios pendientes.");
          return;
        }

        if (pending.rows.length === 1) {
          const result = await payServices(pending.person.name, [pending.rows[0]._id]);
          if (!result.ok) {
            await send(jid, "ℹ️ Esa deuda ya no está pendiente.");
            return;
          }

          await send(jid,
            "✅ *PAGO REGISTRADO*\n" +
            "👤 " + result.person.name + "\n" +
            "💵 " + money(result.total) +
            (result.count > 1 ? "\n🧾 " + result.count + " servicios" : "")
          );
          return;
        }

        await savePendingAction(jid, {
          type: "pay_select",
          personName: pending.person.name,
          serviceIds: pending.rows.map(x => x._id),
          rows: pending.rows
        });

        await send(jid,
          "💵 *¿QUÉ DEUDA QUIERES PAGAR?*\n\n" +
          "👤 " + pending.person.name + "\n" +
          formatDebtChoices(pending.person, pending.rows) +
          "\n\nPuedes responder al mensaje o escribir el *número* (1, 2, 3...) durante los próximos 5 minutos."
        );
        return;
      }

      if (isCancelText(choiceText)) {
        await clearPendingAction(jid);
        await send(jid, "✅ Selección cancelada. No se hizo ningún cambio.");
        return;
      }

      await send(jid, "❌ Escribe *sí* o *no*.");
      return;
    }

    if (pendingAction.type === "name_select") {
      const selectedNumber = selectionNumberFromText(choiceText);

      if (selectedNumber && pendingAction.candidates[selectedNumber - 1]) {
        const selected = pendingAction.candidates[selectedNumber - 1];
        await clearPendingAction(jid);

        const pending = await pendingServicesForPerson(selected.name);
        if (!pending.ok || !pending.rows.length) {
          await send(jid, "ℹ️ " + selected.name + " ya no tiene servicios pendientes.");
          return;
        }

        if (pending.rows.length === 1) {
          const result = await payServices(pending.person.name, [pending.rows[0]._id]);
          if (!result.ok) {
            await send(jid, "ℹ️ Esa deuda ya no está pendiente.");
            return;
          }

          await send(jid,
            "✅ *PAGO REGISTRADO*\n" +
            "👤 " + result.person.name + "\n" +
            "💵 " + money(result.total) +
            (result.count > 1 ? "\n🧾 " + result.count + " servicios" : "")
          );
          return;
        }

        await savePendingAction(jid, {
          type: "pay_select",
          personName: pending.person.name,
          serviceIds: pending.rows.map(x => x._id),
          rows: pending.rows
        });

        await send(jid,
          "💵 *¿QUÉ DEUDA QUIERES PAGAR?*\n\n" +
          "👤 " + pending.person.name + "\n" +
          formatDebtChoices(pending.person, pending.rows) +
          "\n\nPuedes responder al mensaje o escribir el *número* (1, 2, 3...) durante los próximos 5 minutos."
        );
        return;
      }

      await send(jid, "❌ Escribe el número de la persona que quieres seleccionar.");
      return;
    }

    if (pendingAction.type === "pay_select") {
      let selected = null;
      if (selectedNumber && pendingAction.serviceIds[selectedNumber - 1]) {
        selected = pendingAction.serviceIds[selectedNumber - 1];
      } else if (selectedAmount) {
        const matches = pendingAction.rows.filter(x => Number(x.amount) === Number(selectedAmount.amount));
        if (matches.length === 1) selected = matches[0]._id;
      } else if (selectedDate) {
        const matches = pendingAction.rows.filter(x => sameLocalDate(x.createdAt, selectedDate));
        if (matches.length === 1) selected = matches[0]._id;
      }

      // Si el usuario escribió solamente un número, pero ese número no
      // corresponde a una deuda de la lista, no dejamos que el mensaje
      // se interprete como otra cosa.
      if (selectedNumber && !selected) {
        await send(jid, "❌ Ese número no corresponde a una deuda de *" + pendingAction.personName + "*.");
        return;
      }

      if (selected) {
        const chosen = pendingAction.rows.find(x => String(x._id) === String(selected));

        const result = await payServices(pendingAction.personName, [selected]);
        await clearPendingAction(jid);
        if (result.ok) {
          await send(jid,
            "✅ *PAGO REGISTRADO*\n" +
            "👤 " + result.person.name + "\n" +
            "💵 " + money(result.total) +
            (result.count > 1 ? "\n🧾 " + result.count + " servicios" : "")
          );
        } else {
          await send(jid, "ℹ️ Esa deuda ya no está pendiente.");
        }
        return;
      }
    }

    if (pendingAction.type === "delete_select") {
      let selected = null;
      if (selectedNumber && pendingAction.serviceIds[selectedNumber - 1]) {
        selected = pendingAction.serviceIds[selectedNumber - 1];
      } else if (selectedAmount) {
        const matches = pendingAction.rows.filter(x => Number(x.amount) === Number(selectedAmount.amount));
        if (matches.length === 1) selected = matches[0]._id;
      } else if (selectedDate) {
        const matches = pendingAction.rows.filter(x => sameLocalDate(x.createdAt, selectedDate));
        if (matches.length === 1) selected = matches[0]._id;
      }

      if (selected) {
        const result = await deleteService(selected);
        await clearPendingAction(jid);
        if (result.ok) {
          await send(jid,
            "🗑️ *SERVICIO ELIMINADO*\n" +
            "👤 " + result.service.personName + "\n" +
            "💵 " + money(result.service.amount)
          );
        } else {
          await send(jid, "ℹ️ Ese servicio ya no existe.");
        }
        return;
      }
    }
  }

  if (
    quoted &&
    /PAGO\s+REGISTRADO/i.test(quoted) &&
    /^\s*\S+\s*$/.test(text) &&
    fuzzyWord(norm(text), ["error"], 2)
  ) {
    command = "errorpago";
  } else if (quoted && /^\s*\d+\s*$/.test(text) && /DEUDORES/i.test(quoted)) {
    command = "deudoresp";
  } else {
    command = commandOf(text);
  }

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

  if (command === "cancelar") {
    const pending = await getPendingAction(jid);
    if (pending) {
      await clearPendingAction(jid);
      await send(jid, "✅ Selección cancelada. No se hizo ningún cambio.");
    } else {
      await send(jid, "ℹ️ No hay ninguna selección pendiente.");
    }
    return;
  }

  if (command === "menu") {
    await send(jid, menu());
    return;
  }

  if (command === "menuextra") {
    await send(jid, menuExtra());
    return;
  }

  if (command === "menusecreto") {
    await send(jid, menuSecreto());
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
    const account = await ensureAccount();
    const { services, transfers } = await collections();

    // Una persona con transferencia en este ciclo no se muestra como deudor.
    const transferRows = await transfers.find({
      accountNumber: account.number
    }).toArray();
    const transferredPeople = new Set(
      transferRows.map(x => String(x.personId))
    );

    const rows = await services.find({
      accountNumber: account.number,
      status: "pending",
      personName: { $not: /^retiro$/i }
    }).sort({ createdAt: 1 }).toArray();

    const filteredRows = rows.filter(x => !transferredPeople.has(String(x.personId)));

    if (!filteredRows.length) {
      await send(jid, "✅ No hay deudores pendientes.");
      return;
    }

    const grouped = new Map();
    for (const x of filteredRows) {
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

  if (command === "errorpago") {
    const name = quotedServiceName(quoted);

    if (!name) {
      await send(jid, "❌ No pude identificar el pago que quieres corregir.");
      return;
    }

    const result = await undoPayment(name);

    if (!result.ok) {
      await send(jid,
        result.reason === "not_found"
          ? "❌ No encuentro a *" + name + "*."
          : "ℹ️ No encontré un pago reciente de *" + name + "* para corregir."
      );
      return;
    }

    const rows = await debtors();
    const body = rows.length
      ? rows.map((x, i) =>
          (i + 1) + ". 👤 " + x.name + " — " + money(x.total) +
          "\n   💵 " + money(x.total) + "   📅 " +
          new Date().toLocaleDateString("es-MX", {
            day: "2-digit",
            month: "2-digit",
            year: "2-digit"
          })
        ).join("\n\n")
      : "No hay deudores.";

    const total = rows.reduce((s, x) => s + Number(x.total || 0), 0);

    await send(jid,
      "↩️ *PAGO CORREGIDO*\n" +
      "👤 " + result.person.name + "\n" +
      "💵 " + money(result.total) + "\n\n" +
      "👥 *DEUDORES*\n\n" +
      body +
      "\n\n💰 Total pendiente: " + money(total)
    );
    return;
  }

  if (command === "deudoresp") {
    const numbers = [];
    let argsText = text
      .replace(/\bdeudoresp\b/i, "")
      .trim();

    // Respuesta al mensaje de DEUDORES:
    // escribir solamente "2" paga exactamente al deudor #2
    // que aparece en ESE mensaje.
    if (quoted && /^\s*\d+\s*$/.test(text) && /DEUDORES/i.test(quoted)) {
      const selectedNumber = Number(text.trim());
      const quotedLines = quoted.split(/\r?\n/);

      const selectedLine = quotedLines.find(line => {
        const m = line.match(/^\s*(\d+)\.\s*👤\s*\*?(.+?)\*?\s*[—-]/);
        return m && Number(m[1]) === selectedNumber;
      });

      if (!selectedLine) {
        await send(jid, "❌ Ese número no existe en el mensaje de deudores.");
        return;
      }

      const match = selectedLine.match(/^\s*(\d+)\.\s*👤\s*\*?(.+?)\*?\s*[—-]/);
      const selectedName = match
        ? match[2].replace(/[*_]/g, "").trim()
        : "";

      if (!selectedName) {
        await send(jid, "❌ No pude identificar al deudor seleccionado.");
        return;
      }

      const result = await pay(selectedName);

      if (!result.ok) {
        await send(jid,
          result.reason === "not_found"
            ? "❌ No encuentro a *" + selectedName + "*."
            : "ℹ️ *" + selectedName + "* no tiene servicios pendientes."
        );
        return;
      }

      await send(jid,
        "✅ *PAGO REGISTRADO*\n" +
        "👤 " + result.person.name + "\n" +
        "💵 " + money(result.total) +
        (result.count > 1 ? "\n🧾 " + result.count + " servicios" : "")
      );
      return;
    }

    if (!argsText && /^\s*\d+\s*$/.test(text)) {
      argsText = text.trim();
    }

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

  if (command === "eliminar") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();
    args = args.split(/\s+/).slice(1).join(" ").trim();

    let name = "";
    let targetAmount = null;

    if (quoted && /SERVICIO REGISTRADO|👤/i.test(quoted) && !args) {
      name = quotedServiceName(quoted);
      const qa = amountFrom(quoted);
      if (qa) targetAmount = qa.amount;
    } else {
      const a = amountFrom(args);
      if (a) {
        targetAmount = a.amount;
        name = cleanName(args, a.raw);
      } else {
        name = args;
      }
    }

    if (!name) {
      await send(jid, "❌ Responde al servicio con *eliminar* o escribe: eliminar Mari 250.");
      return;
    }

    const pending = await allServicesForPerson(name);
    if (!pending.ok) {
      await send(jid, "❌ No encuentro a *" + name + "*.");
      return;
    }

    let rows = pending.rows;
    if (targetAmount !== null) {
      rows = rows.filter(x => Number(x.amount) === Number(targetAmount));
    }

    if (!rows.length) {
      await send(jid, "ℹ️ No encontré ese servicio de *" + pending.person.name + "*.");
      return;
    }

    if (rows.length > 1) {
      await savePendingAction(jid, {
        type: "delete_select",
        personName: pending.person.name,
        serviceIds: rows.map(x => x._id),
        rows
      });
      await send(jid,
        "🗑️ *¿QUÉ SERVICIO QUIERES ELIMINAR?*\n\n" +
        "👤 " + pending.person.name + "\n" +
        formatDebtChoices(pending.person, rows) +
        "\n\nPuedes responder al mensaje o escribir el *número* (1, 2, 3...) durante los próximos 5 minutos."
      );
      return;
    }

    const result = await deleteService(rows[0]._id);
    if (!result.ok) {
      await send(jid, "❌ No pude eliminar ese servicio.");
      return;
    }

    await send(jid,
      "🗑️ *SERVICIO ELIMINADO*\n" +
      "👤 " + result.service.personName + "\n" +
      "💵 " + money(result.service.amount)
    );
    return;
  }

  if (command === "total") {
    const s = await servicesSummary();
    await send(jid, money(s.netTotal));
    return;
  }

  if (command === "listaservicios") {
    const s = await servicesSummary();

    const serviceRows = s.rows.map(x => ({
      ...x,
      kind: "service"
    }));

    const transferRows = s.transferRows.map(x => ({
      ...x,
      kind: "transfer"
    }));

    const allRows = [...serviceRows, ...transferRows]
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const body = allRows.length
      ? allRows.map((x, i) => {
          if (x.kind === "transfer") {
            return (i + 1) + ". 🔄 " + x.personName + " — " + money(x.amount) + " *TRANSFERENCIA*";
          }

          if (x.status === "transfer") {
            return (i + 1) + ". 🔄 " + x.personName + " — " + money(x.amount) + " *PAGADO CON TRANSFERENCIA*";
          }

          return (i + 1) + ". " + x.personName + " — " + money(x.amount) +
            (x.status === "paid" ? " ✅" : " ⏳");
        }).join("\n")
      : "No hay servicios registrados.";

    await send(jid,
      "📋 *CUENTA*\n\n" +
      body
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

    let name = paymentNameFromText(args);
    const requestedAmount = amountFrom(args);
    const requestedDate = parseDateInput(args);

    // Formas naturales: "pagar Mari numero 2" / "pagar Mari la 2".
    const indexMatch = norm(args).match(/^(?:p|pa|pag|pago|pagado|pagar)?\\s*(.+?)\\s+(?:la|el|numero|num|número)\\s+(\\d+)$/i);
    const requestedIndex = indexMatch ? Number(indexMatch[2]) : null;
    if (indexMatch) name = indexMatch[1].trim();

    if (!name && quoted) name = quotedServiceName(quoted);

    if (!name) {
      await send(jid, "❌ Escribe el nombre o responde al servicio y escribe un comando de pago.");
      return;
    }

    const nameMatches = await paymentNameMatches(name);

    if (!nameMatches.length) {
      await send(jid, "❌ No encuentro a *" + name + "*.");
      return;
    }

    if (nameMatches.length > 1) {
      await savePendingAction(jid, {
        type: "name_select",
        queryName: name,
        candidates: nameMatches.map(p => ({
          personId: p._id,
          name: p.name
        }))
      });

      await send(jid,
        "👤 *¿A CUÁL TE REFIERES?*\n\n" +
        nameMatches.map((p, i) => (i + 1) + ". " + p.name).join("\n") +
        "\n\nEscribe el número durante los próximos 5 minutos."
      );
      return;
    }

    const matchedPerson = nameMatches[0];

    if (norm(matchedPerson.name) !== norm(name)) {
      await savePendingAction(jid, {
        type: "name_confirm",
        queryName: name,
        personName: matchedPerson.name
      });

      await send(jid,
        "❓ No encontré *" + name + "*.\n¿Es *" + matchedPerson.name + "*?"
      );
      return;
    }

    const pending = await pendingServicesForPerson(matchedPerson.name);
    if (!pending.ok) {
      await send(jid, "❌ No encuentro a *" + name + "*.");
      return;
    }

    let rows = pending.rows;

    if (requestedIndex !== null) {
      if (requestedIndex < 1 || requestedIndex > rows.length) {
        await send(jid, "❌ El número " + requestedIndex + " no existe para *" + pending.person.name + "*.");
        return;
      }
      rows = [rows[requestedIndex - 1]];
    }

    if (requestedAmount && requestedIndex === null) {
      rows = rows.filter(x => Number(x.amount) === Number(requestedAmount.amount));
    }

    if (requestedDate && requestedIndex === null) {
      rows = rows.filter(x => sameLocalDate(x.createdAt, requestedDate));
    }

    if (!rows.length) {
      await send(jid, "ℹ️ *" + pending.person.name + "* no tiene esa deuda pendiente.");
      return;
    }

    if (rows.length === 1) {
      const result = await payServices(pending.person.name, [rows[0]._id]);
      if (!result.ok) {
        await send(jid, "ℹ️ Esa deuda ya no está pendiente.");
        return;
      }

      await send(jid,
        "✅ *PAGO REGISTRADO*\n" +
        "👤 " + result.person.name + "\n" +
        "💵 " + money(result.total) +
        (result.count > 1 ? "\n🧾 " + result.count + " servicios" : "")
      );
      return;
    }

    await savePendingAction(jid, {
      type: "pay_select",
      personName: pending.person.name,
      serviceIds: rows.map(x => x._id),
      rows
    });

    await send(jid,
      "💵 *¿QUÉ DEUDA QUIERES PAGAR?*\n\n" +
      "👤 " + pending.person.name + "\n" +
      formatDebtChoices(pending.person, rows) +
      "\n\nPuedes responder al mensaje o simplemente escribe el *número* (1, 2, 3...) durante los próximos 5 minutos."
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
    const transferSummary = await servicesSummary();
    const ajuste = Number(a.amount || 0);
    await send(jid,
      "🔄 *TRANSFERENCIA*\n" +
      "👤 " + name + "\n" +
      "💵 " + money(a.amount) + "\n\n" +
      "🧮 Ajuste: -" + money(ajuste) + "\n" +
      "💰 Suma actual: *" + money(transferSummary.netTotal) + "*"
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
          "🔄 Transferencias: " + money(ps.transfers || 0) + "\n" +
          "💸 Retiros: " + money(ps.withdrawals) + "\n" +
          "📊 Final: " + money(ps.netTotal) + "\n" +
          "⏳ Pendiente: " + money(ps.pending) + "\n" +
          "✅ Pagado: " + money(ps.paid)
        : "\n📌 Sin cuenta anterior.")
    );
    return;
  }

  if (command === "corte") {
    // El corte envía exactamente 3 mensajes y en este orden:
    // 1) lista de servicios
    // 2) lista de deudores
    // 3) resumen del corte
    const s = await servicesSummary();
    const { accounts, cycles, services } = await collections();
    const closedAt = new Date();

    // MENSAJE 1: LISTA DE SERVICIOS
    const serviceBody = s.rows.length
      ? s.rows.map((x, i) =>
          (i + 1) + ". " + x.personName + " — " + money(x.amount) +
          (x.status === "paid" ? " ✅" : " ⏳")
        ).join("\n")
      : "No hay servicios registrados.";

    await send(jid,
      "📋 *CUENTA*\n\n" +
      serviceBody
    );

    // MENSAJE 2: LISTA DE DEUDORES
    const debtorRows = await services.find({
      status: "pending",
      personName: { $not: /^retiro$/i }
    }).sort({ createdAt: 1 }).toArray();

    if (!debtorRows.length) {
      await send(jid, "👥 *DEUDORES*\n\n✅ No hay deudores pendientes.");
    } else {
      const grouped = new Map();

      for (const x of debtorRows) {
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

      let debtorTotal = 0;
      const debtorBody = [...grouped.values()].map((g, i) => {
        debtorTotal += g.total;

        const details = g.rows.map(x =>
          "   💵 " + money(x.amount) + "   📅 " +
          new Date(x.createdAt).toLocaleDateString("es-MX", {
            timeZone: "America/Mexico_City",
            dateStyle: "short"
          })
        ).join("\n");

        return (i + 1) + ". 👤 *" + g.name + "* — " + money(g.total) +
          "\n" + details;
      }).join("\n\n");

      await send(jid,
        "👥 *DEUDORES*\n\n" +
        debtorBody +
        "\n\n💰 Total pendiente: *" + money(debtorTotal) + "*"
      );
    }

    // Cerramos la cuenta después de enviar las dos listas,
    // para que ambas correspondan al ciclo que se está cerrando.
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
            transfers: s.transferTotal,
            netTotal: s.netTotal,
            pending: s.pendingTotal,
            paid: s.paidTotal
          }
        }
      }
    );

    // MENSAJE 3: CORTE
    const byAmount = new Map();
    for (const row of s.rows) {
      const amount = Number(row.amount || 0);
      byAmount.set(amount, (byAmount.get(amount) || 0) + 1);
    }

    const serviceLines = [...byAmount.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([amount, count]) =>
        money(amount) + "*" + count + "=" + money(amount * count)
      )
      .join("\n");

    const serviceSection = serviceLines || "Sin servicios normales.";

    await send(jid,
      "✂️ *CORTE*\n\n" +
      "📋 *Servicios:*\n" +
      serviceSection + "\n\n" +
      "💰 Suma total: *" + money(s.total) + "*\n" +
      "🔄 Transferencias: *" + money(s.transferTotal) + "*\n" +
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
        const transferSummary = await servicesSummary();
        await send(jid,
          "🔄 *TRANSFERENCIA*\n" +
          "👤 " + name + "\n" +
          "💵 " + money(a.amount) + "\n\n" +
          "💰 Suma actual: *" + money(transferSummary.netTotal) + "*"
        );
      } else {
        const summary = await servicesSummary();
        const serviceCount = summary.rows.length;

        await send(jid,
          "🧾 *SERVICIO " + serviceCount + "*\n" +
          "👤 " + name + "\n" +
          "💵 " + money(a.amount) + "\n\n" +
          "💰 Total: *" + money(summary.total) + "*");
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