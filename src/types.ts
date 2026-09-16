/**
 * Interface que representa uma mensagem capturada do WhatsApp
 */
export interface ChatMessage {
  id: string;
  sender: string;
  senderName: string;
  text: string;
  timestamp: Date;
  isGroup: boolean;
}

/**
 * Interface que define o Structured Output retornado pelo Gemini
 */
export interface SummaryResult {
  assuntos: string[];
  decisoes: string[];
  pendencias: string[];
  urgencia: 'baixa' | 'media' | 'alta';
  resumoGeral: string;
}
