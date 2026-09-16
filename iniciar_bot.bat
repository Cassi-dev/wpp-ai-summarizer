@echo off
title WhatsApp AI Bot (Logs em Tempo Real)
chcp 65001 > nul
cd /d "%~dp0"
echo ======================================================
echo    WhatsApp AI Bot - Iniciando em Modo Visivel
echo ======================================================
npm run start
pause
