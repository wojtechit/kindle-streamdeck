' Uruchamia serwer w tle bez okna konsoli (do Autostartu / Harmonogramu zadan).
' Wymaga, by start.bat byl choc raz uruchomiony (utworzy .venv).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run """" & dir & "\.venv\Scripts\pythonw.exe"" """ & dir & "\server.py""", 0, False
