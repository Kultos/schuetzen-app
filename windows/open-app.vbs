Option Explicit

Dim shell, fileSystem, scriptDirectory, command, argument
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  QuoteArgument(fileSystem.BuildPath(scriptDirectory, "open-app.ps1"))

For Each argument In WScript.Arguments
  command = command & " " & QuoteArgument(CStr(argument))
Next

shell.Run command, 0, False

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
