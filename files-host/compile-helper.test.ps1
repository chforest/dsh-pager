# Compile, then exercise production Node pipes with a missing file.
$ErrorActionPreference='Stop'
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not (Test-Path -LiteralPath $compiler)) { $compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
$source=Join-Path $PSScriptRoot 'FileAction.cs'
$output=Join-Path ([IO.Path]::GetTempPath()) ('dsh-file-action-compile-'+[guid]::NewGuid().ToString('N')+'.exe')
try {
  & $compiler /nologo /target:winexe /optimize+ /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$output" $source
  if($LASTEXITCODE -ne 0){throw 'Native helper compilation failed'}
  $bytes=[IO.File]::ReadAllBytes($output)
  $pe=[BitConverter]::ToInt32($bytes,0x3c)
  if([BitConverter]::ToUInt16($bytes,$pe+24+68) -ne 2){throw 'Expected GUI subsystem'}
  $missing=Join-Path ([IO.Path]::GetTempPath()) ('dsh-nonexistent-'+[guid]::NewGuid().ToString('N')+'.txt')
  if(Test-Path -LiteralPath $missing){throw 'Fixture path unexpectedly exists'}
  node (Join-Path $PSScriptRoot 'helper-receipt-check.mjs') $output $missing
  if($LASTEXITCODE -ne 0){throw 'Native helper receipt test failed'}
} finally { if(Test-Path -LiteralPath $output){Remove-Item -LiteralPath $output} }
