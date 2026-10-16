# Hauskarte BW - Mitarbeiter verwalten
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$srv = 'C:\Hauskarte\server.js'
if (-not (Test-Path $srv)) { $srv = Join-Path $PSScriptRoot 'server.js' }
while ($true) {
  Write-Host "`n=== Hauskarte - Mitarbeiter ===" -ForegroundColor Cyan
  & $node $srv user list
  Write-Host "`n  1  Mitarbeiter anlegen`n  2  PIN aendern`n  3  Mitarbeiter sperren`n  4  Server-Status`n  5  Administrator festlegen / entziehen`n  0  Beenden"
  switch (Read-Host "`nAuswahl") {
    '1' { $n = Read-Host 'Name (so meldet er sich an, z. B. Max Mueller)'; $p = Read-Host 'PIN (mind. 4 Ziffern)'; & $node $srv user add $n $p }
    '2' { $n = Read-Host 'Name'; $p = Read-Host 'Neue PIN'; & $node $srv user pin $n $p }
    '3' { $n = Read-Host 'Name'; if ((Read-Host "$n wirklich sperren? (j/n)") -eq 'j') { & $node $srv user remove $n } }
    '4' { try { $s = Invoke-RestMethod 'http://127.0.0.1:8787/status' -TimeoutSec 5; Write-Host "Server laeuft. $($s.aenderungen) Aenderungen, letzte: $($s.letzte)" -ForegroundColor Green } catch { Write-Host 'Server antwortet nicht! Laptop neu starten oder install.ps1 erneut ausfuehren.' -ForegroundColor Red }
          if (Test-Path "$PSScriptRoot\ADRESSE.txt") { Get-Content "$PSScriptRoot\ADRESSE.txt" } }
    '5' { $n = Read-Host 'Name'; $j = Read-Host "$n zum Administrator machen? (j = ja, n = Rechte entziehen)"; if ($j -eq 'j') { & $node $srv user admin $n ja } else { & $node $srv user admin $n nein } }
    '0' { exit }
  }
}
