import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  useMultiFileAuthState,
  WAMessage,
} from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { appDatabase } from './database.js';
import {
  answerChatQuestion,
  explainMessage,
  extractTasks,
  factCheckMessage,
  formatAudioSummaryForWhatsApp,
  formatSummaryForWhatsApp,
  generateChatSummary,
  splitExpenses,
  suggestReplies,
  summarizeLinkContent,
  transcribeAndSummarizeAudio,
  translateMessage,
  analyzeImageOrDocument,
  generateMorningBriefing,
  generateMeetingMinutesData,
} from './gemini.js';
import { generateMeetingMinutesPdf } from './pdf.js';
import http from 'http';
import cron from 'node-cron';
import { ChatMessage } from './types.js';

dotenv.config();

// Servidor de Healthcheck para plataformas na nuvem (Railway, Render, Fly.io, Cloud Run)
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

// ESCUDO CONTRA QUEDAS: Evita que erros temporários de criptografia (Signal) derrubem o processo
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

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';
const ONLY_OWNER = process.env.ONLY_OWNER !== 'false'; // Padrão: apenas você pode comandar o bot
const ALWAYS_PRIVATE = process.env.ALWAYS_PRIVATE === 'true'; // Se true, sempre manda no privado quando em grupos
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
const WATCHDOG_KEYWORDS = (process.env.WATCHDOG_KEYWORDS || 'Cassiano,urgente,emergência,atenção,socorro,reunião')
  .split(',')
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);

/**
 * Obtém o JID do WhatsApp privado do usuário (dono da conta)
 */
function getOwnerJid(sock: any, msg?: WAMessage): string {
  if (sock.user?.id) {
    return jidNormalizedUser(sock.user.id);
  }
  if (msg?.key?.participant) {
    return jidNormalizedUser(msg.key.participant);
  }
  if (msg?.key?.remoteJid) {
    return jidNormalizedUser(msg.key.remoteJid);
  }
  return '';
}

/**
 * Verifica se quem enviou o comando tem permissão de execução
 */
function isAuthorized(msg: WAMessage): boolean {
  if (msg.key.fromMe) return true; // Sempre autoriza você (dono da conta)
  if (!ONLY_OWNER) return true; // Se desativou a trava, permite qualquer um

  const sender = msg.key.participant || msg.key.remoteJid || '';
  const senderNumber = sender.replace(/[^0-9]/g, '');

  return ALLOWED_NUMBERS.some((num) => senderNumber.includes(num));
}

/**
 * Converte argumentos de tempo (ex: "2h", "45m", "90") em minutos
 */
function parseFocusDuration(arg?: string): number {
  if (!arg) return 60; // Padrão: 60 minutos (1h)
  const clean = arg.toLowerCase().trim();
  if (clean.endsWith('h')) {
    const hours = parseFloat(clean.replace('h', ''));
    return isNaN(hours) ? 60 : Math.round(hours * 60);
  }
  if (clean.endsWith('m') || clean.endsWith('min')) {
    const mins = parseFloat(clean.replace(/min|m/, ''));
    return isNaN(mins) ? 60 : Math.round(mins);
  }
  const directNum = parseFloat(clean);
  return isNaN(directNum) ? 60 : Math.round(directNum);
}

/**
 * Função principal que inicia o cliente WhatsApp e escuta os eventos
 */
async function startWhatsAppBot() {
  console.log('\n🚀 Iniciando WhatsApp AI Summarizer (com Suíte Completa de Reações)...');

  // 1. Gerenciamento de Estado da Sessão
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  // 2. Criação do Socket de Conexão com o WhatsApp Web
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '122.0.6261.129'],
    syncFullHistory: false, // Foco em mensagens em tempo real
    getMessage: async (key) => {
      const m = appDatabase.getMessageById(key.id || '');
      if (m) {
        return { conversation: m.text };
      }
      return undefined;
    },
  });

  // 3. Monitoramento do Status da Conexão e Exibição do QR Code
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
        setTimeout(() => {
          startWhatsAppBot();
        }, 3000);
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

  // 4. Salva as credenciais sempre que forem atualizadas
  sock.ev.on('creds.update', saveCreds);

  // 5. Escuta e Processamento de Mensagens em Tempo Real e Sincronização Offline
  sock.ev.on('messages.upsert', async (m) => {
    // Sincronização de histórico: mensagens que chegaram enquanto o bot esteve offline
    if (m.type === 'append') {
      for (const msg of m.messages) {
        try {
          saveIncomingMessageToDb(msg);
        } catch {}
      }
      return;
    }

    // Mensagens recebidas em tempo real
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

  // 6. Sincronização de conversas ao reconectar (quando o note é ligado)
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

let briefingScheduled = false;

/**
 * Configura o agendamento do Briefing Matinal no fuso de Brasília
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
async function runMorningBriefing(sock: any, destinationOverride?: string) {
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
      text: `❌ Falha ao processar o briefing matinal de hoje: ${err.message || 'Erro inesperado'}`,
    });
  }
}

/**
 * Salva mensagens comuns e mídias no SQLite de forma segura (usado em tempo real e offline)
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
 * Lida com cada mensagem recebida
 */
async function handleIncomingMessage(sock: any, msg: WAMessage) {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const ownerJid = getOwnerJid(sock, msg);

  // =========================================================================
  // 1. DISPATCHER DE REAÇÕES INVISÍVEIS POR EMOJI
  // =========================================================================
  const reaction = msg.message?.reactionMessage;
  if (reaction && reaction.text) {
    if (!isAuthorized(msg)) return;
    await handleReactionTrigger(sock, msg, reaction, ownerJid);
    return;
  }

  // =========================================================================
  // 2. MENSAGENS DE TEXTO E GRAVAÇÃO NO SQLITE
  // =========================================================================
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

  // Grava no Banco SQLite automaticamente (se for texto/mídia comum e não for comando)
  if (effectiveText && !text.startsWith(COMMAND_PREFIX)) {
    saveIncomingMessageToDb(msg);

    // --- 🔕 MODO FOCO & SECRETÁRIA ELETRÔNICA NO PRIVADO ---
    if (!isGroup && !msg.key.fromMe && remoteJid !== ownerJid) {
      const focusSession = appDatabase.getActiveFocusSession();
      if (focusSession) {
        const { isFirstContact } = appDatabase.recordFocusContactMessage(
          focusSession.id,
          remoteJid,
          senderName,
          effectiveText
        );

        // Se for a primeira mensagem dessa pessoa durante esta sessão, responde com a secretária eletrônica
        if (isFirstContact) {
          const untilTime = focusSession.endTime.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Sao_Paulo',
          });
          const autoReply =
            `Olá, ${senderName}! 👋\n\n` +
            `O Cassiano está em *Modo Foco / Produtividade Profunda* no momento e sem notificações ativas até às *${untilTime}*.\n\n` +
            `Sua mensagem foi registrada com segurança e ele te responderá assim que sair do foco! ⏳\n\n` +
            `_(Caso seja algo estritamente urgente, responda com a palavra *urgente*)_ 🚨`;

          await sock.sendMessage(remoteJid, { text: autoReply });
          console.log(`🔕 [Modo Foco]: Auto-resposta enviada para ${senderName} (${remoteJid})`);
        }

        // Se a pessoa enviou termo urgente no privado durante o modo foco, alerta o dono
        const textLower = effectiveText.toLowerCase();
        if (WATCHDOG_KEYWORDS.some((kw) => textLower.includes(kw))) {
          await sock.sendMessage(ownerJid, {
            text:
              `🚨 *URGÊNCIA NO MODO FOCO* 🚨\n\n` +
              `👤 *De:* ${senderName} (no privado)\n` +
              `💬 *Mensagem:*\n"${effectiveText.trim()}"\n\n` +
              `_Esta mensagem furou o modo foco devido ao radar de urgência!_ ⚡`,
          });
        }

        return;
      }
    }

    // --- 🚨 RADAR DE URGÊNCIA & MENÇÕES EM TEMPO REAL (GRUPOS) ---
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

  // Se a mensagem não tem comando de texto, encerra
  if (!text.startsWith(COMMAND_PREFIX)) return;

  // --- TRAVA DE SEGURANÇA ---
  if (!isAuthorized(msg)) {
    console.log(`🚫 Comando bloqueado para usuário não autorizado: ${senderName} (${remoteJid})`);
    return;
  }

  // --- TRATAMENTO DE COMANDOS E MODOS DE VISIBILIDADE ---
  const allArgs = text.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = allArgs[0]?.toLowerCase();

  // Flags de privacidade
  const lowerArgs = allArgs.map((a) => a.toLowerCase());
  const explicitlyPrivate = lowerArgs.includes('pv') || lowerArgs.includes('privado') || lowerArgs.includes('segredo');
  const explicitlyGroup = lowerArgs.includes('grupo') || lowerArgs.includes('publico');

  const isAlreadyPrivateChat = remoteJid === ownerJid;

  // Decide se a resposta deve ser enviada para o seu privado pessoal
  const shouldSendPrivate =
    !isAlreadyPrivateChat &&
    (explicitlyPrivate || (isGroup && ALWAYS_PRIVATE && !explicitlyGroup));

  const destinationJid = shouldSendPrivate ? ownerJid : remoteJid;

  // Argumentos limpos
  const cleanArgs = allArgs.slice(1).filter((a) => !['pv', 'privado', 'segredo', 'grupo', 'publico'].includes(a.toLowerCase()));
  const chatContextLabel = isGroup ? '👥 Grupo' : `👤 Conversa com ${senderName}`;

  console.log(`\n🤖 Comando [${command}] disparado no chat: ${remoteJid}`);
  console.log(`   Destino da resposta: ${destinationJid} (Modo Privado: ${shouldSendPrivate})`);

  // COMANDO: !emojis ou !emoji ou !superpoderes ou !menu (MANUAL COMPLETO DAS REAÇÕES)
  if (command === 'emojis' || command === 'emoji' || command === 'superpoderes' || command === 'menu') {
    const guide = `🎛️ *CATÁLOGO DE SUPERPODERES INVISÍVEIS (REAÇÕES)* 🤫

Reaja com qualquer um destes emojis em qualquer mensagem de qualquer chat para ativar a IA em silêncio absoluto (a resposta chega somente no seu privado!):

🧠 *[Cérebro]* ➔ *Resumo Completo:*
Lê as últimas mensagens daquele chat e gera um resumo executivo com tópicos, decisões e urgência.

✍️ *[Caneta]* ➔ *Ghostwriter de Respostas:*
Gera 3 opções elegantes de resposta para você enviar de volta (Profissional, Amigável ou Direta).

💡 *[Lâmpada]* ➔ *Explicador Didático:*
Explica um termo técnico, texto longo ou assunto confuso em linguagem simples.

📸 *[Câmera]* ➔ *Visão de Fotos & Documentos:*
Reaja em fotos de comprovantes Pix, contratos, recibos ou gráficos para ter uma análise detalhada.

📄 *[Documento]* ➔ *Gerador de Ata em PDF:*
Reaja em qualquer conversa para gerar instantaneamente uma Ata Formal de Reunião em arquivo PDF!

📌 *[Alfinete]* ➔ *Fixar nos Favoritos (SQLite):*
Salva a mensagem marcada no seu banco de dados local. Digite \`!notas\` para consultar!

🌐 *[Globo]* ➔ *Tradutor Instantâneo:*
Traduz a mensagem para Português do Brasil com máxima naturalidade.

🎯 *[Alvo]* ➔ *Extrator de Tarefas (To-Do List):*
Transforma textões de alinhamento em um checklist de afazeres com prazos.

🕵️‍♂️ *[Detetive]* ➔ *Checador de Fatos / Fake News:*
Analisa indícios de boatos, correntes falsas, sensacionalismo ou golpes.

💰 *[Dinheiro]* ➔ *Divisor de Contas / Rachid:*
Calcula a divisão matemática exata dos gastos e quem deve quanto no Pix.

🔗 *[Link]* ➔ *Resumidor de Links:*
Resume o conteúdo e os pontos principais de um link sem você precisar abrir a página.

🎧 *[Fones]* ➔ *Ouvinte de Áudio:*
Transcreve e resume áudios sem precisar ouvir.

━━━━━━━━━━━━━━━━━━━━
🚀 *SUPERPODERES ADICIONAIS POR COMANDO:*

🔕 *\`!foco 2h\`* (ou \`!foco off\` / \`!foco status\`)
Ativa o Modo Foco com Secretária Eletrônica: silencia o privado, avisa educadamente quem te chamar até seu retorno e te dá um relatório ao final!

📄 *\`!ata [n]\` ou \`!pdf [n]\`* (adicione \`pv\` para segredo)
Gera uma Ata Formal de Reunião em PDF com layout executivo (pautas, decisões e plano de ação).

☀️ *\`!briefing\`*
Consolida em uma mensagem o que aconteceu nas últimas 24h dos grupos (automático às ${BRIEFING_TIME}).

🚨 *Radar de Urgência Ativo:*
Monitora grupos e te avisa no privado em tempo real se chamarem seu nome ou palavras urgentes!

━━━━━━━━━━━━━━━━━━━━
💡 _Dica: No chat onde você reage, nada é enviado nem apagado. Ninguém vê nada além da sua reação!_`;

    await sock.sendMessage(destinationJid, { text: guide });
  }

  // COMANDO: !briefing (Dispara o briefing matinal consolidado sob demanda)
  else if (command === 'briefing') {
    await sock.sendMessage(destinationJid, {
      text: `☀️ *Preparando seu Briefing Executivo...* Consultando conversas das últimas 24h com o Gemini AI! ⏳`,
    });
    await runMorningBriefing(sock, destinationJid);
  }

  // COMANDO: !notas (LISTA TODAS AS MENSAGENS FIXADAS COM 📌)
  else if (command === 'notas') {
    const notes = appDatabase.getPinnedNotes(15);
    if (notes.length === 0) {
      await sock.sendMessage(destinationJid, {
        text: `📌 Nenhuma nota fixada ainda. Reaja com o emoji 📌 em qualquer mensagem para arquivá-la aqui!`,
      });
      return;
    }

    const items = notes
      .map((n, i) => {
        const data = n.date.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        return `${i + 1}. 📌 *[${n.chatTitle}]* (${data}) - *${n.senderName}*:\n"${n.text}"`;
      })
      .join('\n\n');

    await sock.sendMessage(destinationJid, {
      text: `📋 *SUAS NOTAS E MENSAGENS FIXADAS (SQLite):*\n\n${items}`,
    });
  }

  // COMANDO: !foco [tempo / off / status] (MODO FOCO COM SECRETÁRIA ELETRÔNICA)
  else if (command === 'foco') {
    const sub = cleanArgs[0]?.toLowerCase();

    if (sub === 'off' || sub === 'sair' || sub === 'cancelar' || sub === 'fim') {
      const result = appDatabase.stopFocusMode();
      if (!result.hadSession) {
        await sock.sendMessage(destinationJid, {
          text: `ℹ️ Nenhum Modo Foco estava ativo no momento.`,
        });
        return;
      }

      let report = `🔔 *MODO FOCO ENCERRADO!*\n\n⏱️ *Tempo total em foco:* ${result.durationMinutes} minutos\n\n`;
      if (result.callers.length === 0) {
        report += `🧘 *Nenhum contato te chamou no privado durante seu foco.* Produtividade máxima mantida! 🚀`;
      } else {
        report += `👥 *Contatos que tentaram falar com você no privado (${result.callers.length}):*\n\n`;
        result.callers.forEach((c, idx) => {
          report += `${idx + 1}. 👤 *${c.senderName}* (${c.count} ${c.count === 1 ? 'mensagem' : 'mensagens'}):\n   💬 "${c.lastMessage}"\n\n`;
        });
        report += `_A secretária eletrônica atendeu a todos educadamente._ ✨`;
      }

      await sock.sendMessage(destinationJid, { text: report });
    } else if (sub === 'status') {
      const active = appDatabase.getActiveFocusSession();
      if (!active) {
        await sock.sendMessage(destinationJid, {
          text: `🧘 *Modo Foco Inativo.* Notificações e mensagens normais.\n\nPara ativar, envie: \`!foco 1h\` ou \`!foco 45m\`.`,
        });
      } else {
        const until = active.endTime.toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Sao_Paulo',
        });
        const remainingMins = Math.max(0, Math.round((active.endTime.getTime() - Date.now()) / (1000 * 60)));
        await sock.sendMessage(destinationJid, {
          text: `🔕 *Modo Foco Ativo!*\n\n⏱️ Restam cerca de *${remainingMins} minutos* (até às *${until}*).\n\nPara encerrar antecipadamente, digite: \`!foco off\`.`,
        });
      }
    } else {
      const minutes = parseFocusDuration(sub);
      const session = appDatabase.startFocusMode(minutes);
      const until = session.endTime.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });

      const reply =
        `🔕 *MODO FOCO ATIVADO!* 🧘\n\n` +
        `⏱️ *Duração:* ${minutes} minutos (até às *${until}*)\n\n` +
        `🤖 *Secretária Eletrônica Ativa:*\n` +
        `Se alguém te enviar mensagem no privado, o bot responderá com educação avisando que você está focado até às ${until} e responderá em seguida.\n\n` +
        `🚨 *Radar de Urgência:* Caso a pessoa diga "urgente", você será alertado imediatamente!\n\n` +
        `👉 Digite \`!foco off\` a qualquer momento para desativar e ver o relatório de contatos.`;

      await sock.sendMessage(destinationJid, { text: reply });
    }
  }

  // COMANDO: !ata ou !pdf [n] [pv] (GERADOR DE ATA EXECUTIVA EM PDF)
  else if (command === 'ata' || command === 'pdf') {
    const limit = cleanArgs[0] && !isNaN(Number(cleanArgs[0])) ? Math.min(Number(cleanArgs[0]), 200) : DEFAULT_SUMMARY_LIMIT;
    const recentMessages = appDatabase.getRecentMessages(remoteJid, limit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(destinationJid, {
        text: `⚠️ [${chatContextLabel}] Poucas mensagens registradas no SQLite para gerar uma ata formal em PDF (mínimo de 3 mensagens). Converse um pouco e tente de novo!`,
      });
      return;
    }

    await sock.sendMessage(destinationJid, {
      text: `📄 *Gerando Ata Executiva em PDF de [${chatContextLabel}]...* Analisando pautas, decisões e plano de ação com Gemini 3.8 Flash! ⏳`,
    });

    try {
      let groupSubject = chatContextLabel;
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(remoteJid).catch(() => null);
          if (meta?.subject) groupSubject = meta.subject;
        } catch {}
      }

      const formattedChat = appDatabase.formatForAI(recentMessages);
      const minutesData = await generateMeetingMinutesData(formattedChat, groupSubject);
      const pdfBuffer = await generateMeetingMinutesPdf(minutesData);

      const safeTitle = groupSubject.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
      const fileName = `Ata_${safeTitle}_${Date.now()}.pdf`;

      let caption =
        `📄 *ATA EXECUTIVA DE REUNIÃO / ALINHAMENTO*\n\n` +
        `📌 *Título:* ${minutesData.title}\n` +
        `📅 *Data:* ${minutesData.date}\n` +
        `👥 *Participantes:* ${minutesData.participants.join(', ') || 'Equipe'}\n\n` +
        `_Documento PDF formal de alta fidelidade gerado com sucesso!_ ✨`;

      if (shouldSendPrivate) {
        caption = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + caption;
      }

      await sock.sendMessage(destinationJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName,
        caption,
      });
      console.log(`✅ Ata em PDF entregue com sucesso para: ${destinationJid}`);
    } catch (err: any) {
      console.error('Erro ao gerar ata em PDF:', err);
      await sock.sendMessage(destinationJid, {
        text: `❌ Falha ao gerar ata em PDF: ${err.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 1: !resumo [n] [pv]
  else if (command === 'resumo') {
    const limit = cleanArgs[0] && !isNaN(Number(cleanArgs[0])) ? Math.min(Number(cleanArgs[0]), 200) : DEFAULT_SUMMARY_LIMIT;
    const recentMessages = appDatabase.getRecentMessages(remoteJid, limit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(destinationJid, {
        text: `⚠️ Ainda não há mensagens suficientes gravadas no SQLite para gerar um resumo (mínimo de 3 mensagens). Converse um pouco e tente de novo!`,
      });
      return;
    }

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);

      appDatabase.saveSummary(remoteJid, summaryResult);

      let responseMessage = formatSummaryForWhatsApp(summaryResult);
      if (shouldSendPrivate) {
        responseMessage = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + responseMessage;
      }

      await sock.sendMessage(destinationJid, { text: responseMessage });
      console.log(`✅ Resumo entregue com sucesso para: ${destinationJid}`);
    } catch (error: any) {
      console.error('Erro ao gerar resumo:', error);
      await sock.sendMessage(destinationJid, {
        text: `❌ Falha ao processar resumo: ${error.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 2: !pergunta [pv] <dúvida sobre o histórico do chat>
  else if (command === 'pergunta') {
    const question = cleanArgs.join(' ').trim();

    if (!question) {
      await sock.sendMessage(destinationJid, {
        text: `💡 *Como usar:* Digite \`${COMMAND_PREFIX}pergunta <sua dúvida>\` (adicione \`pv\` para receber no privado).\nExemplo: \`${COMMAND_PREFIX}pergunta pv Qual o horário da reunião?\``,
      });
      return;
    }

    const recentMessages = appDatabase.getRecentMessages(remoteJid, 100);
    if (recentMessages.length === 0) {
      await sock.sendMessage(destinationJid, {
        text: `⚠️ Nenhuma mensagem encontrada no banco SQLite de [${chatContextLabel}] para responder sua pergunta.`,
      });
      return;
    }

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const answer = await answerChatQuestion(formattedChat, question);

      let reply = `❓ *Pergunta:* ${question}\n\n💡 *Resposta da IA:*\n${answer}\n\n_Baseado no histórico de [${chatContextLabel}]_ 🗄️🤖`;
      if (shouldSendPrivate) {
        reply = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + reply;
      }

      await sock.sendMessage(destinationJid, { text: reply });
      console.log(`✅ Resposta de pergunta entregue para: ${destinationJid}`);
    } catch (error: any) {
      console.error('Erro ao responder pergunta:', error);
      await sock.sendMessage(destinationJid, {
        text: `❌ Erro ao consultar IA: ${error.message || 'Erro inesperado'}`,
      });
    }
  }

  // COMANDO 3: !buscar [pv] <palavra>
  else if (command === 'buscar') {
    const query = cleanArgs.join(' ').trim();

    if (!query) {
      await sock.sendMessage(destinationJid, {
        text: `🔍 *Como usar:* Digite \`${COMMAND_PREFIX}buscar <palavra>\` (adicione \`pv\` para receber no privado).`,
      });
      return;
    }

    const matches = appDatabase.searchMessages(remoteJid, query, 5);

    if (matches.length === 0) {
      await sock.sendMessage(destinationJid, {
        text: `🔍 Nenhuma mensagem encontrada com o termo "${query}" no banco SQLite de [${chatContextLabel}].`,
      });
      return;
    }

    const resultados = matches
      .map((m) => {
        const data = m.timestamp.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        return `📅 [${data}] *${m.senderName}*: "${m.text}"`;
      })
      .join('\n\n');

    let msgText = `🗄️ *MENSAGENS ENCONTRADAS EM [${chatContextLabel}] ("${query}"):*\n\n${resultados}`;
    if (shouldSendPrivate) {
      msgText = `👻 *[MODO FANTASMA]*\n\n` + msgText;
    }

    await sock.sendMessage(destinationJid, { text: msgText });
  }

  // COMANDO 4: !historico [pv]
  else if (command === 'historico') {
    const last = appDatabase.getLastSummary(remoteJid);

    if (!last) {
      await sock.sendMessage(destinationJid, {
        text: `ℹ️ Nenhum resumo anterior foi encontrado no banco de dados para [${chatContextLabel}]. Use \`${COMMAND_PREFIX}resumo\` primeiro!`,
      });
      return;
    }

    const dataFormatada = last.date.toLocaleString('pt-BR');
    let msgFormatted =
      `📑 *ÚLTIMO RESUMO ARQUIVADO DE [${chatContextLabel}]* (Gerado em ${dataFormatada}):\n\n` +
      formatSummaryForWhatsApp(last.summary);

    if (shouldSendPrivate) {
      msgFormatted = `👻 *[MODO FANTASMA]*\n\n` + msgFormatted;
    }

    await sock.sendMessage(destinationJid, { text: msgFormatted });
  }

  // COMANDO 5: !ouvir [pv]
  else if (command === 'ouvir' || command === 'audio') {
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isAudioQuote = Boolean(quotedMsg?.audioMessage);

    if (!isAudioQuote) {
      await sock.sendMessage(destinationJid, {
        text: `🎙️ *Como usar:* Responda a qualquer mensagem de áudio digitando \`${COMMAND_PREFIX}ouvir\` (ou \`${COMMAND_PREFIX}ouvir pv\` para receber no privado)!`,
      });
      return;
    }

    try {
      const audioBuffer = await downloadMediaMessage(
        {
          key: {
            remoteJid,
            id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
            participant: msg.message?.extendedTextMessage?.contextInfo?.participant,
          },
          message: quotedMsg,
        } as any,
        'buffer',
        {},
        {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sock.updateMediaMessage,
        }
      );

      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      const mimeType = quotedMsg?.audioMessage?.mimetype || 'audio/ogg; codecs=opus';

      const audioResult = await transcribeAndSummarizeAudio(base64Audio, mimeType);
      let replyMessage = formatAudioSummaryForWhatsApp(audioResult);

      if (shouldSendPrivate) {
        replyMessage = `👻 *[MODO FANTASMA - ${chatContextLabel}]*\n\n` + replyMessage;
      }

      await sock.sendMessage(destinationJid, { text: replyMessage });
      console.log(`✅ Áudio transcrito e entregue para: ${destinationJid}`);
    } catch (error: any) {
      console.error('Erro ao transcrever áudio:', error);
      await sock.sendMessage(destinationJid, {
        text: `❌ Falha ao processar o áudio com IA: ${error.message || 'Erro ao decodificar áudio'}`,
      });
    }
  }

  // COMANDO 6: !ajuda ou !help
  else if (command === 'ajuda' || command === 'help') {
    const helpText = `🤖 *WhatsApp AI Summarizer - Menu Principal*

• \`!emojis\` ou \`!superpoderes\`
  Exibe o catálogo completo de reações por emojis invisíveis!

• \`!foco [tempo]\` (ex: \`!foco 2h\`, \`!foco 45m\`, \`!foco off\`)
  Ativa o Modo Foco com Secretária Eletrônica para silenciar mensagens no privado.

• \`!ata [n]\` ou \`!pdf [n]\` (adicione \`pv\` para segredo)
  Gera uma Ata Executiva de Reunião formal em PDF com pautas e decisões.

• \`!briefing\`
  Gera o relatório executivo matinal consolidado das últimas 24h dos grupos.

• \`!notas\`
  Lista todas as mensagens e notas que você fixou com 📌 no SQLite.

• \`!resumo [n]\` (adicione \`pv\` para segredo)
  Gera resumo das últimas mensagens do chat.

• \`!pergunta [pv] <dúvida>\`
  Faz uma pergunta para a IA sobre o histórico da conversa.

• \`!buscar [pv] <palavra>\`
  Pesquisa no histórico do SQLite.

• \`!historico [pv]\`
  Exibe o último resumo gerado sem gastar IA.

• \`!limpar\`
  Apaga o histórico do banco de dados desta conversa.`;

    await sock.sendMessage(destinationJid, { text: helpText });
  }

  // COMANDO 7: !limpar
  else if (command === 'limpar') {
    appDatabase.clearChat(remoteJid);
    await sock.sendMessage(destinationJid, { text: `🧹 Histórico de [${chatContextLabel}] apagado do banco SQLite!` });
  }

  // FALLBACK: Comando não reconhecido
  else {
    await sock.sendMessage(destinationJid, {
      text: `❓ Comando \`!${command}\` não reconhecido.\n\nDigite \`!emojis\` para ver o catálogo de superpoderes ou \`!ajuda\` para o menu principal!`,
    });
  }
}

/**
 * Processador dedicado para todas as Reações com Emojis (Gatilhos Invisíveis)
 */
async function handleReactionTrigger(sock: any, msg: WAMessage, reaction: any, ownerJid: string) {
  const emoji = reaction.text?.trim();
  const targetChatJid = reaction.key?.remoteJid;
  const targetMsgId = reaction.key?.id;

  if (!targetChatJid) return;

  const isGrp = targetChatJid.endsWith('@g.us');
  const chatTitle = isGrp ? 'Grupo' : 'Conversa Privada';

  // 1. EMOJI 🧠: RESUMO DO CHAT
  if (emoji === '🧠') {
    console.log(`\n🧠 [Gatilho 🧠]: Resumindo chat ${targetChatJid} (limite: ${DEFAULT_SUMMARY_LIMIT} mensagens)...`);
    const recentMessages = appDatabase.getRecentMessages(targetChatJid, DEFAULT_SUMMARY_LIMIT);

    if (recentMessages.length < 3) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ [${chatTitle}] Poucas mensagens registradas no SQLite para gerar um resumo (mínimo de 3 mensagens).`,
      });
      return;
    }

    try {
      const formattedChat = appDatabase.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);
      appDatabase.saveSummary(targetChatJid, summaryResult);

      const responseMessage =
        `👻 *[MODO FANTASMA INVISÍVEL 🧠]*\n📋 *Resumo de: ${chatTitle}*\n\n` +
        formatSummaryForWhatsApp(summaryResult);

      await sock.sendMessage(ownerJid, { text: responseMessage });
      console.log(`✅ Resumo 🧠 entregue com sucesso no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🧠:', err);
    }
    return;
  }

  // EMOJI 📄 / 📑: GERADOR DE ATA FORMAL EM PDF
  if (emoji === '📄' || emoji === '📑') {
    console.log(`\n📄 [Gatilho 📄]: Gerando ata formal em PDF de ${targetChatJid}...`);
    const recentMessages = appDatabase.getRecentMessages(targetChatJid, DEFAULT_SUMMARY_LIMIT);

    if (recentMessages.length < 3) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ [${chatTitle}] Poucas mensagens registradas no SQLite para gerar uma ata em PDF (mínimo de 3 mensagens).`,
      });
      return;
    }

    try {
      await sock.sendMessage(ownerJid, {
        text: `📄 *Gerando Ata Executiva em PDF de [${chatTitle}]...* Aguarde alguns instantes! ⏳`,
      });

      let groupSubject = chatTitle;
      if (isGrp) {
        try {
          const meta = await sock.groupMetadata(targetChatJid).catch(() => null);
          if (meta?.subject) groupSubject = meta.subject;
        } catch {}
      }

      const formattedChat = appDatabase.formatForAI(recentMessages);
      const minutesData = await generateMeetingMinutesData(formattedChat, groupSubject);
      const pdfBuffer = await generateMeetingMinutesPdf(minutesData);

      const safeTitle = groupSubject.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
      const fileName = `Ata_${safeTitle}_${Date.now()}.pdf`;

      const caption =
        `👻 *[MODO FANTASMA - ATA EXECUTIVA EM PDF 📄]*\n\n` +
        `📌 *Título:* ${minutesData.title}\n` +
        `📅 *Data:* ${minutesData.date}\n` +
        `👥 *Participantes:* ${minutesData.participants.join(', ') || 'Equipe'}\n\n` +
        `_Documento PDF formal gerado silenciosamente via reação 📄!_ ✨`;

      await sock.sendMessage(ownerJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName,
        caption,
      });
      console.log(`✅ Ata em PDF entregue com sucesso no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 📄:', err);
      await sock.sendMessage(ownerJid, {
        text: `❌ Falha ao gerar ata em PDF: ${err.message || 'Erro inesperado'}`,
      });
    }
    return;
  }

  // 2. BUSCA A MENSAGEM ALVO NO BANCO DE DADOS
  const targetMsg = appDatabase.getMessageById(targetMsgId || '');

  // 2.1 PROCESSAMENTO MULTIMODAL (FOTOS, COMPROVANTES, DOCUMENTOS E ÁUDIOS)
  let rawMsgContent: any = null;
  if (targetMsg?.rawMessage) {
    try {
      rawMsgContent = JSON.parse(targetMsg.rawMessage);
    } catch {}
  }

  const isImageOrDoc = Boolean(rawMsgContent?.imageMessage || rawMsgContent?.documentMessage);
  const isAudio = Boolean(rawMsgContent?.audioMessage);

  // GATILHO MULTIMODAL: FOTOS, COMPROVANTES OU DOCUMENTOS (reagiu com 📸 ou 💡 ou 🔍)
  if (isImageOrDoc && (emoji === '📸' || emoji === '💡' || emoji === '🔍' || emoji === '🧠')) {
    console.log(`\n📸 [Visão Multimodal]: Baixando e analisando imagem/documento com Gemini 3.8 Flash...`);
    try {
      const fakeMsg: WAMessage = {
        key: {
          remoteJid: targetChatJid,
          id: targetMsgId,
        },
        message: rawMsgContent,
      };

      const mediaBuffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );

      const mimeType =
        rawMsgContent.imageMessage?.mimetype ||
        rawMsgContent.documentMessage?.mimetype ||
        'image/jpeg';

      const caption =
        rawMsgContent.imageMessage?.caption ||
        rawMsgContent.documentMessage?.caption ||
        targetMsg?.text ||
        '';

      const analysis = await analyzeImageOrDocument(mediaBuffer.toString('base64'), mimeType, caption);
      await sock.sendMessage(ownerJid, {
        text: `👻 *[VISÃO DE IMAGEM / DOCUMENTO 📸 - ${chatTitle}]*\n\n` + analysis,
      });
      console.log(`✅ Análise de imagem/documento entregue no privado!`);
      return;
    } catch (err: any) {
      console.error('Erro ao baixar e analisar imagem por reação:', err);
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Não foi possível baixar a imagem para análise: ${err.message || 'Mídia indisponível'}`,
      });
      return;
    }
  }

  // GATILHO MULTIMODAL: ÁUDIO (reagiu com 🎧 ou 💡)
  if (isAudio && (emoji === '🎧' || emoji === '💡')) {
    console.log(`\n🎧 [Áudio Multimodal]: Baixando e transcrevendo áudio com Gemini 3.8 Flash...`);
    try {
      const fakeMsg: WAMessage = {
        key: {
          remoteJid: targetChatJid,
          id: targetMsgId,
        },
        message: rawMsgContent,
      };

      const audioBuffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );

      const mimeType = rawMsgContent.audioMessage?.mimetype || 'audio/ogg';
      const audioResult = await transcribeAndSummarizeAudio(audioBuffer.toString('base64'), mimeType);
      const reply =
        `👻 *[TRANSCRIÇÃO DE ÁUDIO 🎧 - ${chatTitle}]*\n\n` +
        formatAudioSummaryForWhatsApp(audioResult);

      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Transcrição de áudio entregue no privado!`);
      return;
    } catch (err: any) {
      console.error('Erro ao transcrever áudio por reação:', err);
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Não foi possível transcrever este áudio: ${err.message || 'Falha no download'}`,
      });
      return;
    }
  }

  // 3. EMOJI 📌: SALVAR NOTA NOS FAVORITOS DO SQLITE
  if (emoji === '📌') {
    console.log(`\n📌 [Gatilho 📌]: Fixando mensagem nos favoritos...`);
    if (!targetMsg) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Mensagem não encontrada no banco SQLite para fixar.`,
      });
      return;
    }

    appDatabase.savePinnedNote(
      targetMsg.id,
      targetChatJid,
      chatTitle,
      targetMsg.senderName,
      targetMsg.text
    );

    const conf = `📌 *MENSAGEM SALVA NOS SEUS FAVORITOS (SQLite)*\n\n🏷️ *Origem:* ${chatTitle}\n👤 *Autor:* ${targetMsg.senderName}\n💬 *Conteúdo:* "${targetMsg.text}"\n\n_Digite !notas no seu privado para ver todas as notas salvas!_`;
    await sock.sendMessage(ownerJid, { text: conf });
    console.log(`✅ Nota fixada com sucesso no SQLite!`);
    return;
  }

  // Se for qualquer outra ação que exige texto da mensagem
  if (!targetMsg) {
    console.log(`ℹ️ Mensagem [${targetMsgId}] não encontrada no banco para a ação do emoji ${emoji}`);
    return;
  }

  // 4. EMOJI ✍️: GHOSTWRITER (SUGESTÕES DE RESPOSTA)
  if (emoji === '✍️' || emoji === '✍') {
    console.log(`\n✍️ [Gatilho ✍️]: Gerando opções de resposta para mensagem de ${targetMsg.senderName}...`);
    try {
      const suggestions = await suggestReplies(targetMsg.text);
      const reply = `👻 *[GHOSTWRITER ✍️ - ${chatTitle}]*\n👤 *Mensagem de ${targetMsg.senderName}:* "${targetMsg.text}"\n\n` + suggestions;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Sugestões de resposta entregues no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho ✍️:', err);
    }
    return;
  }

  // 5. EMOJI 💡: EXPLICADOR DIDÁTICO
  if (emoji === '💡') {
    console.log(`\n💡 [Gatilho 💡]: Explicando mensagem de ${targetMsg.senderName}...`);
    try {
      const explanation = await explainMessage(targetMsg.text);
      const reply = `👻 *[EXPLICADOR 💡 - ${chatTitle}]*\n💬 *Texto Original:* "${targetMsg.text}"\n\n` + explanation;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Explicação 💡 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 💡:', err);
    }
    return;
  }

  // 6. EMOJI 🌐: TRADUTOR PARA PORTUGUÊS
  if (emoji === '🌐' || emoji === '🌍') {
    console.log(`\n🌐 [Gatilho 🌐]: Traduzindo mensagem...`);
    try {
      const translation = await translateMessage(targetMsg.text);
      const reply = `👻 *[TRADUTOR 🌐 - ${chatTitle}]*\n💬 *Original:* "${targetMsg.text}"\n\n` + translation;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Tradução 🌐 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🌐:', err);
    }
    return;
  }

  // 7. EMOJI 🎯: EXTRATOR DE TAREFAS (TO-DO LIST)
  if (emoji === '🎯' || emoji === '📋') {
    console.log(`\n🎯 [Gatilho 🎯]: Extraindo tarefas da mensagem...`);
    try {
      const tasks = await extractTasks(targetMsg.text);
      const reply = `👻 *[EXTRATOR DE TAREFAS 🎯 - ${chatTitle}]*\n💬 *Contexto:* "${targetMsg.text}"\n\n` + tasks;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Checklist 🎯 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🎯:', err);
    }
    return;
  }

  // 8. EMOJI 🕵️‍♂️: CHECADOR DE FATOS / FAKE NEWS
  if (emoji === '🕵️‍♂️' || emoji === '🕵️' || emoji === '🔍') {
    console.log(`\n🕵️‍♂️ [Gatilho 🕵️‍♂️]: Checando fatos e credibilidade da mensagem...`);
    try {
      const factCheck = await factCheckMessage(targetMsg.text);
      const reply = `👻 *[FACT-CHECK 🕵️‍♂️ - ${chatTitle}]*\n💬 *Mensagem Analisada:* "${targetMsg.text}"\n\n` + factCheck;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Análise de fatos 🕵️‍♂️ entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🕵️‍♂️:', err);
    }
    return;
  }

  // 9. EMOJI 💰: DIVISOR DE CONTAS / RACHID
  if (emoji === '💰' || emoji === '🧾') {
    console.log(`\n💰 [Gatilho 💰]: Calculando divisão de despesas...`);
    try {
      const expenses = await splitExpenses(targetMsg.text);
      const reply = `👻 *[DIVISOR DE CONTAS 💰 - ${chatTitle}]*\n💬 *Gastos Listados:* "${targetMsg.text}"\n\n` + expenses;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Divisão de contas 💰 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 💰:', err);
    }
    return;
  }

  // 10. EMOJI 🔗: RESUMO DE LINK
  if (emoji === '🔗' || emoji === '📰') {
    console.log(`\n🔗 [Gatilho 🔗]: Resumindo link da mensagem...`);
    const urlMatch = targetMsg.text.match(/https?:\/\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0] : '';

    if (!url) {
      await sock.sendMessage(ownerJid, {
        text: `⚠️ Nenhum link (URL) foi detectado na mensagem para resumir.`,
      });
      return;
    }

    try {
      const linkSummary = await summarizeLinkContent(url, targetMsg.text);
      const reply = `👻 *[LEITOR DE LINKS 🔗 - ${chatTitle}]*\n\n` + linkSummary;
      await sock.sendMessage(ownerJid, { text: reply });
      console.log(`✅ Resumo do link 🔗 entregue no privado!`);
    } catch (err: any) {
      console.error('Erro no gatilho 🔗:', err);
    }
    return;
  }
}

// Inicia a aplicação
startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
