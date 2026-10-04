
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
const OWNER_PHONE = normalizeMxPhone(process.env.OWNER_PHONE);
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

async function cleanupServiceUserAudit(options = {}) {
  try {
    if (!options.atCut) return;

    const c = await collections();

    // La auditoría de usuarios de servicios es SOLO información de control.
    // Al cerrar el corte se conserva la contabilidad normal, pero se borra
    // toda la memoria de quién registró servicios/pagos en el ciclo anterior.
    await c.services.updateMany(
      { recordedBy: { $exists: true } },
      { $unset: { recordedBy: "", recordedByExpiresAt: "" } }
    );

    await c.payments.deleteMany({
      recordedBy: { $exists: true }
    });
  } catch (error) {
    console.error("⚠️ No se pudo limpiar la auditoría de usuarios de servicios:", error?.message || error);
  }
}


function normalizeMxPhone(v) {
  const digits = cleanPhone(v);
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("52")) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith("521")) return digits.slice(3);
  return "";
}

function phoneFromJid(jid) {
  const raw = String(jid || "").trim();
  if (!raw || raw.endsWith("@lid")) return "";
  const value = raw.split("@")[0].split(":")[0];
  return normalizeMxPhone(value);
}

function formatTel(phone) {
  const digits = normalizeMxPhone(phone);
  if (digits.length !== 10) return digits;
  return digits.slice(0, 3) + " " + digits.slice(3, 6) + " " + digits.slice(6);
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

function selectionNumbersFromText(text) {
  const raw = norm(text)
    .replace(/\b(?:las|los|numeros|números|numero|número)\b/g, " ")
    .replace(/\by\b/g, " ")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) return [];

  const numbers = [];
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      const step = from <= to ? 1 : -1;
      for (let n = from; n !== to + step; n += step) numbers.push(n);
      continue;
    }

    if (/^\d+$/.test(part)) {
      numbers.push(Number(part));
      continue;
    }

    const word = numberWordToInt(part);
    if (word) numbers.push(word);
  }

  return [...new Set(numbers)];
}

function isCancelText(text) {
  return fuzzyWord(norm(text), ["cancelar", "cancela", "cancel", "salir", "no"], 1);
}
function isPayAllText(text) {
  const t = norm(text).replace(/[¿?¡!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/^(todos|todo|todas|todos los|todas las)$/.test(t)) return true;
  if (/^(pagar|paga|pago|pagare|quiero pagar|quiero|voy a pagar)\s+(todo|todos|todas|los|las|todos los|todas las)$/.test(t)) return true;
  if (/^(pagar|paga|pago|pagare)\s+(los|las)\s+(todos|todas)$/.test(t)) return true;
  return false;
}

function commandOf(text) {
  const rawInput = String(text || "");
  if (/^\s*!?ajustelista\s*:?(?:\s*\r?\n|\s*$)/i.test(rawInput)) {
    return "ajustelista";
  }

  let t = norm(text);
  if (t.startsWith(PREFIX)) t = t.slice(PREFIX.length).trim();

  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const first = words[0];
  const joined = words.join(" ");

  // Teléfonos: reconocer el comando por prefijo antes de cualquier otro
  // comando/fuzzy matching. Así "vertel Leo", "vertel leo" y similares
  // siempre llegan al buscador de usuarios.
  if (/^(?:vertel|vertelefonos|telefonos|telefonosservicios)$/i.test(first)) {
    return words.length > 1 ? "vertel_busqueda" : "vertel";
  }
  if (/^(?:modtel|modnombre|cambiarnombre|modificartelefono)$/i.test(first)) {
    return "modtel";
  }
  if (/^(?:menutel|menutelefono|menutelefonos)$/i.test(first)) {
    return "menutel";
  }

  // Deshacer movimientos: el comando va primero y el nombre después.
  // Formas aceptadas:
  //   deshacer pago Lali
  //   deshacer transferencia Lali
  //   deshacer Lali  (atajo: deshace el último pago)
  if (fuzzyWord(first, ["deshacer", "deshace", "deshacerlo"], 2)) {
    if (words.length >= 2 && fuzzyWord(words[1], ["pago", "pagado", "pagar", "pag"], 1)) {
      return "deshacer_pago";
    }
    if (words.length >= 2 && fuzzyWord(words[1], ["transferencia", "transfer", "transf"], 2)) {
      return "deshacer_transferencia";
    }
    if (words.length >= 2) return "deshacer_pago";
    return "deshacer";
  }

  // Permite marcar un deudor de la lista como transferencia por número:
  // "2 transferencia" o "transferencia 2".
  if (/^\\d+$/.test(first) && words.length === 2 && /^(transferencia|transfer|transf)$/.test(words[1])) {
    return "transferencia_numero";
  }
  if (/^(transferencia|transfer|transf)$/.test(first) && words.length === 2 && /^\\d+$/.test(words[1])) {
    return "transferencia_numero";
  }

  // "deuda" puede quedar a 2 letras de "ayuda", por eso DEUDORES
  // debe evaluarse antes que MENU/AYUDA.
  if (words.length === 1 && fuzzyWord(first, ["deudores", "deudor", "adeudos", "adeudo", "deudas", "deuda", "pendientes"], 2)) {
    return "deudores";
  }

  // Ajuste administrativo MUY específico: solo reconoce el nombre completo.
  if (joined === "ajustetransferenciacaja") return "ajustetransferenciacaja";

  if (fuzzyWord(joined, ["menu", "ayuda"], 2)) return "menu";
  if (fuzzyWord(joined, ["menuextra", "comandos", "ayudaextra", "ayudacomandos"], 2)) return "menuextra";
  if (fuzzyWord(joined, ["menusecreto"], 2)) return "menusecreto";
  if (fuzzyWord(joined, ["recuperardeudores"], 2)) return "recuperardeudores";
  if (words.length === 1 && isCancelText(first)) return "cancelar";
  if (fuzzyWord(joined, ["activarbotservicios", "activarbotaqui"], 2)) return "activar";
  if (fuzzyWord(joined, ["desactivarbotservicios", "desactivarbotaqui"], 2)) return "desactivar";

  // Menú especial de teléfonos y usuarios de servicios.
  if (words.length <= 2 && (
    fuzzyWord(first, ["menutel", "menutels", "menutelefonos", "menutelefono"], 2) ||
    fuzzyPhrase(words, ["menu tel", "menu telefono", "menu telefonos"])
  )) {
    return "menutel";
  }

  // Control de teléfonos de usuarios de servicios.
  if (fuzzyWord(first, ["vertel", "vertelefonos", "telefonos", "telefonosservicios"], 2)) {
    return words.length > 1 ? "vertel_busqueda" : "vertel";
  }

  // Modificar el nombre de un usuario de servicios.
  if (fuzzyWord(first, ["modtel", "modificartelefono", "modnombre", "cambiarnombre"], 2)) {
    return "modtel";
  }

  // Auditoría por número de usuario operativo:
  // listapagos1, listapagados1, listaservicios1.
  // Así no hace falta escribir el nombre exacto.
  if (words.length === 1) {
    const indexed = first.match(/^(listapagos|listapagados|listaservicios)(\d+)$/i);
    if (indexed) return indexed[1].toLowerCase() === "listaservicios"
      ? "listaserviciosusuario_numero"
      : indexed[1].toLowerCase() + "_numero";
    if (first === "verusuarios") return "verusuarios";
  }

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

  // Auditoría por usuario operativo: listapagos(usuario), listapagados(usuario) y listaservicios(usuario).
  if (/^(listapagos|listapagados)\s*\(.+\)$/i.test(joined) || /^(listapagos|listapagados)\s+.+$/i.test(joined)) {
    return first === "listapagados" ? "listapagados" : "listapagos";
  }
  if (/^listaservicios\s*\(.+\)$/i.test(joined) || /^listaservicios\s+.+$/i.test(joined)) {
    return "listaserviciosusuario";
  }

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
    pendingActions: db.collection(COLLECTION + "_pending_actions"),
    telRecords: db.collection(COLLECTION + "_tel_records"),
    portability: db.collection(COLLECTION + "_portability"),
    serviceUsers: db.collection(COLLECTION + "_arem_users"),
    serviceUserBlocks: db.collection(COLLECTION + "_service_user_blocks")
  };
}

async function isOwnerDirect(jid, msg) {
  if (!OWNER_PHONE || !jid) return false;
  if (jid.endsWith("@g.us")) return false;

  const candidates = new Set();

  const addPhoneFromJid = value => {
    const phone = phoneFromJid(value);
    if (phone) candidates.add(phone);
  };

  addPhoneFromJid(jid);
  addPhoneFromJid(msg?.key?.remoteJidAlt);
  addPhoneFromJid(msg?.key?.senderPn);
  addPhoneFromJid(msg?.key?.participantAlt);
  addPhoneFromJid(msg?.key?.participantPn);

  // WhatsApp puede entregar un chat privado como @lid.
  // Baileys mantiene una tabla interna PN <-> LID cuando la tiene disponible.
  if (jid.endsWith("@lid")) {
    try {
      const mapping = sock?.signalRepository?.lidMapping;
      if (mapping?.getPNForLID) {
        const pn = await mapping.getPNForLID(jid);
        addPhoneFromJid(pn);
      }
    } catch (e) {
      console.log("⚠️ No se pudo resolver LID del propietario:", e?.message || e);
    }
  }

  return [...candidates].some(phone => normalizeMxPhone(phone) === OWNER_PHONE);
}


function ownerPhoneCandidates(jid, msg = null) {
  const candidates = new Set();
  const add = value => {
    const p = phoneFromJid(value);
    if (p) candidates.add(p);
  };
  add(jid);
  add(msg?.key?.remoteJidAlt);
  add(msg?.key?.senderPn);
  add(msg?.key?.participantAlt);
  add(msg?.key?.participantPn);
  return candidates;
}

async function isOwnerAnywhere(jid, msg = null) {
  if (!OWNER_PHONE) return false;
  return [...ownerPhoneCandidates(jid, msg)].some(phone => normalizeMxPhone(phone) === OWNER_PHONE);
}

async function serviceWelcomeText(folio) {
  return (
    "👋 *BIENVENIDO AL BOT DE SERVICIOS*\n\n" +
    "✅ Tu acceso ha sido autorizado.\n" +
    "👤 Usuario: *" + folio + "*\n\n" +

    "📋 *CONSULTAS*\n" +
    "• *deudores* — muestra los deudores pendientes.\n" +
    "• *lista servicios* — muestra la lista de servicios.\n" +
    "• *pagados* — muestra los pagos del ciclo.\n" +
    "• *total* — muestra el total disponible.\n" +
    "• *listapagos(Usuario)* — auditoría de pagos registrados.\n" +
    "• *listapagados(Usuario)* — personas que han pagado.\n" +
    "• *listaservicios(Usuario)* — servicios registrados.\n\n" +

    "💵 *PAGOS*\n" +
    "• *pago 50 Maria la del barrio*\n" +
    "• *50 Maria la del barrio*\n" +
    "• *deudoresp 1 3 9* o *deudoresp 1-5*\n" +
    "• Después de *deudores*, escribe solo el número, por ejemplo *10*, para pagar al deudor #10.\n" +
    "• *deshacer pago Maria*\n" +
    "• *errorpago* — corrige un pago respondiendo a su mensaje.\n\n" +

    "➕ *SERVICIOS*\n" +
    "• *servicio 50 Maria la del barrio*\n" +
    "• *eliminar servicio Maria la del barrio 50*\n" +
    "• *eliminar* — también puede usarse respondiendo a un servicio.\n\n" +

    "💸 *RETIROS*\n" +
    "• *retiro 5000*\n\n" +

    "🧹 *AYUDA*\n" +
    "• *cancelar* — cancela una selección pendiente.\n" +
    "• *menu* / *ayuda* — muestra las opciones disponibles.\n\n" +

    "🔒 *RESTRICCIONES DE ESTE ACCESO*\n" +
    "• No tiene acceso a *corte*.\n" +
    "• No puede crear *cuenta nueva*.\n" +
    "• No puede usar *transferencias* ni deshacer transferencias.\n" +
    "• No puede usar *todopagado*.\n" +
    "• No puede usar *ajustes*, *menuextra* ni *menusecreto*."
  );
}

async function getServiceUserByJid(jid, msg = null) {
  if (!jid || jid.endsWith("@g.us")) return null;
  const candidates = new Set();

  const add = value => {
    const phone = phoneFromJid(value);
    if (phone) candidates.add(phone);
  };

  add(jid);
  add(msg?.key?.remoteJidAlt);
  add(msg?.key?.senderPn);
  add(msg?.key?.participantAlt);
  add(msg?.key?.participantPn);

  if (jid.endsWith("@lid")) {
    try {
      const mapping = sock?.signalRepository?.lidMapping;
      if (mapping?.getPNForLID) add(await mapping.getPNForLID(jid));
    } catch {}
  }

  if (!candidates.size) return null;

  const { serviceUsers } = await collections();
  const normalizedCandidates = [...candidates]
    .map(normalizeMxPhone)
    .filter(Boolean);

  const rows = await serviceUsers.find({
    active: true,
    phone: { $in: normalizedCandidates }
  }).limit(1).toArray();

  return rows[0] || null;
}

function serviceUserLabel(user) {
  const label = String(user?.name || user?.folio || "Usuario").trim() || "Usuario";
  return "(" + label + ")";
}

function serviceUserNameFromArgs(text) {
  let t = String(text || "").trim().replace(/^!/, "").trim();
  const a = amountFrom(t);
  if (!a) return null;

  const name = cleanName(t, a.raw).trim();
  const words = name.split(/\s+/).filter(Boolean);

  if (!name || words.length > 4) return null;

  return { amount: a.amount, name, words };
}

function serviceUserCommandParts(text) {
  return String(text || "")
    .trim()
    .replace(/^!/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

async function serviceGroupJid() {
  const { activation } = await collections();
  const active = await activation.findOne({ _id: "active" });
  return active?.jid || null;
}

async function sendServiceGroupNotice(text) {
  const groupJid = await serviceGroupJid();
  if (!groupJid) return false;
  await send(groupJid, text);
  return true;
}

function compactServiceUserName(value) {
  return norm(String(value || ""))
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function serviceUserEditDistance(a, b) {
  a = compactServiceUserName(a);
  b = compactServiceUserName(b);
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }

  return prev[b.length];
}

async function resolveServiceUserForAudit(name) {
  const value = String(name || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!value) return null;

  const { serviceUsers } = await collections();

  // 1. Coincidencia exacta, ignorando mayúsculas, espacios repetidos y acentos.
  const normalizedValue = compactServiceUserName(value);
  const activeUsers = await serviceUsers.find({ active: true }).toArray();

  let exact = activeUsers.find(x =>
    [x.name, x.folio].some(v => compactServiceUserName(v) === normalizedValue)
  );
  if (exact) return exact;

  // También acepta el teléfono del usuario.
  const phone = value.replace(/\D/g, "");
  if (phone.length >= 10) {
    exact = activeUsers.find(x => String(x.phone || "").replace(/\\D/g, "") === phone);
    if (exact) return exact;
  }

  // 2. Tolerancia a errores de escritura.
  // Ej.: "Juaan", "Juan  ", "J u a n", "BetoAlpizar" o pequeños errores de letras.
  const scored = activeUsers
    .map(x => {
      const candidates = [x.name, x.folio].filter(Boolean);
      let best = Infinity;

      for (const candidate of candidates) {
        const candidateCompact = compactServiceUserName(candidate);
        const distance = serviceUserEditDistance(value, candidate);
        const maxLen = Math.max(normalizedValue.length, candidateCompact.length);
        const ratio = maxLen ? distance / maxLen : 1;
        const prefixBonus =
          candidateCompact.startsWith(normalizedValue) ||
          normalizedValue.startsWith(candidateCompact)
            ? 0.35
            : 0;

        best = Math.min(best, ratio - prefixBonus);
      }

      return { user: x, score: best };
    })
    .sort((a, b) => a.score - b.score);

  if (!scored.length) return null;

  // Tolerancia uniforme: los nombres cortos también pueden tener errores.
  // Aceptamos al menos 1 error de carácter y, conforme crece el nombre,
  // permitimos más errores. La coincidencia más cercana gana.
  const best = scored[0];
  const compactLength = Math.max(
    normalizedValue.length,
    compactServiceUserName(best.user.name || best.user.folio).length
  );
  const maxDistance = compactLength <= 5 ? 1 : compactLength <= 9 ? 2 : 3;
  const bestDistance = Math.min(
    ...[best.user.name, best.user.folio]
      .filter(Boolean)
      .map(candidate => serviceUserEditDistance(value, candidate))
  );

  if (bestDistance <= maxDistance) return best.user;

  return null;
}

function auditUserArg(parts) {
  let raw = parts.slice(1).join(" ").trim();
  if (raw.startsWith("(") && raw.endsWith(")")) raw = raw.slice(1, -1).trim();
  return raw;
}

function auditRowsTotal(rows) {
  return (rows || []).reduce((sum, row) => sum + Number(row?.amount || 0), 0);
}

async function findServiceUsersByNameQuery(query) {
  const value = String(query || "").trim().replace(/\s+/g, " ");
  if (!value) return [];

  const { serviceUsers } = await collections();
  const users = await serviceUsers.find({ active: true })
    .sort({ activatedAt: 1, name: 1 })
    .toArray();

  const q = compactServiceUserName(value);
  if (!q) return [];

  const scored = users.map(user => {
    const candidates = [user.name, user.folio].filter(Boolean);
    let best = Infinity;
    let partial = false;

    for (const candidate of candidates) {
      const original = norm(candidate);
      const compact = compactServiceUserName(candidate);
      if (!compact) continue;

      if (compact === q || compact.includes(q)) {
        best = Math.min(best, compact === q ? -100 : -80);
        partial = true;
        continue;
      }

      const words = original.split(/[\s\-_.,/]+/).filter(Boolean);
      if (words.some(word => compactServiceUserName(word).includes(q))) {
        best = Math.min(best, -70);
        partial = true;
        continue;
      }

      if (q.includes(compact)) {
        best = Math.min(best, -60);
        partial = true;
        continue;
      }

      const distance = serviceUserEditDistance(value, candidate);
      const maxLen = Math.max(q.length, compact.length);
      const ratio = maxLen ? distance / maxLen : 1;
      best = Math.min(best, ratio);
    }

    return { user, score: best, partial };
  }).sort((a, b) => a.score - b.score);

  if (!scored.length) return [];

  // Devuelve TODAS las coincidencias parciales.
  // Ejemplo: "vertel ines" encuentra "Inés" y "Inés-Karla".
  const partialMatches = scored.filter(x => x.partial).map(x => x.user);
  if (partialMatches.length) return partialMatches;

  const qLen = q.length;
  const maxDistance = qLen <= 5 ? 1 : qLen <= 9 ? 2 : 3;

  return scored
    .filter(x => {
      const candidates = [x.user.name, x.user.folio].filter(Boolean);
      const distance = Math.min(
        ...candidates.map(candidate => serviceUserEditDistance(value, candidate))
      );
      return distance <= maxDistance;
    })
    .map(x => x.user);
}

function auditDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

async function handleServiceUserMessage(msg, serviceUser) {
  const jid = msg.key.remoteJid;
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    "";

  const parts = serviceUserCommandParts(text);
  if (!parts.length) return true;

  const first = norm(parts[0]);
  const joined = parts.map(norm).join(" ");

  // Selecciones pendientes de modificación de nombre.
  const pending = await getPendingAction(jid);

  if (pending?.type === "modtel_select") {
    if (!(await isOwnerAnywhere(jid, msg))) {
      await clearPendingAction(jid);
      return true;
    }

    const n = selectionNumberFromText(text.trim());
    const selected = n ? pending.rows?.[n - 1] : null;

    if (!selected) {
      await send(jid, "❌ Escribe el número de la persona que quieres modificar.");
      return true;
    }

    await savePendingAction(jid, {
      type: "modtel_name",
      userId: selected._id,
      oldName: selected.name || selected.folio || "Usuario"
    });

    await send(jid,
      "✏️ *CAMBIAR NOMBRE*\n\n" +
      "👤 Actual: *" + (selected.name || selected.folio || "Usuario") + "*\n\n" +
      "Escribe ahora el *nuevo nombre*."
    );
    return true;
  }

  if (pending?.type === "modtel_name") {
    if (!(await isOwnerAnywhere(jid, msg))) {
      await clearPendingAction(jid);
      return true;
    }

    const newName = String(text || "").trim().replace(/^!/, "").replace(/\s+/g, " ").trim();

    if (!newName || newName.length < 2 || newName.length > 80 || /^(cancelar|cancel)$/i.test(newName)) {
      if (/^(cancelar|cancel)$/i.test(newName)) {
        await clearPendingAction(jid);
        await send(jid, "✅ Modificación cancelada.");
      } else {
        await send(jid, "❌ Escribe un nombre válido para el usuario.");
      }
      return true;
    }

    const { serviceUsers } = await collections();
    const current = await serviceUsers.findOne({ _id: pending.userId, active: true });

    if (!current) {
      await clearPendingAction(jid);
      await send(jid, "❌ Ese usuario ya no está activo.");
      return true;
    }

    await serviceUsers.updateOne(
      { _id: current._id },
      { $set: { name: newName, updatedAt: new Date() } }
    );
    await clearPendingAction(jid);

    await send(jid,
      "✅ *NOMBRE ACTUALIZADO*\n\n" +
      "📱 " + formatTel(current.phone) + "\n" +
      "👤 Antes: *" + (current.name || current.folio || "Usuario") + "*\n" +
      "👤 Ahora: *" + newName + "*"
    );
    return true;
  }

  // Selecciones pendientes exclusivas de Usuario.
  if (pending && (pending.type === "service_user_pay_select" || pending.type === "service_user_delete_select")) {
    const n = selectionNumberFromText(text.trim());

    if (!n || !pending.rows?.[n - 1]) {
      await send(jid, "❌ Escribe el número de la opción que quieres seleccionar.");
      return true;
    }

    const selected = pending.rows[n - 1];
    await clearPendingAction(jid);

    if (pending.type === "service_user_pay_select") {
      const result = await payServices(pending.personName, [selected._id], serviceUser);

      if (!result.ok) {
        await send(jid, "ℹ️ Esa deuda ya no está pendiente.");
        return true;
      }

      await send(jid,
        "✅ *Pago registrado*\n\n" +
        "👤 " + result.person.name + "\n" +
        "💵 " + money(result.total)
      );

      return true;
    }

    const result = await deleteService(selected._id);
    if (!result.ok) {
      await send(jid, "ℹ️ Ese servicio ya no existe.");
      return true;
    }

    await send(jid,
      "🗑️ *Servicio eliminado*\n\n" +
      "👤 " + result.service.personName + "\n" +
      "💵 " + money(result.service.amount)
    );

    await sendServiceGroupNotice(
      "🗑️ *SERVICIO ELIMINADO*\n" +
      "👤 " + result.service.personName + "\n" +
      "💵 " + money(result.service.amount) + "\n" +
      serviceUserLabel(serviceUser)
    );
    return true;
  }

  if (first === "menu" || first === "ayuda") {
    await send(jid, await serviceWelcomeText(serviceUser.name || serviceUser.folio || "Usuario"));
    return true;
  }

  // Consultas informativas del usuario operativo. No calculan ni muestran totales globales.
  if (first === "listapagos" || first === "listapagados") {
    const requested = auditUserArg(parts);
    if (requested && norm(requested) !== norm(serviceUser.name || serviceUser.folio || "")) {
      await send(jid, "🔒 Solo puedes consultar tus propios registros.");
      return true;
    }
    const target = serviceUser;

    if (!target) {
      await send(jid, "❌ No encuentro a ese usuario de servicios.");
      return true;
    }

    const { payments } = await collections();
    const rows = await payments.find({
      "recordedBy.phone": target.phone
    }).sort({ createdAt: -1 }).toArray();

    if (!rows.length) {
      await send(jid, "ℹ️ " + (target.name || target.folio) + " no tiene pagos registrados.");
      return true;
    }

    const body = rows.map((x, i) =>
      (i + 1) + ". 👤 *" + x.personName + "* — " + money(x.amount) +
      ""
    ).join("\n");

    const auditTotal = auditRowsTotal(rows);
    await send(jid,
      "💰 *PAGOS REGISTRADOS POR " + (target.name || target.folio).toUpperCase() + "*\n\n" +
      body +
      "\n\n💰 *TOTAL: " + money(auditTotal) + "*"
    );
    return true;
  }

  if (first === "listaservicios") {
    const requested = auditUserArg(parts);
    if (requested && norm(requested) !== norm(serviceUser.name || serviceUser.folio || "")) {
      await send(jid, "🔒 Solo puedes consultar tus propios registros.");
      return true;
    }
    const target = serviceUser;

    if (!target) {
      await send(jid, "❌ No encuentro a ese usuario de servicios.");
      return true;
    }

    const { services } = await collections();
    const rows = await services.find({
      "recordedBy.phone": target.phone
    }).sort({ createdAt: -1 }).toArray();

    if (!rows.length) {
      await send(jid, "ℹ️ " + (target.name || target.folio) + " no tiene servicios registrados.");
      return true;
    }

    const body = rows.map((x, i) =>
      (i + 1) + ". 👤 *" + x.personName + "*\n" +
      money(x.amount) +
      (auditDate(x.createdAt) ? "\n" + auditDate(x.createdAt) : "")
    ).join("\n\n");

    const auditTotal = auditRowsTotal(rows);
    await send(jid,
      "🧾 *SERVICIOS REGISTRADOS POR " + (target.name || target.folio).toUpperCase() + "*\n\n" +
      body +
      "\n\n💰 *TOTAL: " + money(auditTotal) + "*"
    );
    return true;
  }

  if (
    first === "listaservicios" ||
    (first === "lista" && norm(parts[1] || "") === "servicios") ||
    (first === "deudores" && parts.length === 1)
  ) {
    const { services } = await collections();
    const rows = await services.find({
      status: "pending",
      personName: { $not: /^retiro$/i }
    }).sort({ createdAt: 1 }).toArray();

    if (!rows.length) {
      await send(jid, "✅ No hay deudores pendientes.");
      return true;
    }

    const grouped = new Map();
    for (const x of rows) {
      const key = String(x.personId);
      if (!grouped.has(key)) grouped.set(key, { name: x.personName, total: 0, rows: [] });
      const g = grouped.get(key);
      g.total += Number(x.amount || 0);
      g.rows.push(x);
    }

    const body = [...grouped.values()].map((g, i) => {
      const details = g.rows.map(x =>
        "💵 " + money(x.amount) + "\n" +
        "📅 " + new Date(x.createdAt).toLocaleDateString("es-MX", {
          timeZone: "America/Mexico_City",
          dateStyle: "short"
        })
      ).join("\n");

      return (i + 1) + ". 👤 *" + g.name + "*\n" + details;
    }).join("\n\n");

    await send(jid, "👥 *DEUDORES*\n\n" + body);
    return true;
  }

  if (first === "servicio" || first === "registrarservicio") {
    const parsed = serviceUserNameFromArgs(parts.slice(1).join(" "));
    if (!parsed) {
      await send(jid, "❌ Usa: *servicio 50 Maria la del barrio*\nEl nombre puede tener hasta 4 palabras.");
      return true;
    }

    const type = await addService(parsed.name, parsed.amount, jid, false, serviceUser);
    if (type !== "service") {
      await send(jid, "❌ No pude registrar el servicio.");
      return true;
    }

    await send(jid,
      "✅ *Servicio registrado*\n\n" +
      "👤 " + parsed.name + "\n" +
      "💵 " + money(parsed.amount)
    );

    const summary = await servicesSummary();
    const serviceCount = summary.rows.length;

    await sendServiceGroupNotice(
      "🧾 *SERVICIO " + serviceCount + "*\n" +
      "👤 " + parsed.name + "\n" +
      "💵 " + money(parsed.amount) + "\n\n" +
      "💰 Total: *" + money(summary.accountTotal) + "*\n" +
      serviceUserLabel(serviceUser)
    );
    return true;
  }

  if (first === "pago" || first === "pagar" || first === "pag") {
    const rest = parts.slice(1).join(" ");
    const parsed = serviceUserNameFromArgs(rest);

    if (!parsed) {
      await send(jid, "❌ Usa: *pago 50 Maria la del barrio*\nEl nombre puede tener hasta 4 palabras.");
      return true;
    }

    const nameMatches = await paymentNameMatches(parsed.name);
    if (!nameMatches.length) {
      await send(jid, "❌ No encuentro a *" + parsed.name + "*.");
      return true;
    }

    if (nameMatches.length > 1) {
      await send(jid,
        "👤 *¿A CUÁL TE REFIERES?*\n\n" +
        nameMatches.map((p, i) => (i + 1) + ". " + p.name).join("\n") +
        "\n\nEscribe el número."
      );
      return true;
    }

    const matchedPerson = nameMatches[0];
    const pendingServices = await pendingServicesForPerson(matchedPerson.name);

    if (!pendingServices.ok || !pendingServices.rows.length) {
      await send(jid, "ℹ️ *" + matchedPerson.name + "* no tiene esa deuda pendiente.");
      return true;
    }

    const rows = pendingServices.rows.filter(x => Number(x.amount) === Number(parsed.amount));

    if (!rows.length) {
      await send(jid, "ℹ️ *" + matchedPerson.name + "* no tiene una deuda de " + money(parsed.amount) + ".");
      return true;
    }

    if (rows.length > 1) {
      await savePendingAction(jid, {
        type: "service_user_pay_select",
        personName: matchedPerson.name,
        rows
      });

      await send(jid,
        "💰 *¿QUÉ PAGO QUIERES REGISTRAR?*\n\n" +
        "👤 " + matchedPerson.name + "\n" +
        rows.map((x, i) => (i + 1) + ". " + money(x.amount)).join("\n") +
        "\n\nEscribe el número."
      );
      return true;
    }

    const result = await payServices(matchedPerson.name, [rows[0]._id], serviceUser);
    if (!result.ok) {
      await send(jid, "ℹ️ Esa deuda ya no está pendiente.");
      return true;
    }

    await send(jid,
      "✅ *Pago registrado*\n\n" +
      "👤 " + result.person.name + "\n" +
      "💵 " + money(result.total)
    );

    return true;
  }

  if (first === "deshacer" || first === "deshacerpago" || (first === "deshacer" && norm(parts[1] || "") === "pago")) {
    let nameParts = parts.slice(1);
    if (norm(nameParts[0] || "") === "pago") nameParts.shift();
    const name = nameParts.join(" ").trim();

    if (!name || name.split(/\s+/).length > 4) {
      await send(jid, "❌ Usa: *deshacer pago Maria la del barrio*.");
      return true;
    }

    const result = await undoPayment(name);
    if (!result.ok) {
      await send(jid,
        result.reason === "not_found"
          ? "❌ No encuentro a *" + name + "*."
          : "ℹ️ No encontré un pago reciente de *" + name + "* para deshacer."
      );
      return true;
    }

    await send(jid,
      "↩️ *Pago deshecho*\n\n" +
      "👤 " + result.person.name + "\n" +
      "💵 " + money(result.total)
    );

    await sendServiceGroupNotice(
      "↩️ *PAGO DESHECHO*\n" +
      "👤 " + result.person.name + "\n" +
      "💵 " + money(result.total) + "\n" +
      serviceUserLabel(serviceUser)
    );
    return true;
  }

  if (first === "eliminar" || first === "borrar") {
    let restParts = parts.slice(1);
    if (norm(restParts[0] || "") === "servicio") restParts.shift();

    const rest = restParts.join(" ");
    const a = amountFrom(rest);
    const name = a ? cleanName(rest, a.raw) : rest.trim();

    if (!name || name.split(/\s+/).length > 4) {
      await send(jid, "❌ Usa: *eliminar servicio Maria la del barrio 50*.");
      return true;
    }

    const pendingServices = await allServicesForPerson(name);
    if (!pendingServices.ok || !pendingServices.rows.length) {
      await send(jid, "ℹ️ No encontré servicios de *" + name + "*.");
      return true;
    }

    let rows = pendingServices.rows;
    if (a) rows = rows.filter(x => Number(x.amount) === Number(a.amount));

    if (!rows.length) {
      await send(jid, "ℹ️ No encontré ese servicio de *" + name + "*.");
      return true;
    }

    if (rows.length > 1) {
      await savePendingAction(jid, {
        type: "service_user_delete_select",
        personName: name,
        rows
      });

      await send(jid,
        "🗑️ *¿QUÉ SERVICIO QUIERES ELIMINAR?*\n\n" +
        "👤 " + name + "\n" +
        rows.map((x, i) => (i + 1) + ". " + money(x.amount)).join("\n") +
        "\n\nEscribe el número."
      );
      return true;
    }

    const result = await deleteService(rows[0]._id);
    if (!result.ok) {
      await send(jid, "ℹ️ Ese servicio ya no existe.");
      return true;
    }

    await send(jid,
      "🗑️ *Servicio eliminado*\n\n" +
      "👤 " + result.service.personName + "\n" +
      "💵 " + money(result.service.amount)
    );

    await sendServiceGroupNotice(
      "🗑️ *SERVICIO ELIMINADO*\n" +
      "👤 " + result.service.personName + "\n" +
      "💵 " + money(result.service.amount) + "\n" +
      serviceUserLabel(serviceUser)
    );
    return true;
  }

  // También acepta directamente: "50 Maria la del barrio" como alta de servicio.
  if (/^\$?\d+(?:[.,]\d{1,2})?\s+/.test(text.trim())) {
    const parsed = serviceUserNameFromArgs(text);
    if (parsed) {
      await addService(parsed.name, parsed.amount, jid, false, serviceUser);

      await send(jid,
        "✅ *Servicio registrado*\n\n" +
        "👤 " + parsed.name + "\n" +
        "💵 " + money(parsed.amount)
      );

      const summary = await servicesSummary();
      await sendServiceGroupNotice(
        "🧾 *SERVICIO " + summary.rows.length + "*\n" +
        "👤 " + parsed.name + "\n" +
        "💵 " + money(parsed.amount) + "\n\n" +
        "💰 Total: *" + money(summary.accountTotal) + "*\n" +
        serviceUserLabel(serviceUser)
      );
      return true;
    }
  }

  // Cualquier otro comando queda simplemente sin acción administrativa.
  await send(jid, "ℹ️ Usa *menu* para ver las opciones disponibles.");
  return true;
}

function normalizeStoredName(value) {
  return norm(String(value || "").replace(/\s+/g, " ").trim());
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}
function splitNameAndPhoneArgs(args) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;

  const phoneIndex = parts.findIndex(x => /^\d{10}$/.test(String(x).replace(/\D/g, "")));
  if (phoneIndex < 1) return null;

  const phone = String(parts[phoneIndex]).replace(/\D/g, "");
  let before = parts.slice(0, phoneIndex);
  let emailSuffix = "";

  if (before.length && /^\d{2}$/.test(before[before.length - 1])) {
    emailSuffix = before.pop();
  }

  const name = before.join(" ").trim();
  if (!name) return null;

  return { name, phone, emailSuffix };
}

function splitPortabilityArgs(args) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 4) return null;

  let emailSuffix = "";
  if (/^\d{2}$/.test(parts[parts.length - 1])) {
    emailSuffix = parts.pop();
  }

  if (parts.length < 4) return null;

  const keep = String(parts.pop()).replace(/\D/g, "");
  const temporary = String(parts.pop()).replace(/\D/g, "");
  const imei = String(parts.pop()).replace(/\D/g, "");
  const name = parts.join(" ").trim();

  if (!name || !/^\d{15}$/.test(imei) || !/^\d{10}$/.test(temporary) || !/^\d{10}$/.test(keep)) {
    return null;
  }

  return { name, imei, temporary, keep, emailSuffix };
}

async function saveTelRecord(args, jid) {
  const parsed = splitNameAndPhoneArgs(args);
  if (!parsed) return { ok: false };

  const c = await collections();
  const doc = {
    name: parsed.name,
    normalizedName: normalizeStoredName(parsed.name),
    phone: parsed.phone,
    emailSuffix: parsed.emailSuffix || "",
    createdAt: new Date(),
    createdBy: jid
  };

  await c.telRecords.insertOne(doc);
  return { ok: true, doc };
}

async function findTelRecords(query) {
  const q = String(query || "").trim();
  const nq = normalizeStoredName(q);
  const digits = q.replace(/\D/g, "");
  const { telRecords } = await collections();

  if (/^\d{10}$/.test(digits) && !/[a-záéíóúñ]/i.test(q)) {
    return telRecords.find({ phone: digits }).sort({ createdAt: 1 }).toArray();
  }

  if (!nq) return [];

  // Buscar por CONTENIDO, no solo por coincidencia exacta o por el inicio.
  // Así "vertel leo" encuentra "Leo", "Leonardo", "Leo-Karla", "Juan-Leo", etc.
  // También funciona con acentos porque normalizedName ya está normalizado.
  return telRecords.find({
    normalizedName: { $regex: escapeRegex(nq) }
  }).sort({ createdAt: 1 }).toArray();
}

async function allTelRecords() {
  const { telRecords } = await collections();
  return telRecords.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
}

async function deleteTelRecord(id) {
  const { telRecords } = await collections();
  const row = await telRecords.findOne({ _id: id });

  if (!row) return { ok: false, reason: "not_found" };

  await telRecords.deleteOne({ _id: row._id });
  return { ok: true, doc: row };
}

async function finishPortability(query, jid) {
  const rows = await findPortability(query);
  if (!rows.length) return { ok: false, count: 0, reason: "not_found" };

  const c = await collections();
  const saved = [];

  for (const x of rows) {
    const doc = {
      name: x.name,
      normalizedName: normalizeStoredName(x.name),
      phone: x.keep,
      emailSuffix: x.emailSuffix || "",
      createdAt: new Date(),
      createdBy: jid,
      source: "portafin"
    };
    await c.telRecords.insertOne(doc);
    saved.push(doc);
  }

  await c.portability.deleteMany({ _id: { $in: rows.map(x => x._id) } });
  return { ok: true, count: saved.length, records: saved };
}

async function saveTelRecordsMassive(raw, jid) {
  const lines = String(raw || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const records = [];
  const invalid = [];

  for (const line of lines) {
    const parts = line.split(/\s+/).filter(Boolean);
    const phoneIndex = parts.findIndex(x => /^\d{10}$/.test(String(x).replace(/\D/g, "")));
    if (phoneIndex < 1) {
      invalid.push(line);
      continue;
    }

    const phone = String(parts[phoneIndex]).replace(/\D/g, "");
    let before = parts.slice(0, phoneIndex);
    let emailSuffix = "";

    if (before.length && /^\d{2}$/.test(before[before.length - 1])) {
      emailSuffix = before.pop();
    }

    const name = before.join(" ").trim();
    if (!name) {
      invalid.push(line);
      continue;
    }

    records.push({
      name,
      normalizedName: normalizeStoredName(name),
      phone,
      emailSuffix,
      createdAt: new Date(),
      createdBy: jid,
      source: "guardartelmasivo"
    });
  }

  if (!records.length) return { ok: false, saved: 0, invalid: lines.length };

  const c = await collections();
  const result = await c.telRecords.insertMany(records);
  return { ok: true, saved: result.insertedCount, invalid: invalid.length };
}

async function savePortability(args, jid) {
  const parsed = splitPortabilityArgs(args);
  if (!parsed) return { ok: false };

  const c = await collections();
  const doc = {
    name: parsed.name,
    normalizedName: normalizeStoredName(parsed.name),
    imei: parsed.imei,
    temporary: parsed.temporary,
    keep: parsed.keep,
    emailSuffix: parsed.emailSuffix || "",
    createdAt: new Date(),
    createdBy: jid
  };

  await c.portability.insertOne(doc);
  return { ok: true, doc };
}

async function findPortability(query) {
  const nq = normalizeStoredName(query);
  if (!nq) return [];
  const { portability } = await collections();

  return portability.find({
    $or: [
      { normalizedName: nq },
      { normalizedName: { $regex: "^" + escapeRegex(nq) + "\\s" } }
    ]
  }).sort({ createdAt: 1 }).toArray();
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
  await c.people.createIndex({ normalizedName: 1 }, { unique: true });  await c.services.createIndex({ accountNumber: 1, status: 1 });  await c.services.createIndex({ personId: 1, status: 1 });
  await c.payments.createIndex({ accountNumber: 1 });
  await c.telRecords.createIndex({ normalizedName: 1 });
  await c.telRecords.createIndex({ phone: 1 });
  await c.portability.createIndex({ normalizedName: 1 });
  await c.serviceUsers.createIndex({ phone: 1 }, { unique: true });
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

async function addService(name, amount, jid, transfer, recordedBy = null) {
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

  if (recordedBy?.phone) {
    doc.recordedBy = {
      phone: recordedBy.phone,
      name: recordedBy.name || recordedBy.folio || "Usuario",
      folio: recordedBy.folio || recordedBy.name || "Usuario"
    };
  }

  if (transfer) {
    // Si existe un servicio pendiente de esta persona por el mismo importe,
    // la transferencia paga ese servicio en lugar de crear una deuda nueva.
    const pendingService = await c.services.findOne({
      accountNumber: account.number,
      personId: p._id,
      amount: Number(amount),
      transferId: { $exists: false },
      status: "pending"
    }, {
      sort: { createdAt: 1 }
    });

    // Si el servicio ya fue marcado como pagado y después se registra
    // que ese pago fue por transferencia, lo enlazamos sin duplicarlo
    // ni convertirlo nuevamente en deuda.
    const paidService = pendingService ? null : await c.services.findOne({
      accountNumber: account.number,
      personId: p._id,
      amount: Number(amount),
      transferId: { $exists: false },
      status: "paid"
    }, {
      sort: { createdAt: 1 }
    });

    const linkedService = pendingService || paidService;

    const transferDoc = {
      ...doc,
      status: "recorded"
    };

    if (linkedService) {
      const update = {
        $set: {
          transferId: linkedService._id
        }
      };

      // Si seguía pendiente, la transferencia la deja pagada por transferencia.
      // Si ya estaba pagada, conserva "paid" y solo enlaza el movimiento.
      if (linkedService.status === "pending") {
        update.$set.status = "transfer";
      }

      await c.services.updateOne(
        { _id: linkedService._id },
        update
      );

      transferDoc.serviceId = linkedService._id;
    }

    await c.transfers.insertOne(transferDoc);
    return linkedService ? "transfer_paid" : "transfer";
  }

  await c.services.insertOne({ ...doc, status: "pending" });
  return "service";
}

async function reconcileTransfers() {
  const account = await ensureAccount();
  const c = await collections();

  const transfers = await c.transfers.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();

  for (const transfer of transfers) {
    if (transfer.serviceId) continue;

    // Primero intenta enlazar una deuda pendiente; si el servicio ya fue
    // marcado como pagado, también puede enlazarse sin cambiar su estado.
    const service = await c.services.findOne({
      accountNumber: account.number,
      personId: transfer.personId,
      amount: Number(transfer.amount || 0),
      transferId: { $exists: false },
      status: { $in: ["pending", "paid"] }
    }, {
      sort: { createdAt: 1 }
    });

    if (!service) continue;

    await c.services.updateOne(
      { _id: service._id },
      {
        $set: {
          status: "transfer",
          transferId: transfer._id
        }
      }
    );

    await c.transfers.updateOne(
      { _id: transfer._id },
      { $set: { serviceId: service._id } }
    );
  }
}

async function servicesSummary() {
  await reconcileTransfers();
  const account = await ensureAccount();
  const c = await collections();
  const { services, transfers } = c;

  const rows = await services.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();

  // Todos los servicios cuentan para la suma bruta de control,
  // aunque estén pendientes, pagados o pagados por transferencia.
  // La transferencia se resta UNA sola vez al calcular el efectivo disponible.
  const serviceTotal = rows.reduce(
    (s, x) => s + Number(x.amount || 0),
    0
  );
  const transferRows = await transfers.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();
  const transferTotal = transferRows.reduce((s, x) => s + Number(x.amount || 0), 0);

  const withdrawalRows = await c.withdrawals.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();
  const withdrawnTotal = withdrawalRows.reduce((s, x) => s + Number(x.amount || 0), 0);

  // TOTAL CONTABLE = inicio + todos los servicios.
  // Esto se conserva para corte y control, incluyendo pendientes.
  const total = Number(account.initialAmount || 0) + serviceTotal;

  const pending = rows.filter(x => x.status === "pending");
  const paid = rows.filter(x => x.status === "paid");

  // CAJA DISPONIBLE = inicio + pagos en efectivo - retiros.
  // Un servicio pendiente todavía no ha entrado a caja.
  // Un servicio marcado como "transfer" tampoco entra a caja porque
  // el dinero llegó por transferencia y no está físicamente en efectivo.
  // Por eso NO debemos restar transferencias de un total que ya excluye
  // esos servicios; hacerlo provocaría un cálculo incorrecto.
  const paidTotal = paid.reduce((s, x) => s + Number(x.amount || 0), 0);
  const netTotal = Number(account.initialAmount || 0) + paidTotal - withdrawnTotal;

  // TOTAL GENERAL = suma total - transferencias - retiros.
  // Pendientes y pagados son solo informativos y NO participan en este cálculo.
  // Este es el importe que deben usar "total", "corte" y los mensajes de alta de servicio.
  const accountTotal = total - transferTotal - withdrawnTotal;

  return {
    account,
    rows,
    total,
    accountTotal,
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

async function undoTransfer(name) {
  const account = await ensureAccount();
  const c = await collections();
  const p = await c.people.findOne({ normalizedName: norm(name) });

  if (!p) return { ok: false, reason: "not_found" };

  const transfer = await c.transfers.findOne(
    { accountNumber: account.number, personId: p._id, status: "recorded" },
    { sort: { createdAt: -1 } }
  );

  if (!transfer) return { ok: false, reason: "none", person: p };

  // Si la transferencia estaba enlazada a un servicio, quitamos el enlace.
  // Un servicio marcado específicamente como "transfer" vuelve a pendiente.
  if (transfer.serviceId) {
    await c.services.updateOne(
      { _id: transfer.serviceId, personId: p._id, status: "transfer" },
      {
        $set: { status: "pending" },
        $unset: { transferId: "" }
      }
    );

    // Si por alguna razón el servicio conserva el enlace pero ya no está
    // en estado transfer, al menos quitamos el transferId.
    await c.services.updateOne(
      { _id: transfer.serviceId, personId: p._id },
      { $unset: { transferId: "" } }
    );
  }

  await c.transfers.deleteOne({ _id: transfer._id });

  return {
    ok: true,
    person: p,
    total: Number(transfer.amount || 0)
  };
}

async function payServices(name, serviceIds, recordedBy = null) {
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

  const paymentDoc = {
    accountNumber: account.number,
    personId: p._id,
    personName: p.name,
    amount: total,
    serviceIds: realIds,
    createdAt: new Date()
  };

  if (recordedBy?.phone) {
    paymentDoc.recordedBy = {
      phone: recordedBy.phone,
      name: recordedBy.name || recordedBy.folio || "Usuario",
      folio: recordedBy.folio || recordedBy.name || "Usuario"
    };
  }

  await c.payments.insertOne(paymentDoc);

  if (recordedBy?.phone) {
    await sendServiceGroupNotice(
      "💰 *PAGO REGISTRADO*\n" +
      "👤 " + p.name + "\n" +
      "💵 " + money(total) + "\n" +
      serviceUserLabel(recordedBy)
    );
  }

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

async function transferServices(name, serviceIds, jid) {
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
  }).sort({ createdAt: 1 }).toArray();

  if (!pending.length) return { ok: false, reason: "none", person: p };

  let total = 0;

  for (const service of pending) {
    const transferResult = await c.transfers.insertOne({
      accountNumber: account.number,
      personId: p._id,
      personName: p.name,
      amount: Number(service.amount),
      status: "recorded",
      serviceId: service._id,
      createdAt: new Date(),
      jid
    });

    await c.services.updateOne(
      { _id: service._id, personId: p._id, status: "pending" },
      {
        $set: {
          status: "transfer",
          transferId: transferResult.insertedId
        }
      }
    );

    total += Number(service.amount || 0);
  }

  return { ok: true, person: p, total, count: pending.length, services: pending };
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

function isAdjustListText(text) {
  return /^\s*!?ajustelista\s*:?(?:\s*\r?\n|\s*$)/i.test(String(text || ""));
}

function parseAdjustList(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const accountLine = lines.find(line => /\bCUENTA\b/i.test(line));
  const accountMatch = accountLine?.match(/\bCUENTA\b\s*[*_:=-]*\s*\$?\s*([\d][\d,\.\s]*)/i);

  if (!accountMatch) {
    return { ok: false, error: "No encontré la cuenta inicial. Usa: 📋 *CUENTA 41,300*" };
  }

  const initialDigits = accountMatch[1].replace(/[^0-9]/g, "");
  const initialAmount = initialDigits ? Number(initialDigits) : 0;

  if (!Number.isFinite(initialAmount) || initialAmount < 0) {
    return { ok: false, error: "La cuenta inicial no es válida." };
  }

  const rows = [];

  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s*(.*?)\s*[—-]\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(.*)$/);
    if (!m) continue;

    const number = Number(m[1]);
    const name = m[2]
      .replace(/[*_]/g, "")
      .replace(/^🔄\s*/u, "")
      .trim();

    const amount = Number(m[3].replace(/,/g, ""));
    const tail = m[4] || "";

    const transfer = /TRANSFERENCIA/i.test(tail);
    const paid = !transfer && tail.includes("✅");
    const pending = !transfer && tail.includes("⏳");

    if (!name || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "Hay un servicio mal formado en la línea " + number + "." };
    }

    if (!transfer && !paid && !pending) {
      return { ok: false, error: "No pude identificar el estado del servicio #" + number + "." };
    }

    rows.push({
      number,
      name,
      amount,
      status: transfer ? "transfer" : (paid ? "paid" : "pending")
    });
  }

  rows.sort((a, b) => a.number - b.number);

  if (!rows.length) {
    return { ok: false, error: "No encontré servicios en la lista." };
  }

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].number !== i + 1) {
      return { ok: false, error: "La numeración debe ir del 1 al " + rows.length + " sin saltos." };
    }
  }

  return { ok: true, initialAmount, rows };
}

async function overwriteCurrentAccountFromList(jid, parsed) {
  const account = await ensureAccount();
  const c = await collections();
  const now = new Date();

  // Conserva fechas e IDs cuando el servicio ya existe con el mismo
  // nombre e importe; la lista nueva redefine sus estados.
  const oldRows = await c.services.find({
    accountNumber: account.number
  }).sort({ createdAt: 1 }).toArray();

  const reusable = new Map();
  for (const row of oldRows) {
    const key = norm(row.personName) + "|" + Number(row.amount || 0);
    if (!reusable.has(key)) reusable.set(key, []);
    reusable.get(key).push(row);
  }

  // Esta lista reemplaza TODO el contenido contable del ciclo actual.
  await c.services.deleteMany({ accountNumber: account.number });
  await c.payments.deleteMany({ accountNumber: account.number });
  await c.transfers.deleteMany({ accountNumber: account.number });
  await c.withdrawals.deleteMany({ accountNumber: account.number });
  await c.pendingActions.deleteMany({});

  await c.accounts.updateOne(
    { _id: account._id },
    {
      $set: {
        initialAmount: parsed.initialAmount,
        active: true,
        closedAt: null
      },
      $unset: { finalSummary: "" }
    }
  );

  await c.cycles.updateOne(
    { accountNumber: account.number },
    {
      $set: {
        initialAmount: parsed.initialAmount,
        status: "active",
        closedAt: null
      },
      $unset: { summary: "" }
    },
    { upsert: true }
  );

  const paidByPerson = new Map();

  for (const row of parsed.rows) {
    const p = await person(row.name, jid);
    const key = norm(p.name) + "|" + Number(row.amount);
    const bucket = reusable.get(key) || [];
    const old = bucket.shift();
    reusable.set(key, bucket);

    const createdAt = old?.createdAt || now;
    const serviceDoc = {
      ...(old?._id ? { _id: old._id } : {}),
      accountNumber: account.number,
      personId: p._id,
      personName: p.name,
      amount: Number(row.amount),
      status: row.status,
      createdAt
    };

    if (row.status === "paid") {
      serviceDoc.paidAt = old?.paidAt || now;
    }

    const serviceResult = await c.services.insertOne(serviceDoc);
    const serviceId = serviceResult.insertedId;

    if (row.status === "transfer") {
      const transferResult = await c.transfers.insertOne({
        accountNumber: account.number,
        personId: p._id,
        personName: p.name,
        amount: Number(row.amount),
        status: "recorded",
        serviceId,
        createdAt,
        jid
      });

      await c.services.updateOne(
        { _id: serviceId },
        { $set: { transferId: transferResult.insertedId } }
      );
    }

    if (row.status === "paid") {
      const personKey = String(p._id);

      if (!paidByPerson.has(personKey)) {
        paidByPerson.set(personKey, {
          accountNumber: account.number,
          personId: p._id,
          personName: p.name,
          amount: 0,
          serviceIds: [],
          createdAt: old?.paidAt || old?.createdAt || now
        });
      }

      const payment = paidByPerson.get(personKey);
      payment.amount += Number(row.amount);
      payment.serviceIds.push(serviceId);
    }
  }

  const paymentDocs = [...paidByPerson.values()];
  if (paymentDocs.length) {
    await c.payments.insertMany(paymentDocs);
  }

  const summary = await servicesSummary();

  return {
    account: summary.account,
    serviceCount: summary.rows.length,
    total: summary.total,
    transferTotal: summary.transferTotal,
    netTotal: summary.netTotal,
    accountTotal: summary.accountTotal
  };
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
    "💰 *TOTAL*",
    "total — muestra el dinero disponible sin hacer corte.",
    "",
    "📋 *LISTA*",
    "lista servicios — consulta los servicios.",
    "listapagos(usuario) — pagos registrados por ese usuario.",
    "listapagados(usuario) — personas que han pagado a ese usuario.",
    "listaservicios(usuario) — servicios registrados por ese usuario.",
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
    "💵 pagados — muestra los servicios que ya fueron pagados.",
    "🛠️ ajustelista — reemplaza la cuenta actual con una lista completa.",
    "🧾 ajustetransferenciacaja Rosy 300 — ajuste manual específico para descontar una transferencia de caja."
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

  return result;}
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

  // Respuesta a una solicitud de reingreso de usuario de servicios.
  if (jid.endsWith("@g.us")) {
    const { pendingActions, serviceUsers, serviceUserBlocks } = await collections();
    const approval = await pendingActions.findOne({ jid, type: "service_activation_approval" });
    if (approval) {
      const expiresAt = approval.expiresAt ? new Date(approval.expiresAt) : null;
      if (expiresAt && Date.now() >= expiresAt.getTime()) {
        await pendingActions.deleteOne({ _id: approval._id });
      } else if (await isOwnerAnywhere(jid, msg)) {
        const answer = norm(text).replace(/[^0-9]/g, "");
        if (answer === "1" || answer === "2") {
          await pendingActions.deleteOne({ _id: approval._id });

          if (answer === "2") {
            await send(jid, "❌ *SOLICITUD NO AUTORIZADA*\nEl acceso no fue concedido.");
            return;
          }

          await serviceUsers.updateMany({ active: true }, { $set: { active: false, updatedAt: new Date() } });
          await serviceUsers.updateOne(
            { phone: approval.phone },
            {
              $set: {
                phone: approval.phone,
                name: approval.folio,
                folio: approval.folio,
                active: true,
                activatedAt: new Date(),
                updatedAt: new Date()
              }
            },
            { upsert: true }
          );
          await serviceUserBlocks.deleteOne({ phone: approval.phone });
          await send(jid, "✅ *ACCESO AUTORIZADO*\n👤 " + approval.folio + " ya puede utilizar los servicios.");
          await send(approval.requestJid, "✅ *USUARIO DE SERVICIOS ACTIVADO*\n\n" + await serviceWelcomeText(approval.folio));
          return;
        }
      }
    }
  }

  const quoted = quotedText(msg);

  // El usuario operativo trabaja exclusivamente por chat privado y con permisos limitados.
  // Su flujo se corta aquí para que jamás llegue a los comandos administrativos del bot.
  // Alta por privado. Si el número fue dado de baja, requiere autorización en el grupo.
  if (!jid.endsWith("@g.us")) {
    const rawActivation = text.trim().replace(/^!/, "").trim();
    const activationMatch = rawActivation.match(/^activarservicios(?:\s+(.+)|\((.*)\))$/i);
    if (activationMatch) {
      const folio = String(activationMatch[1] || activationMatch[2] || "").trim();
      if (!folio) {
        await send(jid, "❌ Usa: *activarservicios Usuario* o *activarservicios(Usuario)*");
        return;
      }

      const candidates = ownerPhoneCandidates(jid, msg);
      const phone = [...candidates][0];
      if (!phone) {
        await send(jid, "❌ No pude identificar tu número de WhatsApp.");
        return;
      }

      const { serviceUsers, serviceUserBlocks, activation, pendingActions } = await collections();
      const blocked = await serviceUserBlocks.findOne({ phone });

      if (blocked) {
        const active = await activation.findOne({ _id: "active" });
        const groupJid = active?.jid || null;
        if (!groupJid) return;

        const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS);
        await pendingActions.deleteMany({ type: "service_activation_approval", phone });
        await pendingActions.updateOne(
          { jid: groupJid, type: "service_activation_approval" },
          {
            $set: {
              jid: groupJid,
              type: "service_activation_approval",
              phone,
              requestJid: jid,
              folio,
              createdAt: new Date(),
              expiresAt
            }
          },
          { upsert: true }
        );

        await sendServiceGroupNotice(
          "🔐 *SOLICITUD DE ACCESO*\n\n" +
          "👤 *" + folio + "* quiere volver a registrarse como usuario de servicios.\n\n" +
          "¿Autorizas que pueda hacer uso de los servicios del bot?\n\n" +
          "👉 Responde *1* para autorizar\n" +
          "👉 Responde *2* para rechazar\n\n" +
          "⏱️ Tienes *5 minutos* para responder."
        );
        return;
      }

      await serviceUsers.updateMany({ active: true }, { $set: { active: false, updatedAt: new Date() } });
      await serviceUsers.updateOne(
        { phone },
        { $set: { phone, name: folio, folio, active: true, activatedAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
      await send(jid, "✅ *USUARIO DE SERVICIOS ACTIVADO*\n\n" + await serviceWelcomeText(folio));
      return;
    }
  }

  // Un usuario dado de baja no recibe ninguna respuesta salvo al intentar solicitar su reingreso.
  if (!jid.endsWith("@g.us")) {
    const { serviceUserBlocks } = await collections();
    const blockedPhoneCandidates = [...ownerPhoneCandidates(jid, msg)];
    if (blockedPhoneCandidates.length) {
      const blocked = await serviceUserBlocks.findOne({ phone: { $in: blockedPhoneCandidates } });
      if (blocked) return;
    }
  }

  // Los comandos ocultos del propietario deben evaluarse antes del flujo del usuario de servicios.
  // Así el propietario puede administrar bajas aunque también tenga acceso operativo.
  if (await isOwnerDirect(jid, msg) && !jid.endsWith("@g.us")) {
    const rawDirectOwner = text.trim().replace(/^!/, "").trim();
    const bajaOwnerMatch = rawDirectOwner.match(/^bajaservicios(?:\s+(.+)|\((.*)\))$/i);
    if (bajaOwnerMatch) {
      const rawName = String(bajaOwnerMatch[1] || bajaOwnerMatch[2] || "").trim();
      if (!rawName) return;
      const { serviceUsers, serviceUserBlocks } = await collections();
      const target = await serviceUsers.findOne({
        active: true,
        $or: [
          { name: { $regex: "^" + escapeRegex(rawName) + "$", $options: "i" } },
          { folio: { $regex: "^" + escapeRegex(rawName) + "$", $options: "i" } },
          { phone: rawName }
        ]
      });
      if (!target) {
        await send(jid, "ℹ️ No encontré un usuario de servicios activo con ese nombre.");
        return;
      }
      await serviceUsers.deleteOne({ _id: target._id });
      await serviceUserBlocks.updateOne(
        { phone: target.phone },
        { $set: { phone: target.phone, name: target.name || target.folio || "Usuario", blockedAt: new Date() } },
        { upsert: true }
      );
      await send(jid,
        "🛑 *USUARIO DADO DE BAJA*\n\n" +
        "👤 " + (target.name || target.folio || "Usuario") + "\n" +
        "El usuario fue eliminado de la lista de accesos.\n" +
        "Si intenta registrarse nuevamente, necesitará autorización en el grupo."
      );
      return;
    }
  }

  const serviceUser = await getServiceUserByJid(jid, msg);

  // El usuario de servicios usa el mismo flujo y comandos del bot principal.
  // Sus únicas restricciones son:
  // 1) no puede ejecutar CORTE;
  // 2) CUENTA NUEVA no muestra los importes de la cuenta anterior.
  // Todo lo demás funciona igual que para el bot principal.

  // Si se responde a un PAGO REGISTRADO y se escribe "error" o una
  // variante con faltas, se deshace ese pago y el servicio vuelve a pendiente.
  let command;
  // Si el bot está esperando que el usuario elija una deuda, una respuesta
  // numérica o por importe se procesa antes que cualquier otro comando.
  const pendingAction = await getPendingAction(jid);
  if (pendingAction && !isAdjustListText(text) && !/PAGO\s+REGISTRADO/i.test(quoted || "") && text.trim()) {
    const choiceText = text.trim();

    if (pendingAction.type === "service_user_debt_select") {
      const selectedNumber = selectionNumberFromText(choiceText);
      const selected = selectedNumber ? pendingAction.rows?.[selectedNumber - 1] : null;

      if (!selected) {
        await send(jid, "❌ Ese número no existe en la lista de deudores.");
        return;
      }

      await clearPendingAction(jid);

      const result = await payServices(selected.name, selected.serviceIds || [], serviceUser);
      if (!result.ok) {
        await send(jid, "ℹ️ *" + selected.name + "* ya no tiene servicios pendientes.");
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

    if (pendingAction.type === "transfer_select" && isPayAllText(choiceText)) {
      const result = await transferServices(
        pendingAction.personName,
        pendingAction.serviceIds || [],
        jid
      );
      await clearPendingAction(jid);

      if (result.ok) {
        const transferSummary = await servicesSummary();
        await send(jid,
          "🔄 *TRANSFERENCIAS REGISTRADAS*\n" +
          "👤 " + result.person.name + "\n" +
          "🧾 " + result.count + " servicios\n" +
          "💵 " + money(result.total) + "\n\n" +
          "🧮 Ajuste: -" + money(result.total) + "\n" +
          "💰 Suma actual: *" + money(transferSummary.netTotal) + "*"
        );
      } else {
        await send(jid, "ℹ️ Esas deudas ya no están pendientes.");
      }
      return;
    }

    if (pendingAction.type === "pay_select" && isPayAllText(choiceText)) {
      const result = await payServices(pendingAction.personName, pendingAction.serviceIds || [], serviceUser || null);
      await clearPendingAction(jid);
      if (result.ok) {
        await send(jid, "✅ *TODOS LOS PAGOS REGISTRADOS*\n👤 " + result.person.name + "\n🧾 " + result.count + " servicios\n💵 " + money(result.total));
      } else {
        await send(jid, "ℹ️ Esas deudas ya no están pendientes.");
      }
      return;
    }

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
          const result = await payServices(pending.person.name, [pending.rows[0]._id], serviceUser || null);
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
          const result = await payServices(pending.person.name, [pending.rows[0]._id], serviceUser || null);
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

    if (pendingAction.type === "tel_delete_select") {
      if (selectedNumber && pendingAction.recordIds[selectedNumber - 1]) {
        const selectedId = pendingAction.recordIds[selectedNumber - 1];
        const result = await deleteTelRecord(selectedId);
        await clearPendingAction(jid);

        if (!result.ok) {
          await send(jid, "ℹ️ Ese registro ya no existe.");
          return;
        }

        await send(jid,
          "✅ *TELÉFONO ELIMINADO*\n" +
          "👤 " + result.doc.name + "\n" +
          "📱 " + formatTel(result.doc.phone) +
          (result.doc.emailSuffix ? "  ✉️ .." + result.doc.emailSuffix : "")
        );
        return;
      }

      await send(jid, "❌ Escribe el número del registro que quieres eliminar.");
      return;
    }

    if (pendingAction.type === "transfer_select") {
      const numbers = selectionNumbersFromText(choiceText);
      const validNumbers = numbers.filter(n =>
        n >= 1 && n <= pendingAction.serviceIds.length
      );

      if (!validNumbers.length) {
        await send(jid, "❌ Escribe *todos* o los números de las deudas que quieres transferir. Ejemplo: *1 3*.");
        return;
      }

      if (numbers.some(n => n < 1 || n > pendingAction.serviceIds.length)) {
        await send(jid, "❌ Uno de los números no corresponde a una deuda de *" + pendingAction.personName + "*.");
        return;
      }

      const selectedIds = validNumbers.map(n => pendingAction.serviceIds[n - 1]);
      const result = await transferServices(pendingAction.personName, selectedIds, jid);
      await clearPendingAction(jid);

      if (result.ok) {
        const transferSummary = await servicesSummary();
        await send(jid,
          "🔄 *TRANSFERENCIA REGISTRADA*\n" +
          "👤 " + result.person.name + "\n" +
          "🧾 " + result.count + " " + (result.count === 1 ? "servicio" : "servicios") + "\n" +
          "💵 " + money(result.total) + "\n\n" +
          "🧮 Ajuste: -" + money(result.total) + "\n" +
          "💰 Suma actual: *" + money(transferSummary.netTotal) + "*"
        );
      } else {
        await send(jid, "ℹ️ Esas deudas ya no están pendientes.");
      }
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

        const result = await payServices(pendingAction.personName, [selected], serviceUser || null);
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

  if (serviceUser) {
    const blockedServiceCommands = new Set([
      "corte",
      "cuenta_nueva",
      "transferencia",
      "transferencia_numero",
      "deshacer_transferencia",
      "ajustelista",
      "ajustetransferenciacaja",
      "todopagado",
      "menuextra",
      "menusecreto"
    ]);

    if (blockedServiceCommands.has(command)) {
      await send(jid, "🔒 Ese comando no está disponible para tu acceso.");
      return;
    }
  }

  if (command === "deshacer" || command === "deshacer_pago" || command === "deshacer_transferencia") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();

    const parts = args.split(/\\s+/).filter(Boolean);
    if (parts.length && fuzzyWord(parts[0], ["deshacer", "deshace", "deshacerlo"], 2)) parts.shift();

    let mode = command === "deshacer_transferencia" ? "transferencia" : "pago";
    if (parts.length && fuzzyWord(parts[0], ["pago", "pagado", "pagar", "pag"], 1)) {
      mode = "pago";
      parts.shift();
    } else if (parts.length && fuzzyWord(parts[0], ["transferencia", "transfer", "transf"], 2)) {
      mode = "transferencia";
      parts.shift();
    }

    const name = parts.join(" ").trim();

    if (!name) {
      await send(jid,
        "❌ Escribe: *deshacer pago Lali*\n" +
        "o: *deshacer transferencia Lali*"
      );
      return;
    }

    if (mode === "pago") {
      const result = await undoPayment(name);

      if (!result.ok) {
        await send(jid,
          result.reason === "not_found"
            ? "❌ No encuentro a *" + name + "*."
            : "ℹ️ No encontré un pago reciente de *" + name + "* para deshacer."
        );
        return;
      }

      await send(jid,
        "↩️ *PAGO DESHECHO*\n" +
        "👤 " + result.person.name + "\n" +
        "💵 " + money(result.total) + "\n" +
        "⏳ La deuda volvió a quedar pendiente."
      );
      return;
    }

    const result = await undoTransfer(name);

    if (!result.ok) {
      await send(jid,
        result.reason === "not_found"
          ? "❌ No encuentro a *" + name + "*."
          : "ℹ️ No encontré una transferencia reciente de *" + name + "* para deshacer."
      );
      return;
    }

    const summary = await servicesSummary();
    await send(jid,
      "↩️ *TRANSFERENCIA DESHECHA*\n" +
      "👤 " + result.person.name + "\n" +
      "💵 " + money(result.total) + "\n" +
      "💰 Total actual: *" + money(summary.accountTotal) + "*\n" +
      "⏳ La deuda volvió a quedar pendiente."
    );
    return;
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

  // Comandos privados: SOLO el número dueño y SOLO por chat directo.
  // Nunca se ejecutan en grupos ni para otros números.
  if (await isOwnerDirect(jid, msg)) {
    const rawDirect = text.trim().replace(/^!/, "").trim();
    const directParts = rawDirect.split(/\s+/).filter(Boolean);
    const directCommand = norm(directParts[0] || "");

    // Comando interno y oculto: baja definitiva del usuario de servicios.
    const bajaMatch = rawDirect.match(/^bajaservicios(?:\s+(.+)|\((.*)\))$/i);
    if (bajaMatch) {
      const rawName = String(bajaMatch[1] || bajaMatch[2] || "").trim();
      if (!rawName) return;

      const { serviceUsers, serviceUserBlocks } = await collections();
      const target = await serviceUsers.findOne({
        active: true,
        $or: [
          { name: { $regex: "^" + escapeRegex(rawName) + "$", $options: "i" } },
          { folio: { $regex: "^" + escapeRegex(rawName) + "$", $options: "i" } },
          { phone: rawName }
        ]
      });

      if (!target) {
        await send(jid, "ℹ️ No encontré un usuario de servicios activo con ese nombre.");
        return;
      }

      await serviceUsers.deleteOne({ _id: target._id });
      await serviceUserBlocks.updateOne(
        { phone: target.phone },
        {
          $set: {
            phone: target.phone,
            name: target.name || target.folio || "Usuario",
            blockedAt: new Date()
          }
        },
        { upsert: true }
      );

      await send(jid,
        "🛑 *USUARIO DADO DE BAJA*\n\n" +
        "👤 " + (target.name || target.folio || "Usuario") + "\n" +
        "El usuario fue eliminado de la lista de accesos.\n" +
        "Si intenta registrarse nuevamente, necesitará autorización en el grupo."
      );
      return;
    }

    if (directCommand === "desactivarservicios") {
      const { serviceUsers } = await collections();
      const current = await getServiceUserByJid(jid, msg);
      if (!current) {
        await send(jid, "ℹ️ No tienes un usuario de servicios activo.");
        return;
      }
      await serviceUsers.updateOne({ _id: current._id }, { $set: { active: false, updatedAt: new Date() } });
      await send(jid, "✅ *USUARIO DE SERVICIOS DESACTIVADO*");
      return;
    }

    if (directCommand === "menucfe") {
      await send(jid,
        "📱 *MENÚ PORTA*\n\n" +
        "1. Guardartel nombre 10dígitos 2dígitos(opcional)\n" +
        "2. Vertel nombre\n" +
        "3. Portabilidad nombre IMEI(15) temporal(10) conservar(10) 2dígitos(opcional)\n" +
        "4. Portafin nombre\n" +
        "5. Guardartelmasivo + lista\n" +
        "6. Vertodos\n" +
        "7. Eliminartel número | nombre | teléfono"
      );
      return;
    }

    if (directCommand === "guardartel") {
      const result = await saveTelRecord(directParts.slice(1).join(" "), jid);
      if (!result.ok) {
        await send(jid, "❌ Usa: Guardartel nombre 10dígitos 2dígitos(opcional)");
        return;
      }
      await send(jid,
        "✅ *TELÉFONO GUARDADO*\n" +
        "👤 " + result.doc.name + "\n" +
        "📱 " + formatTel(result.doc.phone) +
        (result.doc.emailSuffix ? "\n✉️ .." + result.doc.emailSuffix : "")
      );
      return;
    }

    if (directCommand === "vertel") {
      const query = directParts.slice(1).join(" ").trim();
      if (!query) {
        await send(jid, "❌ Usa: Vertel nombre");
        return;
      }
      const rows = await findTelRecords(query);
      if (!rows.length) {
        await send(jid, "ℹ️ No encontré registros para *" + query + "*.");
        return;
      }
      const body = rows.map((x, i) =>
        (i + 1) + ". 👤 *" + x.name + "*\n" +
        "📱 " + formatTel(x.phone) +
        (x.emailSuffix ? "  ✉️ .." + x.emailSuffix : "")
      ).join("\n\n");
      await send(jid, "📱 *TELÉFONOS*\n\n" + body);
      return;
    }

    if (directCommand === "vertodos") {
      const rows = await allTelRecords();

      if (!rows.length) {
        await send(jid, "ℹ️ No hay teléfonos guardados.");
        return;
      }

      const body = rows.map((x, i) =>
        (i + 1) + ". 👤 *" + x.name + "*\n" +
        "📱 " + formatTel(x.phone) +
        (x.emailSuffix ? "  ✉️ .." + x.emailSuffix : "")
      ).join("\n\n");

      await send(jid, "📱 *TODOS LOS TELÉFONOS*\n\n" + body);
      return;
    }

    if (directCommand === "portabilidad") {
      const result = await savePortability(directParts.slice(1).join(" "), jid);
      if (!result.ok) {
        await send(jid, "❌ Usa: Portabilidad nombre IMEI(15) temporal(10) conservar(10) 2dígitos(opcional)");
        return;
      }
      await send(jid,
        "✅ *PORTABILIDAD GUARDADA*\n" +
        "👤 " + result.doc.name + "\n" +
        "📱 Temporal: " + result.doc.temporary + "\n" +
        "🔢 Conserva: " + result.doc.keep +
        (result.doc.emailSuffix ? "\n✉️ .." + result.doc.emailSuffix : "")
      );
      return;
    }

    if (directCommand === "portafin") {
      const query = directParts.slice(1).join(" ").trim();
      if (!query) {
        await send(jid, "❌ Usa: Portafin nombre");
        return;
      }
      const result = await finishPortability(query, jid);
      if (!result.ok) {
        await send(jid, "ℹ️ No encontré una portabilidad para *" + query + "*.");
        return;
      }
      const body = result.records.map((x, i) =>
        (result.records.length > 1 ? (i + 1) + ". " : "") +
        "👤 *" + x.name + "*\n" +
        "📱 " + formatTel(x.phone) +
        (x.emailSuffix ? "  ✉️ .." + x.emailSuffix : "")
      ).join("\n\n");
      await send(jid, "✅ *PORTABILIDAD FINALIZADA*\n\n" + body);
      return;
    }

    if (directCommand === "eliminartel") {
      const query = directParts.slice(1).join(" ").trim();

      if (!query) {
        await send(jid, "❌ Usa: Eliminartel número | nombre | teléfono");
        return;
      }

      // Número corto: posición del registro en Vertodos.
      if (/^\d{1,6}$/.test(query)) {
        const index = Number(query);
        const rows = await allTelRecords();

        if (!rows[index - 1]) {
          await send(jid, "❌ Ese número no existe en la lista.");
          return;
        }

        const result = await deleteTelRecord(rows[index - 1]._id);

        if (!result.ok) {
          await send(jid, "ℹ️ Ese registro ya no existe.");
          return;
        }

        await send(jid,
          "✅ *TELÉFONO ELIMINADO*\n" +
          "👤 " + result.doc.name + "\n" +
          "📱 " + formatTel(result.doc.phone) +
          (result.doc.emailSuffix ? "  ✉️ .." + result.doc.emailSuffix : "")
        );
        return;
      }

      // Teléfono exacto de 10 dígitos.
      if (/^\d{10}$/.test(query)) {
        const rows = await findTelRecords(query);

        if (!rows.length) {
          await send(jid, "ℹ️ No encontré ese teléfono.");
          return;
        }

        if (rows.length > 1) {
          await savePendingAction(jid, {
            type: "tel_delete_select",
            recordIds: rows.map(x => x._id)
          });

          await send(jid,
            "🗑️ *¿CUÁL QUIERES ELIMINAR?*\n\n" +
            rows.map((x, i) =>
              (i + 1) + ". 👤 *" + x.name + "*\n📱 " + formatTel(x.phone) +
              (x.emailSuffix ? "  ✉️ .." + x.emailSuffix : "")
            ).join("\n\n") +
            "\n\nEscribe el número durante 5 minutos."
          );
          return;
        }

        const result = await deleteTelRecord(rows[0]._id);

        if (!result.ok) {
          await send(jid, "ℹ️ Ese registro ya no existe.");
          return;
        }

        await send(jid,
          "✅ *TELÉFONO ELIMINADO*\n" +
          "👤 " + result.doc.name + "\n" +
          "📱 " + formatTel(result.doc.phone) +
          (result.doc.emailSuffix ? "  ✉️ .." + result.doc.emailSuffix : "")
        );
        return;
      }

      // Nombre exacto o por prefijo, igual que Vertel.
      const rows = await findTelRecords(query);

      if (!rows.length) {
        await send(jid, "ℹ️ No encontré registros para *" + query + "*.");
        return;
      }

      if (rows.length > 1) {
        await savePendingAction(jid, {
          type: "tel_delete_select",
          recordIds: rows.map(x => x._id)
        });

        await send(jid,
          "🗑️ *¿CUÁL QUIERES ELIMINAR?*\n\n" +
          rows.map((x, i) =>
            (i + 1) + ". 👤 *" + x.name + "*\n📱 " + x.phone +
            (x.emailSuffix ? "  ✉️ .." + x.emailSuffix : "")
          ).join("\n\n") +
          "\n\nEscribe el número durante 5 minutos."
        );
        return;
      }

      const result = await deleteTelRecord(rows[0]._id);

      if (!result.ok) {
        await send(jid, "ℹ️ Ese registro ya no existe.");
        return;
      }

      await send(jid,
        "✅ *TELÉFONO ELIMINADO*\n" +
        "👤 " + result.doc.name + "\n" +
        "📱 " + formatTel(result.doc.phone) +
        (result.doc.emailSuffix ? "  ✉️ .." + result.doc.emailSuffix : "")
      );
      return;
    }

    if (directCommand === "guardartelmasivo") {
      const rawMassive = rawDirect.slice(rawDirect.toLowerCase().indexOf("guardartelmasivo") + "guardartelmasivo".length).trim();
      const result = await saveTelRecordsMassive(rawMassive, jid);
      if (!result.ok) {
        await send(jid, "❌ No encontré registros válidos.");
        return;
      }
      await send(jid,
        "✅ *TELÉFONOS GUARDADOS*\n" +
        "📱 " + result.saved +
        (result.invalid ? "\n⚠️ Omitidos: " + result.invalid : "")
      );
      return;
    }
  }

  // El bot solo funciona en el único grupo que fue activado.
  // Fuera de ese grupo no responde a ningún comando ni registra datos.
  if (!(await isActivatedChat(jid)) && !serviceUser) return;

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

  if (command === "ajustelista") {
    const parsed = parseAdjustList(text);

    if (!parsed.ok) {
      await send(jid, "❌ " + parsed.error);
      return;
    }

    const result = await overwriteCurrentAccountFromList(jid, parsed);

    await send(jid,
      "✅ *LISTA AJUSTADA*\n" +
      "📋 Cuenta inicial: *" + money(result.account.initialAmount) + "*\n" +
      "🧾 Servicios: *" + result.serviceCount + "*\n" +
      "💰 Suma: *" + money(result.total) + "*\n" +
      "🔄 Transferencias: *" + money(result.transferTotal) + "*\n" +
      "📊 Total disponible: *" + money(result.accountTotal) + "*"
    );
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

  if (command === "deudores" || command === "recuperardeudores") {
    const { services } = await collections();

    // Los deudores son históricos: sobreviven al corte y a las cuentas nuevas.
    // recuperardeudores SOLO los muestra/recupera en la lista; no crea servicios
    // nuevos y no modifica el total, transferencias, retiros ni el corte actual.
    const rows = await services.find({
      status: "pending",
      personName: { $not: /^retiro$/i }
    }).sort({ createdAt: 1 }).toArray();

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
        "💵 " + money(x.amount) + "\n" +
        "📅 " + new Date(x.createdAt).toLocaleDateString("es-MX", {
          timeZone: "America/Mexico_City",
          dateStyle: "short"
        })
      ).join("\n");

      return (i + 1) + ". 👤 *" + g.name + "*\n" + details;
    }).join("\n\n");

    await send(jid,
      "👥 *DEUDORES*\n\n" + body +
      "\n\n💰 Total pendiente: *" + money(total) +
      (serviceUser ? "\n\n👉 Escribe el número de un deudor (por ejemplo *10*) para registrar su pago." : "")
    );

    if (serviceUser) {
      await savePendingAction(jid, {
        type: "service_user_debt_select",
        rows: [...grouped.values()].map(g => ({
          name: g.name,
          total: g.total,
          serviceIds: g.rows.map(x => x._id)
        }))
      });
    }
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
          (i + 1) + ". 👤 " + x.name +
          "\n💵 " + money(x.total) +
          "\n📅 " + new Date().toLocaleDateString("es-MX", {
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
        const m = line.match(/^\s*(\d+)\.\s*👤\s*\*?(.+?)\*?(?:\s*[—-].*)?\s*$/);
        return m && Number(m[1]) === selectedNumber;
      });

      if (!selectedLine) {
        await send(jid, "❌ Ese número no existe en el mensaje de deudores.");
        return;
      }

      const match = selectedLine.match(/^\s*(\d+)\.\s*👤\s*\*?(.+?)\*?(?:\s*[—-].*)?\s*$/);
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

  if (command === "menutel") {
    if (!(await isOwnerAnywhere(jid, msg))) {
      await send(jid, "🔒 Este comando solo está disponible para el propietario.");
      return;
    }

    await send(jid,
      "📱 *MENÚ DE TELÉFONOS Y USUARIOS*\n\n" +
      "• *vertel* — muestra todos los usuarios y sus teléfonos.\n" +
      "• *vertel Leo* — busca por nombre, aunque escribas solo una parte.\n" +
      "• *verusuarios* — muestra los usuarios numerados.\n" +
      "• *listapagos1* — pagos registrados por el usuario #1.\n" +
      "• *listapagados1* — pagos hechos/pagados al usuario #1.\n" +
      "• *listaservicios1* — servicios registrados por el usuario #1.\n" +
      "• *modtel Leo* — busca al usuario para cambiarle el nombre.\n\n" +
      "💡 Si una búsqueda encuentra varias personas, el bot te mostrará la lista y podrás elegir por número."
    );
    return;
  }

  if (command === "vertel" || command === "vertel_busqueda") {
    if (!(await isOwnerAnywhere(jid, msg))) {
      await send(jid, "🔒 Este comando solo está disponible para el propietario.");
      return;
    }

    const { serviceUsers } = await collections();
    let users;

    if (command === "vertel") {
      users = await serviceUsers.find({ active: true })
        .sort({ activatedAt: 1, name: 1 })
        .toArray();
    } else {
      const rawArgs = text.trim().replace(/^!/, "").trim();
      const requested = rawArgs.replace(/^(?:vertel|vertelefonos|telefonos|telefonosservicios)\s*/i, "").trim();

      if (!requested) {
        await send(jid, "❌ Escribe un nombre después de *vertel*. Ejemplo: *vertel Leo*.");
        return;
      }

      users = await findServiceUsersByNameQuery(requested);

      if (!users.length) {
        await send(jid, "❌ No encontré un usuario parecido a *" + requested + "*.");
        return;
      }

      if (users.length > 1) {
        const body = users.map((x, i) =>
          (i + 1) + ". 👤 *" + (x.name || x.folio || "Usuario") + "*\n📱 " +
          (formatTel(x.phone) || "Sin teléfono registrado")
        ).join("\n\n");

        await send(jid,
          "📱 *COINCIDENCIAS PARA: " + requested.toUpperCase() + "*\n\n" +
          body +
          "\n\n👉 Puedes usar *vertel Nombre* con una búsqueda más específica."
        );
        return;
      }
    }

    if (!users.length) {
      await send(jid, "📭 No hay usuarios de servicios activos.");
      return;
    }

    const body = users.map((x, i) => {
      const label = x.name || x.folio || "Usuario";
      const phone = formatTel(x.phone) || "Sin teléfono registrado";
      return (i + 1) + ". 👤 *" + label + "*\n📱 " + phone;
    }).join("\n\n");

    await send(jid,
      command === "vertel_busqueda"
        ? "📱 *TELÉFONO ENCONTRADO*\n\n" + body
        : "📱 *TELÉFONOS DE USUARIOS DE SERVICIOS*\n\n" + body
    );
    return;
  }

  if (command === "modtel") {
    if (!(await isOwnerAnywhere(jid, msg))) {
      await send(jid, "🔒 Este comando solo está disponible para el propietario.");
      return;
    }

    const rawArgs = text.trim().replace(/^!/, "").trim();
    const requested = rawArgs.replace(/^(?:modtel|modnombre|cambiarnombre|modificartelefono)\s*/i, "").trim();

    if (!requested) {
      await send(jid, "❌ Escribe el nombre que quieres modificar. Ejemplo: *modtel Leo*.");
      return;
    }

    const users = await findServiceUsersByNameQuery(requested);

    if (!users.length) {
      await send(jid, "❌ No encontré un usuario parecido a *" + requested + "*.");
      return;
    }

    if (users.length > 1) {
      await savePendingAction(jid, {
        type: "modtel_select",
        rows: users
      });

      const body = users.map((x, i) =>
        (i + 1) + ". 👤 *" + (x.name || x.folio || "Usuario") + "*\n📱 " +
        (formatTel(x.phone) || "Sin teléfono registrado")
      ).join("\n\n");

      await send(jid,
        "✏️ *¿A CUÁL USUARIO QUIERES CAMBIARLE EL NOMBRE?*\n\n" +
        body +
        "\n\n👉 Responde con el *número* de la persona."
      );
      return;
    }

    const selected = users[0];
    await savePendingAction(jid, {
      type: "modtel_name",
      userId: selected._id,
      oldName: selected.name || selected.folio || "Usuario"
    });

    await send(jid,
      "✏️ *CAMBIAR NOMBRE*\n\n" +
      "📱 " + (formatTel(selected.phone) || "Sin teléfono registrado") + "\n" +
      "👤 Actual: *" + (selected.name || selected.folio || "Usuario") + "*\n\n" +
      "Escribe ahora el *nuevo nombre*."
    );
    return;
  }

  if (command === "verusuarios" || command === "listapagos_numero" || command === "listapagados_numero" || command === "listaserviciosusuario_numero") {
    if (!(await isOwnerAnywhere(jid, msg))) {
      await send(jid, "🔒 Este comando solo está disponible para el propietario.");
      return;
    }

    const { serviceUsers } = await collections();
    const users = await serviceUsers.find({ active: true }).sort({ activatedAt: 1, name: 1 }).toArray();

    if (command === "verusuarios") {
      if (!users.length) {
        await send(jid, "📭 No hay usuarios de servicios activos.");
        return;
      }

      const body = users.map((x, i) => {
        const label = x.name || x.folio || "Usuario";
        return (i + 1) + ". 👤 *" + label + "*";
      }).join("\n");

      await send(jid, "👥 *USUARIOS DE SERVICIOS ACTIVOS*\n\n" + body);
      return;
    }

    const match = String(text || "").trim().replace(/^!/, "").trim().match(/^(listapagos|listapagados|listaservicios)(\d+)$/i);
    const index = match ? Number(match[2]) : 0;
    const target = index > 0 ? users[index - 1] : null;

    if (!target) {
      await send(jid, "❌ No existe el usuario de servicios #" + index + ". Usa *verusuarios* para ver la lista.");
      return;
    }

    const commandBase = match[1].toLowerCase();
    const { payments, services } = await collections();
    const isPayments = commandBase === "listapagos" || commandBase === "listapagados";
    const rows = await (isPayments ? payments : services).find({
      "recordedBy.phone": target.phone
    }).sort({ createdAt: -1 }).toArray();

    if (!rows.length) {
      await send(jid,
        "ℹ️ " + (target.name || target.folio) +
        (isPayments ? " no tiene pagos registrados." : " no tiene servicios registrados.")
      );
      return;
    }

    const body = rows.map((x, i) =>
      (i + 1) + ". 👤 *" + x.personName + "*\n" +
      money(x.amount) +
      (auditDate(x.createdAt) ? "\n" + auditDate(x.createdAt) : "")
    ).join("\n\n");

    const title = commandBase === "listapagados"
      ? "💵 *PAGADOS A "
      : commandBase === "listapagos"
        ? "💰 *PAGOS REGISTRADOS POR "
        : "🧾 *SERVICIOS REGISTRADOS POR ";

    const auditTotal = auditRowsTotal(rows);

    await send(jid,
      title + (target.name || target.folio).toUpperCase() + "*\n\n" +
      body +
      "\n\n💰 *TOTAL: " + money(auditTotal) + "*"
    );
    return;
  }

  if (command === "listapagos" || command === "listapagados" || command === "listaserviciosusuario") {
    const rawArgs = text.trim().replace(/^!/, "").trim();
    let requested = rawArgs.replace(/^(listapagos|listapagados)\s*/i, "").replace(/^listaserviciosusuario\s*/i, "").trim();
    if (requested.startsWith("(") && requested.endsWith(")")) requested = requested.slice(1, -1).trim();

    if (!requested) {
      await send(jid, "❌ En el grupo usa: *" + command + "(Usuario)*");
      return;
    }

    const target = await resolveServiceUserForAudit(requested);
    if (!target) {
      await send(jid, "❌ No encuentro a ese usuario de servicios.");
      return;
    }

    const { payments, services } = await collections();
    const isPayments = command === "listapagos" || command === "listapagados";
    const rows = await (isPayments ? payments : services).find({
      "recordedBy.phone": target.phone
    }).sort({ createdAt: -1 }).toArray();

    if (!rows.length) {
      await send(jid,
        "ℹ️ " + (target.name || target.folio) +
        (isPayments ? " no tiene pagos registrados." : " no tiene servicios registrados.")
      );
      return;
    }

    const body = rows.map((x, i) =>
      (i + 1) + ". 👤 *" + x.personName + "* — " + money(x.amount) +
      (auditDate(x.createdAt) ? " — " + auditDate(x.createdAt) : "")
    ).join("\n");

    const auditTotal = auditRowsTotal(rows);

    await send(jid,
      (command === "listapagados" ? "💵 *PAGADOS A " : (isPayments ? "💰 *PAGOS REGISTRADOS POR " : "🧾 *SERVICIOS REGISTRADOS POR ")) +
      (target.name || target.folio).toUpperCase() + "*\n\n" +
      body +
      "\n\n💰 *TOTAL: " + money(auditTotal) + "*"
    );
    return;
  }

  if (command === "total") {
    const s = await servicesSummary();
    await send(jid, money(s.accountTotal));
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

    const standaloneTransfers = transferRows.filter(x => !x.serviceId);

    const allRows = [...serviceRows, ...standaloneTransfers]
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const body = allRows.length
      ? allRows.map((x, i) => {
          if (x.kind === "transfer") {
            return (i + 1) + ". 🔄 " + x.personName + " — " + money(x.amount) + " *TRANSFERENCIA*";
          }

          if (x.status === "transfer" || x.transferId) {
            return (i + 1) + ". 🔄 " + x.personName + " — " + money(x.amount) + " *TRANSFERENCIA*";
          }

          const registeredBy = x.recordedBy?.name || x.recordedBy?.folio;
          const marker = registeredBy ? " (" + registeredBy + ")" : "";
          return (i + 1) + ". " + x.personName + " — " + money(x.amount) +
            (x.status === "paid" ? " ✅" : " ⏳") + marker;
        }).join("\n")
      : "No hay servicios registrados.";

    await send(jid,
      "📋 *CUENTA " + Number(s.account.initialAmount || 0).toLocaleString("es-MX") + "*\n\n" +
      body
    );
    return;
  }

  if (command === "pagados") {
    const account = await ensureAccount();    const { payments } = await collections();
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
      const result = await payServices(pending.person.name, [rows[0]._id], serviceUser || null);
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

  if (command === "transferencia_numero") {
    const match = norm(text).match(/^(?:transferencia|transfer|transf)\s+(\d+)$/i) ||
      norm(text).match(/^(\d+)\s+(?:transferencia|transfer|transf)$/i);
    const index = match ? Number(match[1]) : 0;

    if (!index || index < 1) {
      await send(jid, "❌ Escribe, por ejemplo: *2 transferencia*.");
      return;
    }

    const c = await collections();
    const debtorRows = await c.services.find({
      status: "pending",
      personName: { $not: /^retiro$/i }
    }).sort({ createdAt: 1 }).toArray();

    const grouped = new Map();
    for (const x of debtorRows) {
      const key = String(x.personId);
      if (!grouped.has(key)) grouped.set(key, { name: x.personName, rows: [] });
      grouped.get(key).rows.push(x);
    }

    const debtor = [...grouped.values()][index - 1];
    if (!debtor) {
      await send(jid, "❌ El deudor número *" + index + "* no existe en la lista actual.");
      return;
    }

    const result = await transferServices(debtor.name, debtor.rows.map(x => x._id), jid);
    if (!result.ok) {
      await send(jid, "ℹ️ *" + debtor.name + "* ya no tiene deudas pendientes.");
      return;
    }

    const transferSummary = await servicesSummary();
    await send(jid,
      "🔄 *TRANSFERENCIA REGISTRADA*\n" +
      "👤 " + result.person.name + "\n" +
      "🧾 " + result.count + " servicios\n" +
      "💵 " + money(result.total) + "\n\n" +
      "🧮 Ajuste: -" + money(result.total) + "\n" +
      "💰 Total actual: *" + money(transferSummary.accountTotal) + "*"
    );
    return;
  }

  if (command === "transferencia") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();

    // Acepta "transferencia Rosy 300", "Rosy 300 transferencia"
    // y responder a un servicio escribiendo solo "transferencia".
    args = args.split(/\s+/)
      .filter(word => !isTransferWord(word))
      .join(" ")
      .trim();

    if (!args && quoted) args = quoted.replace(/^!/, "").trim();

    const a = amountFrom(args);

    // Si no se indica importe, buscamos las deudas pendientes de la persona.
    // Una sola se transfiere directamente; varias requieren confirmar
    // si quiere todas o cuáles.
    if (!a) {
      const name = args.trim();
      if (!name) {
        await send(jid, "❌ Escribe: transferencia Fulano o transferencia Fulano 250.");
        return;
      }

      const pending = await pendingServicesForPerson(name);
      if (!pending.ok) {
        await send(jid, "❌ No encontré a *" + name + "*.");
        return;
      }

      if (!pending.rows.length) {
        await send(jid, "ℹ️ *" + pending.person.name + "* no tiene deudas pendientes.");
        return;
      }

      if (pending.rows.length === 1) {
        const result = await transferServices(pending.person.name, [pending.rows[0]._id], jid);
        if (!result.ok) {
          await send(jid, "ℹ️ Esa deuda ya no está pendiente.");
          return;
        }

        const transferSummary = await servicesSummary();
        await send(jid,
          "🔄 *TRANSFERENCIA*\n" +
          "👤 " + result.person.name + "\n" +
          "💵 " + money(result.total) + "\n\n" +
          "🧮 Ajuste: -" + money(result.total) + "\n" +
          "💰 Suma actual: *" + money(transferSummary.netTotal) + "*"
        );
        return;
      }

      await savePendingAction(jid, {
        type: "transfer_select",
        personName: pending.person.name,
        serviceIds: pending.rows.map(x => x._id),
        rows: pending.rows
      });

      await send(jid,
        "🔄 *¿TODAS O CUÁLES QUIERES TRANSFERIR?*\n\n" +
        "👤 " + pending.person.name + "\n" +
        formatDebtChoices(pending.person, pending.rows) +
        "\n\nEscribe *todos* para transferirlas todas o escribe los números, por ejemplo *1 3*, durante los próximos 5 minutos."
      );
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

  if (command === "ajustetransferenciacaja") {
    let args = text.trim();
    if (args.startsWith(PREFIX)) args = args.slice(PREFIX.length).trim();

    const rest = args.split(/\s+/).slice(1).join(" ").trim();
    const a = amountFrom(rest);

    if (!a || a.amount <= 0) {
      await send(jid,
        "❌ Formato exacto: *ajustetransferenciacaja Rosy 300*"
      );
      return;
    }

    const name = cleanName(rest, a.raw);
    if (!name) {
      await send(jid, "❌ Debes indicar el nombre. Ejemplo: *ajustetransferenciacaja Rosy 300*");
      return;
    }

    // Reutiliza el mismo mecanismo de transferencia para que:
    // 1) se registre el movimiento como salida,
    // 2) se descuente del disponible,
    // 3) se enlace al servicio de esa persona si existe.
    await addService(name, a.amount, jid, true);

    const updated = await servicesSummary();

    await send(jid,
      "🧾 *AJUSTE DE TRANSFERENCIA*\n" +
      "👤 " + name + "\n" +
      "💵 " + money(a.amount) + "\n\n" +
      "➖ Descontado de caja: *" + money(a.amount) + "*\n" +
      "💰 Disponible actual: *" + money(updated.netTotal) + "*"
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
      (serviceUser
        ? "\n📌 Cuenta nueva creada correctamente."
        : (ps
          ? "\n📌 *CUENTA ANTERIOR*\n" +
            "🧾 Servicios: " + ps.count + "\n" +
            "💰 Suma: " + money(ps.total) + "\n" +
            "🔄 Transferencias: " + money(ps.transfers || 0) + "\n" +
            "💸 Retiros: " + money(ps.withdrawals) + "\n" +
            "📊 Final: " + money(ps.netTotal) + "\n" +
            "⏳ Pendiente: " + money(ps.pending) + "\n" +
            "✅ Pagado: " + money(ps.paid)
          : "\n📌 Sin cuenta anterior."))
    );
    return;
  }

  if (command === "corte") {
    if (serviceUser) {
      await send(jid, "🔒 Este acceso no tiene disponible el comando *corte*.");
      return;
    }

    // Primero se envía la información de CONTROL de los usuarios de servicios.
    // Esta información pertenece al ciclo que se está cerrando y se borra
    // después de terminar el corte.
    const { serviceUsers: activeServiceUsers } = await collections();
    const activeUsersForAudit = await activeServiceUsers.find({ active: true })
      .sort({ activatedAt: 1, name: 1 })
      .toArray();

    for (const user of activeUsersForAudit) {
      const { payments: auditPayments, services: auditServices } = await collections();
      const [userServices, userPayments] = await Promise.all([
        auditServices.find({ "recordedBy.phone": user.phone })
          .sort({ createdAt: 1 })
          .toArray(),
        auditPayments.find({ "recordedBy.phone": user.phone })
          .sort({ createdAt: 1 })
          .toArray()
      ]);

      const label = String(user.name || user.folio || "Usuario").trim();

      const serviceBody = userServices.length
        ? userServices.map((x, i) =>
            (i + 1) + ". 👤 *" + x.personName + "* — " + money(x.amount) +
            (auditDate(x.createdAt) ? " — " + auditDate(x.createdAt) : "")
          ).join("\n")
        : "Sin servicios registrados.";

      const paymentBody = userPayments.length
        ? userPayments.map((x, i) =>
            (i + 1) + ". 👤 *" + x.personName + "* — " + money(x.amount) +
            (auditDate(x.createdAt) ? " — " + auditDate(x.createdAt) : "")
          ).join("\n")
        : "Sin pagos registrados.";

      await send(jid,
        "🧾 *CONTROL DE " + label.toUpperCase() + "*\n\n" +
        "🛠️ *SERVICIOS REGISTRADOS POR " + label.toUpperCase() + "*\n" +
        serviceBody + "\n\n" +
        "💵 *PAGOS REGISTRADOS POR / PAGADOS A " + label.toUpperCase() + "*\n" +
        paymentBody
      );
    }

    // El resto del corte continúa exactamente después del control de usuarios.
    // El corte envía después:
    // 1) lista de servicios
    // 2) lista de deudores
    // 3) resumen del corte
    const s = await servicesSummary();
    const { accounts, cycles, services } = await collections();
    const closedAt = new Date();

    // MENSAJE 1: LISTA DE SERVICIOS
    const serviceBody = s.rows.length
      ? s.rows.map((x, i) => {
          const status = (x.status === "transfer" || x.transferId)
            ? " 🔄 *TRANSFERENCIA*"
            : (x.status === "paid" ? " ✅" : " ⏳");
          return (i + 1) + ". " + x.personName + " — " + money(x.amount) + status;
        }).join("\n")
      : "No hay servicios registrados.";

    await send(jid,
      "📋 *CUENTA " + Number(s.account.initialAmount || 0).toLocaleString("es-MX") + "*\n\n" +
      serviceBody
    );

    // MENSAJE 2: LISTA DE DEUDORES
    // Los deudores son HISTÓRICOS y nunca se borran al cerrar una cuenta.
    // Después de un corte siguen apareciendo hasta que realmente se paguen.
    // Por eso aquí NO filtramos por accountNumber.
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
          "💵 " + money(x.amount) + "   \n" +
          "📅 " + new Date(x.createdAt).toLocaleDateString("es-MX", {
            timeZone: "America/Mexico_City",
            dateStyle: "short"
          })
        ).join("\n");

        return (i + 1) + ". 👤 *" + g.name + "*\n" + details;
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
            netTotal: s.accountTotal,
            pending: s.pendingTotal,
            paid: s.paidTotal
          }
        }
      }
    );

    // MENSAJE 3: CORTE
    const byAmount = new Map();
    for (const row of s.rows.filter(row => row.status !== "transfer" && !row.transferId)) {
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
      "📊 Final: *" + money(s.accountTotal) + "*"
    );
    // Al terminar el corte, borra la memoria de auditoría de usuarios.
    await cleanupServiceUserAudit({ atCut: true });
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
          "💰 Total: *" + money(summary.accountTotal) + "*");
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
