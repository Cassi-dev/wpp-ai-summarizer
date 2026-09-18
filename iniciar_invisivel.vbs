Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
strPath = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strPath

' Garante que qualquer instancia anterior seja encerrada antes de iniciar
WshShell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -aon ^| findstr :3000') do taskkill /f /pid %a > nul 2>&1", 0, True

' Inicia o bot em segundo plano sem janela
WshShell.Run "cmd /c npm run start", 0, False
