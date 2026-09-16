import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WAMessage,
} from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { messageBuffer } from './buffer.js';
import { formatSummaryForWhatsApp, generateChatSummary } from './gemini.js';
import { ChatMessage } from './types.js';

dotenv.config();

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';

/**
 * Função principal que inicia o cliente WhatsApp e escuta os eventos
 */
async function startWhatsAppBot() {
  console.log('\n🚀 Iniciando WhatsApp AI Summarizer...');

  // 1. Gerenciamento de Estado da Sessão (salva as credenciais em disco para não pedir QR code toda vez)
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  // 2. Criação do Socket de Conexão com o WhatsApp Web
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '122.0.6261.129'],
    syncFullHistory: false, // Foco em mensagens em tempo real, sem puxar anos de histórico
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
      console.log('\n✅ SUCESSO: WhatsApp Conectado e Monitorando Mensagens!');
      console.log(`🤖 Comandos disponíveis nos seus chats:`);
      console.log(`   👉 "${COMMAND_PREFIX}resumo"    - Resume as últimas mensagens da conversa`);
      console.log(`   👉 "${COMMAND_PREFIX}resumo 30" - Resume as últimas 30 mensagens`);
      console.log(`   👉 "${COMMAND_PREFIX}ajuda"     - Exibe as opções disponíveis\n`);
    }
  });

  // 4. Salva as credenciais sempre que forem atualizadas
  sock.ev.on('creds.update', saveCreds);

  // 5. Escuta e Processamento de Mensagens em Tempo Real (Event-Driven)
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      await handleIncomingMessage(sock, msg);
    }
  });
}

/**
 * Lida com cada mensagem recebida
 */
async function handleIncomingMessage(sock: any, msg: WAMessage) {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  // Extrai o texto da mensagem (de texto comum ou texto estendido com preview)
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    '';

  if (!text || text.trim() === '') return;

  const senderName = msg.pushName || 'Usuário';
  const isGroup = remoteJid.endsWith('@g.us');

  // Adiciona ao buffer da conversa (apenas mensagens que não sejam comandos do bot)
  if (!text.startsWith(COMMAND_PREFIX)) {
    const chatMsg: ChatMessage = {
      id: msg.key.id || Math.random().toString(),
      sender: msg.key.participant || remoteJid,
      senderName,
      text: text.trim(),
      timestamp: new Date((msg.messageTimestamp as number) * 1000),
      isGroup,
    };
    messageBuffer.addMessage(remoteJid, chatMsg);
    return;
  }

  // --- TRATAMENTO DE COMANDOS (!resumo, !ajuda) ---
  const args = text.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  // COMANDO: !resumo
  if (command === 'resumo') {
    const limit = args[1] && !isNaN(Number(args[1])) ? Math.min(Number(args[1]), 100) : 50;
    const recentMessages = messageBuffer.getRecentMessages(remoteJid, limit);

    if (recentMessages.length < 3) {
      await sock.sendMessage(remoteJid, {
        text: `⚠️ Ainda não acumulei mensagens suficientes nesta conversa para gerar um resumo (mínimo de 3 mensagens necessárias). Converse mais um pouco e tente de novo!`,
      });
      return;
    }

    // Feedback visual imediato: avisa que está processando com a IA
    await sock.sendMessage(remoteJid, {
      text: `⏳ _Lendo as últimas ${recentMessages.length} mensagens e gerando resumo inteligente com Gemini AI..._`,
    });

    try {
      const formattedChat = messageBuffer.formatForAI(recentMessages);
      const summaryResult = await generateChatSummary(formattedChat);
      const responseMessage = formatSummaryForWhatsApp(summaryResult);

      // Envia o resumo pronto de volta no WhatsApp
      await sock.sendMessage(remoteJid, { text: responseMessage });
    } catch (error: any) {
      console.error('Erro ao gerar resumo com Gemini:', error);
      await sock.sendMessage(remoteJid, {
        text: `❌ Falha ao processar com IA: ${error.message || 'Verifique a chave GEMINI_API_KEY no arquivo .env'}`,
      });
    }
  }

  // COMANDO: !ajuda
  else if (command === 'ajuda') {
    const helpText = `🤖 *WhatsApp AI Summarizer - Comandos*\n
• \`${COMMAND_PREFIX}resumo\` : Gera um resumo estruturado das últimas 50 mensagens desta conversa.
• \`${COMMAND_PREFIX}resumo 20\` : Resume as últimas 20 mensagens.
• \`${COMMAND_PREFIX}limpar\` : Limpa a memória das mensagens acumuladas desta conversa.
• \`${COMMAND_PREFIX}ajuda\` : Exibe esta mensagem de ajuda.`;

    await sock.sendMessage(remoteJid, { text: helpText });
  }

  // COMANDO: !limpar
  else if (command === 'limpar') {
    messageBuffer.clear(remoteJid);
    await sock.sendMessage(remoteJid, { text: `🧹 Memória temporária desta conversa limpa com sucesso!` });
  }
}

// Inicia a aplicação
startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
