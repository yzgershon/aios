' AIOS server launcher — starts node server.js with NO console window.
' Used by the "AIOS Server" scheduled task (runs at logon).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("WScript.Shell").ExpandEnvironmentStrings("%USERPROFILE%") & "\Desktop\AIOS"
sh.Run "cmd /c node server.js >> server.out.log 2>> server.err.log", 0, False
