# Hauskarte BW - Server auf diesem Laptop einrichten (einmalig; kann gefahrlos wiederholt werden)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit
}
function Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Fehler($t) { Write-Host "  [X]  $t" -ForegroundColor Red; Read-Host "`nEnter zum Beenden"; exit 1 }

$Ziel = 'C:\Hauskarte'
$Quelle = $PSScriptRoot
Write-Host "`n=== enerwave Connect - Server einrichten ===`n" -ForegroundColor Cyan

# 1. Node.js
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not $node) { Fehler 'Node.js fehlt. Bitte von nodejs.org die LTS-Version installieren und dieses Skript erneut starten.' }
$ver = [int]((& $node -v).TrimStart('v').Split('.')[0])
if ($ver -lt 22) { Fehler "Node.js ist zu alt (Version $ver). Bitte die aktuelle LTS-Version von nodejs.org installieren." }
Ok "Node.js Version $ver gefunden"

# 2. Dateien nach C:\Hauskarte kopieren (vorhandene Daten bleiben erhalten)
New-Item -ItemType Directory -Force $Ziel, "$Ziel\daten" | Out-Null
if ($Quelle.TrimEnd('\') -ne $Ziel) {
  Get-ChildItem $Quelle | Where-Object { $_.Name -ne 'daten' } | Copy-Item -Destination $Ziel -Recurse -Force
}
Ok "Programm liegt in $Ziel"

# 3. Autostart: Server startet mit Windows (auch ohne Anmeldung) und nach Absturz neu
$task = 'Hauskarte Server'
[IO.File]::WriteAllText("$Ziel\node-path.txt", $node)
$arg = "/c `"`"$Ziel\start-server.cmd`"`""
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $Ziel
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start-server.cmd*') -or ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*server.js*') -and ($_.ExecutablePath -eq $node)) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $task
Ok 'Autostart eingerichtet und Server gestartet'

# 4. Laptop wach halten (am Netzteil) und Update-Neustarts nicht tagsueber
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null
Ok 'Energiesparen am Netzteil aus, Zuklappen des Deckels ohne Wirkung'
try {
  $wu = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
  New-Item -Path $wu -Force | Out-Null
  Set-ItemProperty $wu -Name ActiveHoursStart -Value 6 -Type DWord
  Set-ItemProperty $wu -Name ActiveHoursEnd -Value 23 -Type DWord
  Set-ItemProperty $wu -Name SmartActiveHoursState -Value 0 -Type DWord
  Ok 'Windows-Update startet nur zwischen 23 und 6 Uhr neu'
} catch { Warn 'Nutzungszeit fuer Windows-Update konnte nicht gesetzt werden (bitte in Einstellungen > Windows Update auf 6-23 Uhr stellen)' }

# 5. Pruefen, ob der Server antwortet
Start-Sleep -Seconds 3
try { $s = Invoke-RestMethod 'http://127.0.0.1:8787/status' -TimeoutSec 10; Ok "Server antwortet ($($s.aenderungen) Aenderungen gespeichert)" }
catch { Warn "Server antwortet noch nicht. Protokoll: $Ziel\daten\server.log" }

# 6. Tailscale: App sicher ueber das VPN erreichbar machen (HTTPS)
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $ts)) { Warn 'Tailscale ist nicht installiert. Bitte installieren, anmelden und dieses Skript erneut starten.' }
else {
  & $ts set --unattended=true 2>&1 | Out-Null
  Ok 'Tailscale laeuft auch ohne angemeldeten Benutzer'
  & $ts serve --bg 8787
  $self = ''
  try { $self = [string]((& $ts status --json | Out-String | ConvertFrom-Json).Self.DNSName) } catch { }
  $self = $self.TrimEnd('.')
  if (-not $self) { Warn 'Tailscale-Name nicht gefunden. Ist Tailscale angemeldet?' }
  if ($self) {
    $url = "https://$self/"
    Set-Content "$Ziel\ADRESSE.txt" "enerwave Connect: $url"
    Write-Host "`n  Adresse der Team-App fuer die Tablets:`n" -ForegroundColor Cyan
    Write-Host "      $url`n" -ForegroundColor White
  }
}

# 7. Mitarbeiter
$n = & $node "$Ziel\server.js" user list
Write-Host "`nMitarbeiter:" -ForegroundColor Cyan
$n | ForEach-Object { Write-Host $_ }
Write-Host "`nMitarbeiter anlegen/aendern: Doppelklick auf '$Ziel\Mitarbeiter verwalten.bat'" -ForegroundColor Cyan
Read-Host "`nFertig. Enter zum Schliessen"
