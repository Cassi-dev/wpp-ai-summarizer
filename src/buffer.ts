import { ChatMessage } from './types.js';

/**
 * Gerenciador de memória volátil para armazenar as mensagens recentes de cada conversa.
 * Em computação, chamamos isso de "Ring Buffer" ou "Fila Circular em Memória".
 */
class MessageBufferManager {
  private buffer: Map<string, ChatMessage[]> = new Map();
  private maxMessagesPerChat: number = 100;

  /**
   * Adiciona uma nova mensagem ao histórico da conversa
   */
  public addMessage(chatJid: string, message: ChatMessage): void {
    if (!this.buffer.has(chatJid)) {
      this.buffer.set(chatJid, []);
    }

    const messages = this.buffer.get(chatJid)!;
    messages.push(message);

    // Mantém apenas as últimas N mensagens para não estourar a memória RAM
    if (messages.length > this.maxMessagesPerChat) {
      messages.shift();
    }
  }

  /**
   * Obtém as últimas N mensagens da conversa
   */
  public getRecentMessages(chatJid: string, limit: number = 50): ChatMessage[] {
    const messages = this.buffer.get(chatJid) || [];
    return messages.slice(-limit);
  }

  /**
   * Limpa o buffer de uma conversa específica
   */
  public clear(chatJid: string): void {
    this.buffer.delete(chatJid);
  }

  /**
   * Formata as mensagens em texto limpo para alimentar o Gemini
   */
  public formatForAI(messages: ChatMessage[]): string {
    if (messages.length === 0) return 'Nenhuma mensagem recente encontrada.';

    return messages
      .map((m) => {
        const hora = m.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `[${hora}] ${m.senderName}: ${m.text}`;
      })
      .join('\n');
  }
}

export const messageBuffer = new MessageBufferManager();
