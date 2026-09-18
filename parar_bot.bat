@echo off
chcp 65001 > nul
echo Encerrando o WhatsApp AI Bot...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /f /pid %%a > nul 2>&1
)
echo Bot finalizado com sucesso!
