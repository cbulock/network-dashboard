$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$runtime = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path (Join-Path $workspace '.data') | Out-Null
$worker = Join-Path $PSScriptRoot 'dns-worker.js'
$logPath = Join-Path $workspace '.data/dns-worker.log'
$action = New-ScheduledTaskAction -Execute $runtime -Argument ('"' + $worker + '" --log-file "' + $logPath + '"') -WorkingDirectory $workspace
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Network Dashboard DNS Worker' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Imports DNS Platform records and processes durable dashboard DNS requests.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Network Dashboard DNS Worker'
Get-ScheduledTask -TaskName 'Network Dashboard DNS Worker' | Select-Object TaskName, State
