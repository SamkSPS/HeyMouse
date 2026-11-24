$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root '.tmp/edge-drag'
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Compilador .NET Framework indisponível.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$executable = Join-Path $output 'EdgeDragProbe.exe'
& $compiler /nologo /target:exe "/out:$executable" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $root 'native/windows/EdgeDragProbe.cs')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar o teste de arraste.' }
Write-Output $executable
