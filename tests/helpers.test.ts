import { describe, expect, it } from 'vitest';
import { formatAiErrorMessage, isAuthorized, parseFocusDuration } from '../src/utils.js';

describe('Utilitários - parseFocusDuration', () => {
  it('deve converter horas para minutos corretamente ("2h" -> 120)', () => {
    expect(parseFocusDuration('2h')).toBe(120);
  });

  it('deve converter fração de horas ("1.5h" -> 90)', () => {
    expect(parseFocusDuration('1.5h')).toBe(90);
  });

  it('deve converter minutos com sufixo ("45m" -> 45, "30min" -> 30)', () => {
    expect(parseFocusDuration('45m')).toBe(45);
    expect(parseFocusDuration('30min')).toBe(30);
  });

  it('deve interpretar número direto como minutos ("90" -> 90)', () => {
    expect(parseFocusDuration('90')).toBe(90);
  });

  it('deve retornar 60 minutos como padrão se argumento for nulo ou inválido', () => {
    expect(parseFocusDuration(undefined)).toBe(60);
    expect(parseFocusDuration('')).toBe(60);
    expect(parseFocusDuration('abc')).toBe(60);
  });
});

describe('Utilitários - formatAiErrorMessage', () => {
  it('deve humanizar erros 503 de alta demanda', () => {
    const err = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
    const msg = formatAiErrorMessage(err, 'o briefing');
    expect(msg).toContain('pico temporário de demanda');
  });

  it('deve humanizar erros 429 de esgotamento de cota', () => {
    const err = new Error('RESOURCE_EXHAUSTED: rate limit exceeded');
    const msg = formatAiErrorMessage(err, 'o resumo');
    expect(msg).toContain('Limite de requisições por minuto');
  });

  it('deve retornar a mensagem original para erros desconhecidos', () => {
    const err = new Error('Falha de conexão com a rede local');
    const msg = formatAiErrorMessage(err, 'a consulta');
    expect(msg).toBe('Falha de conexão com a rede local');
  });
});

describe('Utilitários - isAuthorized', () => {
  it('deve autorizar sempre quando fromMe for true (o próprio dono)', () => {
    const msg: any = { key: { fromMe: true } };
    expect(isAuthorized(msg, true, [])).toBe(true);
  });

  it('deve autorizar qualquer um quando onlyOwner for false', () => {
    const msg: any = { key: { fromMe: false, participant: '5511999999999@s.whatsapp.net' } };
    expect(isAuthorized(msg, false, [])).toBe(true);
  });

  it('deve bloquear usuário não autorizado quando onlyOwner for true', () => {
    const msg: any = { key: { fromMe: false, participant: '5511999999999@s.whatsapp.net' } };
    expect(isAuthorized(msg, true, ['5521888888888'])).toBe(false);
  });

  it('deve autorizar número listado em allowedNumbers', () => {
    const msg: any = { key: { fromMe: false, participant: '5511999999999@s.whatsapp.net' } };
    expect(isAuthorized(msg, true, ['5511999999999'])).toBe(true);
  });
});
