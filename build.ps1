# Builds "Arctium Mod Manager.exe" from src\ArctiumModManager.cs with the C# compiler that ships with Windows (.NET Framework 4).
# Nothing is downloaded. The exe serves the web\ folder next to it, so keep the exe in this folder.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe (.NET Framework 4) not found. Turn on ".NET Framework 4.8 Advanced Services" in Windows Features.' }
$out = Join-Path $here 'Arctium Mod Manager.exe'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ `
  "/win32icon:$here\src\app.ico" "/out:$out" `
  /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll `
  "$here\src\ArctiumModManager.cs"
if ($LASTEXITCODE -ne 0) { throw "Compile failed ($LASTEXITCODE)" }
Write-Host "Built: $out"
