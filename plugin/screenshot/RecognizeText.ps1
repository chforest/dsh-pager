$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 2 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation, [Threading.CancellationToken]::None))
  return $task.GetAwaiter().GetResult()
}
$stream=$null; $writer=$null; $bitmap=$null
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($request.data)
  if ($bytes.Length -gt 33554432 -or $bytes.Length -lt 24) { throw 'invalid-image' }
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
  $writer.WriteBytes($bytes)
  $null = Await ($writer.StoreAsync()) ([uint32])
  $writer.DetachStream() | Out-Null
  $stream.Seek(0)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  if ($decoder.PixelWidth -ne $request.width -or $decoder.PixelHeight -ne $request.height -or $decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'image-dimensions' }
  $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
  $lang = $languages | Where-Object { $_.LanguageTag -match '^zh' } | Select-Object -First 1
  if ($lang) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) }
  else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (!$engine -and $languages.Count -gt 0) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languages[0]) }
  if (!$engine) { throw 'no-language' }
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object {
    @{ text=$_.Text; words=@($_.Words | ForEach-Object { @{text=$_.Text;x=$_.BoundingRect.X;y=$_.BoundingRect.Y;width=$_.BoundingRect.Width;height=$_.BoundingRect.Height} }) }
  })
  @{ok=$true;value=@{text=($lines.text -join "`n");lines=$lines;language=$engine.RecognizerLanguage.LanguageTag;width=$decoder.PixelWidth;height=$decoder.PixelHeight}} | ConvertTo-Json -Depth 8 -Compress
} catch {
  $code = 'ocr-failed'
  if ($_.Exception.Message -match 'no-language') { $code='ocr-no-language' }
  elseif ($_.Exception.Message -match 'image-dimensions|invalid-image') { $code='ocr-invalid-image' }
  @{ok=$false;error=@{code=$code}} | ConvertTo-Json -Compress
} finally {
  if ($bitmap) { $bitmap.Dispose() }; if ($writer) { $writer.Dispose() }; if ($stream) { $stream.Dispose() }
}
