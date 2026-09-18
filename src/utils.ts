import { jidNormalizedUser, WAMessage } from '@whiskeysockets/baileys';

/**
 * Obtém o JID do WhatsApp privado do usuário (dono da conta)
 */
export function getOwnerJid(sock: any, msg?: WAMessage): string {
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
export function isAuthorized(
  msg: WAMessage,
  onlyOwner: boolean,
  allowedNumbers: string[]
): boolean {
  if (msg.key.fromMe) return true; // Sempre autoriza você (dono da conta)
  if (!onlyOwner) return true; // Se desativou a trava, permite qualquer um

  const sender = msg.key.participant || msg.key.remoteJid || '';
  const senderNumber = sender.replace(/[^0-9]/g, '');

  return allowedNumbers.some((num) => senderNumber.includes(num));
}

/**
 * Converte argumentos de tempo (ex: "2h", "45m", "90", "1.5h") em minutos
 */
export function parseFocusDuration(arg?: string): number {
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
 * Formata mensagens de erro da IA para uma resposta amigável e humana no WhatsApp
 */
export function formatAiErrorMessage(err: any, defaultContext = 'solicitação'): string {
  const rawMsg = err?.message || String(err || '');
  if (
    rawMsg.includes('503') ||
    rawMsg.includes('high demand') ||
    rawMsg.includes('UNAVAILABLE') ||
    rawMsg.includes('overloaded')
  ) {
    return 'Os servidores do Google Gemini estão enfrentando um pico temporário de demanda. O bot realizou tentativas de contingência, mas a nuvem segue congestionada. Aguarde 1 a 2 minutos e tente novamente!';
  }
  if (rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
    return 'Limite de requisições por minuto atingido no Gemini. Aguarde 30 segundos antes de tentar novamente.';
  }
  return rawMsg || `Erro inesperado ao processar ${defaultContext}.`;
}
