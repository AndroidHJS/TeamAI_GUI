$ErrorActionPreference = "Stop"

try {
  $pipeName = $env:TEAMAI_ASKPASS_PIPE
  if ([string]::IsNullOrWhiteSpace($pipeName)) { exit 1 }

  $prompt = if ($args.Count -gt 0) { [string]$args[0] } else { "Password:" }
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
    ".",
    $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None
  )
  $pipe.Connect(5000)
  $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
  $writer.AutoFlush = $true
  $reader = [System.IO.StreamReader]::new($pipe, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
  $writer.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($prompt)))
  $encodedSecret = $reader.ReadLine()
  if (-not [string]::IsNullOrEmpty($encodedSecret)) {
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedSecret)))
  }
  $reader.Dispose()
  $writer.Dispose()
  $pipe.Dispose()
} catch {
  exit 1
}
