# Compile, then run a nonexistent-file negative case. No GUI is invoked.
$ErrorActionPreference='Stop'
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not (Test-Path -LiteralPath $compiler)) { $compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
$source=Join-Path $PSScriptRoot 'FileAction.cs'
$output=Join-Path ([IO.Path]::GetTempPath()) ('dsh-file-action-compile-'+[guid]::NewGuid().ToString('N')+'.exe')
$probe=$output+'.cs'
try {
  # Diagnostics only for this synthetic missing-file fixture, never production.
  $code=[IO.File]::ReadAllText($source).Replace('error.GetType().Name+" hresult="+error.HResult','error.GetType().Name+" hresult="+error.HResult+" test-detail="+error.ToString()')
  [IO.File]::WriteAllText($probe,$code,[Text.UTF8Encoding]::new($false))
  & $compiler /nologo /target:winexe /optimize+ /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$output" $probe
  if($LASTEXITCODE -ne 0){throw 'Native helper compilation failed'}
  $bytes=[IO.File]::ReadAllBytes($output)
  $pe=[BitConverter]::ToInt32($bytes,0x3c)
  $subsystem=[BitConverter]::ToUInt16($bytes,$pe+24+68)
  if($subsystem -ne 2){throw 'Expected Windows GUI subsystem without console'}
  $missing=Join-Path ([IO.Path]::GetTempPath()) ('dsh-nonexistent-'+[guid]::NewGuid().ToString('N')+'.txt')
  if(Test-Path -LiteralPath $missing){throw 'Fixture path unexpectedly exists'}
  $start=New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName=$output;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=New-Object System.Text.UTF8Encoding($false)
  $start.StandardErrorEncoding=New-Object System.Text.UTF8Encoding($false)
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$start
  try {
    [void]$process.Start()
    $request=[Text.Encoding]::UTF8.GetBytes((@{action='open';path=$missing}|ConvertTo-Json -Compress))
    # Do not close the unused text writer: on some Windows locales it flushes
    # a UTF-8 preamble after the JSON bytes, making the request invalid.
    $process.StandardInput.BaseStream.Write($request,0,$request.Length);$process.StandardInput.BaseStream.Flush();$process.StandardInput.BaseStream.Close()
    if(-not $process.WaitForExit(10000)){$process.Kill();throw 'Negative fixture timed out'}
    $reply=$process.StandardOutput.ReadToEnd()|ConvertFrom-Json
    $diagnostic=$process.StandardError.ReadToEnd()
    if($process.ExitCode -ne 1 -or $reply.ok -ne $false -or $reply.error -ne 'FILE_ACTION_FAILED'){throw 'Expected structured failure and exit 1'}
    if($diagnostic -notmatch '^FILE_ACTION_ERROR type=FileNotFoundException hresult=-?\d+') {throw ('Unexpected safe exception diagnostic: '+$diagnostic.Trim())}
    Write-Output 'PASS: GUI subsystem compiled; no-console nonexistent-file execution returned JSON failure and exit 1; no dialog or real file action invoked'
  } finally { $process.Dispose() }
} finally { if(Test-Path -LiteralPath $output){Remove-Item -LiteralPath $output}; if(Test-Path -LiteralPath $probe){Remove-Item -LiteralPath $probe} }
