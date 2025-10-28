$smart = ".\bin\smartctl.exe"
$scan = & $smart --scan -j | ConvertFrom-Json
if (-not $scan -or -not $scan.devices) { Write-Error "No drives found by smartctl."; return }

function Get-SmartJson {
  param(
    [string]$smartPath,
    [string]$deviceName
  )

  $argSets = @(
    @('-a','-j', $deviceName),
    @('-a','-j','-d','sat', $deviceName),
    @('-a','-j','-d','sat,12', $deviceName),
    @('-a','-j','-d','scsi', $deviceName)
  )

  foreach ($args in $argSets) {
    try {
      $out = & $smartPath @args
      $j = $out | ConvertFrom-Json
      if ($j -and ($j.model_name -or $j.serial_number -or $j.device.type)) { return $j }
    } catch { }
  }
  return $null
}

$result = foreach ($d in $scan.devices) {
  $name = $d.name
  try {
    $j = Get-SmartJson -smartPath $smart -deviceName $name
    if (-not $j) { Write-Warning ("No SMART JSON for {0}" -f $name); continue }

    $type   = $j.device.type
    $model  = $j.model_name
    $serial = $j.serial_number
    $hours  = $j.power_on_time.hours

    if ($type -eq "nvme") {
      $duw    = [double]$j.nvme_smart_health_information_log.data_units_written
      $gbW    = [math]::Round(($duw * 512000) / 1GB, 2)          # 1 data unit = 512,000 bytes
      $health = 100 - [int]$j.nvme_smart_health_information_log.percentage_used
    } else {
      $attrs = $j.ata_smart_attributes.table
      $lbasWritten = ($attrs | Where-Object { $_.id -in 241,242 -and $_.name -match 'Written' } | Select-Object -First 1)
      $lbas = if ($lbasWritten) { [double]$lbasWritten.raw.value } else { 0 }
      $gbW  = [math]::Round(($lbas * 512) / 1GB, 2)              # 512-byte LBAs

      $lifeAttr = $attrs | Where-Object { $_.id -in 231,202,177 -or $_.name -match 'Wear|Life|Percent' } | Select-Object -First 1
      $health = if ($lifeAttr) { [int]$lifeAttr.value } elseif ($j.smart_status.passed) { 100 } else { 0 }
    }

    if (-not $type -and -not $model -and -not $serial -and -not $j.smart_status) { continue }

    [pscustomobject]@{
      Device        = $name
      Type          = $type
      Model         = $model
      Serial        = $serial
      HealthPercent = $health
      PowerOnHours  = $hours
      WrittenGB     = $gbW
    }
  } catch {
    Write-Warning ("Failed to read SMART for {0}: {1}" -f $name, $_)
  }
}

$result | ConvertTo-Json -Depth 4