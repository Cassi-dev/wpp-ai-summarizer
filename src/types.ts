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
 * Interface que define o Structured Output do resumo geral retornado pelo Gemini
 */
export interface SummaryResult {
  assuntos: string[];
  decisoes: string[];
  pendencias: string[];
  urgencia: 'baixa' | 'media' | 'alta';
  resumoGeral: string;
}

/**
 * Interface que define a resposta da transcrição e resumo de áudio
 */
export interface AudioSummaryResult {
  transcricao: string;
  resumo: string;
  pontosChave: string[];
}
