@echo off
title WhatsApp AI Bot (Logs em Tempo Real)
chcp 65001 > nul
cd /d "%~dp0"

echo [1/2] Verificando se ha instancias anteriores ativas...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /f /pid %%a > nul 2>&1
)

echo [2/2] Iniciando WhatsApp AI Bot...
echo ======================================================
echo    WhatsApp AI Bot - Ativo e Monitorando Mensagens
echo ======================================================
npm run start
pause
