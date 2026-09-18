import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WAMessage,
} from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import cron from 'node-cron';
import { appDatabase } from './database.js';
import { generateMorningBriefing } from './gemini.js';
import { ChatMessage } from './types.js';
import { formatAiErrorMessage, getOwnerJid, isAuthorized } from './utils.js';
import { handleFocusInterception } from './handlers/focus.js';
import { handleReactionTrigger } from './handlers/reactions.js';
import { handleTextCommand } from './handlers/commands.js';

dotenv.config();

// ============================================================================
// 1. SERVIDOR HTTP DE HEALTHCHECK (Nuvem: Railway, Render, Fly.io, Cloud Run)
// ============================================================================
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'online',
        service: 'WhatsApp AI Summarizer',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      })
    );
  })
  .listen(PORT, () => {
    console.log(`🌐 Servidor HTTP de Healthcheck ativo na porta ${PORT}`);
  });

// ============================================================================
// 2. ESCUDO DE ESTABILIDADE (Evita quedas por sessões oscilantes do Signal)
// ============================================================================
process.on('uncaughtException', (err: any) => {
  if (
    err?.message?.includes('Key used already') ||
    err?.message?.includes('Session error') ||
    err?.message?.includes('decrypt')
  ) {
    return;
  }
  console.error('⚠️ Aviso do sistema (ignorado para não derrubar o bot):', err.message);
});

process.on('unhandledRejection', (reason: any) => {
  if (
    reason?.message?.includes('Key used already') ||
    reason?.message?.includes('Session error') ||
    reason?.message?.includes('decrypt')
  ) {
    return;
  }
  console.error('⚠️ Aviso assíncrono (ignorado para não derrubar o bot):', reason?.message || reason);
});

// ============================================================================
// 3. CONFIGURAÇÕES GERAIS
// ============================================================================
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';
const ONLY_OWNER = process.env.ONLY_OWNER !== 'false';
const ALWAYS_PRIVATE = process.env.ALWAYS_PRIVATE === 'true';
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);
const DEFAULT_SUMMARY_LIMIT = Number(process.env.SUMMARY_MESSAGE_LIMIT) || 50;
const BRIEFING_TIME = process.env.BRIEFING_TIME || '07:00';
const BRIEFING_GROUPS = (process.env.BRIEFING_GROUPS || '')
  .split(',')
  .map((g) => g.trim().toLowerCase())
  .filter(Boolean);
const WATCHDOG_KEYWORDS = (process.env.WATCHDOG_KEYWORDS || 'Cassiano,urgente,urgência,emergência,socorro')
  .split(',')
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);

let briefingScheduled = false;

/**
 * Configura o agendamento do Briefing Matinal diário
 */
function setupMorningBriefingCron(sock: any) {
  if (briefingScheduled) return;
  briefingScheduled = true;

  const [hour, minute] = BRIEFING_TIME.split(':').map((n) => Number(n) || 0);
  const cronExpression = `${minute} ${hour} * * *`;

  console.log(`⏰ [Agendador] Briefing Matinal diário programado para às ${BRIEFING_TIME} (${cronExpression})`);

  cron.schedule(
    cronExpression,
    async () => {
      console.log(`\n⏰ [Cron] Disparando Briefing Matinal diário das ${BRIEFING_TIME}...`);
      await runMorningBriefing(sock);
    },
    { timezone: 'America/Sao_Paulo' }
  );
}

/**
 * Executa a consolidação das últimas 24h e entrega o Briefing Matinal
 */
async function runMorningBriefing(sock: any, destinationOverride?: string): Promise<void> {
  const ownerJid = destinationOverride || getOwnerJid(sock);
  if (!ownerJid) {
    console.error('⚠️ Briefing cancelado: JID do usuário não encontrado.');
    return;
  }

  const sinceTimestamp = Date.now() - 24 * 60 * 60 * 1000;
  const activeChats = appDatabase.getActiveChatsSince(sinceTimestamp, 2);

  if (activeChats.length === 0) {
    await sock.sendMessage(ownerJid, {
      text: `☀️ *BOM DIA!*\n\n📅 Nenhuma conversa ou movimentação relevante foi detectada nos seus grupos nas últimas 24 horas.\n\nTenha um excelente dia! 🚀`,
    });
    return;
  }

  const groupsData: Array<{ groupName: string; formattedMessages: string }> = [];

  for (const chat of activeChats) {
    let groupName = 'Conversa';
    if (chat.isGroup) {
      try {
        const meta = await sock.groupMetadata(chat.remoteJid).catch(() => null);
        groupName = meta?.subject || 'Grupo';
      } catch {
        groupName = 'Grupo';
      }
    } else {
      if (BRIEFING_GROUPS.length > 0) continue;
      groupName = 'Chat Privado';
    }

    if (BRIEFING_GROUPS.length > 0) {
      const match = BRIEFING_GROUPS.some(
        (filter) => groupName.toLowerCase().includes(filter) || chat.remoteJid.toLowerCase().includes(filter)
      );
      if (!match) continue;
    }

    const msgs = appDatabase.getMessagesSince(chat.remoteJid, sinceTimestamp, 60);
    if (msgs.length === 0) continue;

    const formatted = appDatabase.formatForAI(msgs);
    groupsData.push({
      groupName,
      formattedMessages: formatted,
    });

    if (groupsData.length >= 6) break;
  }

  if (groupsData.length === 0) {
    await sock.sendMessage(ownerJid, {
      text: `☀️ *BOM DIA!*\n\n📅 Nenhum dos grupos monitorados para o briefing teve movimentação recente nas últimas 24 horas.`,
    });
    return;
  }

  try {
    const briefingText = await generateMorningBriefing(groupsData);
    await sock.sendMessage(ownerJid, { text: briefingText });
    console.log(`✅ Briefing Matinal entregue com sucesso para: ${ownerJid}`);
  } catch (err: any) {
    console.error('Erro ao gerar briefing matinal:', err);
    await sock.sendMessage(ownerJid, {
      text: `❌ Falha ao processar o briefing matinal de hoje: ${formatAiErrorMessage(err, 'o briefing matinal')}`,
    });
  }
}

/**
 * Salva mensagens comuns e mídias no SQLite de forma persistente
 */
function saveIncomingMessageToDb(msg: WAMessage): boolean {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return false;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    (msg.message?.imageMessage ? '[Imagem/Foto]' : '') ||
    (msg.message?.documentMessage ? `[Documento: ${msg.message.documentMessage.fileName || 'arquivo'}]` : '') ||
    (msg.message?.audioMessage ? '[Áudio]' : '') ||
    '';

  if (!text || text.startsWith(COMMAND_PREFIX)) return false;

  const senderName = msg.pushName || 'Usuário';
  const isGroup = remoteJid.endsWith('@g.us');

  const chatMsg: ChatMessage = {
    id: msg.key.id || Math.random().toString(),
    sender: msg.key.participant || remoteJid,
    senderName,
    text: text.trim(),
    timestamp: new Date(((msg.messageTimestamp as number) || Math.floor(Date.now() / 1000)) * 1000),
    isGroup,
    rawMessage: msg.message ? JSON.stringify(msg.message) : undefined,
  };

  appDatabase.saveMessage(remoteJid, chatMsg);
  return true;
}

/**
 * Processa mensagens recebidas em tempo real
 */
async function handleIncomingMessage(sock: any, msg: WAMessage) {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const ownerJid = getOwnerJid(sock, msg);

  // 1. REAÇÕES INVISÍVEIS POR EMOJI
  const reaction = msg.message?.reactionMessage;
  if (reaction && reaction.text) {
    if (!isAuthorized(msg, ONLY_OWNER, ALLOWED_NUMBERS)) return;
    await handleReactionTrigger(sock, msg, reaction, ownerJid, DEFAULT_SUMMARY_LIMIT);
    return;
  }

  // 2. MENSAGENS DE TEXTO E MÍDIAS
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    '';

  const incomingMediaLabel =
    msg.message?.imageMessage ? '[Imagem/Foto]' :
    msg.message?.documentMessage ? `[Documento: ${msg.message.documentMessage.fileName || 'arquivo'}]` :
    msg.message?.audioMessage ? '[Áudio]' : '';

  const effectiveText = text || incomingMediaLabel;
  const senderName = msg.pushName || 'Usuário';
  const isGroup = remoteJid.endsWith('@g.us');

  // Grava no SQLite e verifica Modo Foco / Radar de Urgência
  if (effectiveText && !text.startsWith(COMMAND_PREFIX)) {
    saveIncomingMessageToDb(msg);

    // Interceptação pelo Modo Foco com Secretária Eletrônica
    const interceptedByFocus = await handleFocusInterception(
      sock,
      msg,
      effectiveText,
      senderName,
      remoteJid,
      ownerJid,
      isGroup,
      WATCHDOG_KEYWORDS
    );
    if (interceptedByFocus) return;

    // Radar de Urgência em Grupos
    if (isGroup && !msg.key.fromMe) {
      const textLower = effectiveText.toLowerCase();
      const matchedKeyword = WATCHDOG_KEYWORDS.find((kw) => textLower.includes(kw));

      if (matchedKeyword) {
        console.log(`🚨 [Radar de Urgência]: Termo "${matchedKeyword}" detectado em ${remoteJid} por ${senderName}`);
        let groupTitle = 'Grupo';
        try {
          const meta = await sock.groupMetadata(remoteJid).catch(() => null);
          if (meta?.subject) groupTitle = meta.subject;
        } catch {}

        const alertMessage =
          `🚨 *ALERTA DO RADAR DE URGÊNCIA* 🚨\n\n` +
          `👥 *Grupo:* ${groupTitle}\n` +
          `👤 *De:* ${senderName}\n` +
          `🔑 *Termo detectado:* "${matchedKeyword}"\n\n` +
          `💬 *Mensagem:*\n"${effectiveText.trim()}"\n\n` +
          `_Aviso em tempo real enviado no seu privado_ ⚡`;

        await sock.sendMessage(ownerJid, { text: alertMessage });
      }
    }

    return;
  }

  // Se não for comando de texto, encerra
  if (!text.startsWith(COMMAND_PREFIX)) return;

  // Trava de autorização
  if (!isAuthorized(msg, ONLY_OWNER, ALLOWED_NUMBERS)) {
    console.log(`🚫 Comando bloqueado para usuário não autorizado: ${senderName} (${remoteJid})`);
    return;
  }

  // Parse de comandos e parâmetros
  const allArgs = text.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = allArgs[0]?.toLowerCase();
  const lowerArgs = allArgs.map((a) => a.toLowerCase());
  const explicitlyPrivate = lowerArgs.includes('pv') || lowerArgs.includes('privado') || lowerArgs.includes('segredo');
  const explicitlyGroup = lowerArgs.includes('grupo') || lowerArgs.includes('publico');
  const isAlreadyPrivateChat = remoteJid === ownerJid;

  const shouldSendPrivate =
    !isAlreadyPrivateChat &&
    (explicitlyPrivate || (isGroup && ALWAYS_PRIVATE && !explicitlyGroup));

  const destinationJid = shouldSendPrivate ? ownerJid : remoteJid;
  const cleanArgs = allArgs.slice(1).filter((a) => !['pv', 'privado', 'segredo', 'grupo', 'publico'].includes(a.toLowerCase()));
  const chatContextLabel = isGroup ? '👥 Grupo' : `👤 Conversa com ${senderName}`;

  console.log(`\n🤖 Comando [${command}] disparado no chat: ${remoteJid}`);

  await handleTextCommand({
    sock,
    msg,
    remoteJid,
    ownerJid,
    senderName,
    command,
    cleanArgs,
    shouldSendPrivate,
    destinationJid,
    chatContextLabel,
    isGroup,
    defaultSummaryLimit: DEFAULT_SUMMARY_LIMIT,
    briefingTime: BRIEFING_TIME,
    commandPrefix: COMMAND_PREFIX,
    runMorningBriefing,
  });
}

/**
 * Ponto de entrada do cliente WhatsApp
 */
async function startWhatsAppBot() {
  console.log('\n🚀 Iniciando WhatsApp AI Summarizer (com Arquitetura Modular)...');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '122.0.6261.129'],
    syncFullHistory: false,
    getMessage: async (key) => {
      const m = appDatabase.getMessageById(key.id || '');
      if (m) return { conversation: m.text };
      return undefined;
    },
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=============================================================');
      console.log('📱 ESCANEIE O QR CODE ABAIXO COM O SEU WHATSAPP NO CELULAR:');
      console.log('   (WhatsApp > Menu de 3 pontos ou Configurações > Aparelhos Conectados)');
      console.log('=============================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.log('❌ Sessão desconectada pelo celular. Execute novamente para escanear novo QR Code.');
      } else {
        console.log(`⚠️ Conexão oscilou (código: ${statusCode || 'desconhecido'}). Reconectando em 3s...`);
        setTimeout(() => startWhatsAppBot(), 3000);
      }
    } else if (connection === 'open') {
      console.log('\n✅ SUCESSO: WhatsApp Conectado com Suíte Completa de Emojis!');
      console.log(`🤖 Emojis Invisíveis Ativos no Privado:`);
      console.log(`   👉 🧠 (Resumir)  | ✍️ (Ghostwriter) | 💡 (Explicar) | 📌 (Salvar) | 🌐 (Traduzir)`);
      console.log(`   👉 🎯 (Tarefas)  | 🕵️ (Fact-Check)  | 💰 (Rachid)   | 🔗 (Resumir Link) | 🎧 (Áudio)`);
      console.log(`   👉 📸 (Foto/Doc) | 📄 (Ata em PDF)  | ☀️ !briefing  | 🚨 Radar de Urgência`);
      console.log(`   👉 🔕 !foco (Secretária Eletrônica no Privado) | !ata (Gerador de Ata em PDF)`);
      console.log(`   👉 Digite "!emojis" no seu WhatsApp para ver o manual completo!\n`);

      setupMorningBriefingCron(sock);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'append') {
      for (const msg of m.messages) {
        try {
          saveIncomingMessageToDb(msg);
        } catch {}
      }
      return;
    }

    if (m.type === 'notify') {
      for (const msg of m.messages) {
        try {
          await handleIncomingMessage(sock, msg);
        } catch (err: any) {
          console.error('⚠️ Erro ao processar mensagem (bot segue vivo):', err.message);
        }
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ messages }: { messages: WAMessage[] }) => {
    if (!messages || messages.length === 0) return;
    console.log(`📥 Sincronizando ${messages.length} mensagens do período offline no SQLite...`);
    let count = 0;
    for (const msg of messages) {
      try {
        if (saveIncomingMessageToDb(msg)) count++;
      } catch {}
    }
    if (count > 0) {
      console.log(`✅ Sincronização offline concluída: ${count} mensagens registradas no SQLite!`);
    }
  });
}

startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
