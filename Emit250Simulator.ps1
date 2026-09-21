[CmdletBinding()]
param(
    [string]$KilpDat,
    [string]$ClassesXml,
    [string]$CoursesXml,
    [string]$EmitDat
)

$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot }
    elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath }
    else { Get-Location }

if (-not $KilpDat) { $KilpDat = Join-Path $ScriptRoot "KILP.DAT" }
if (-not $ClassesXml) { $ClassesXml = Join-Path $ScriptRoot "KilpSrj.xml" }
if (-not $CoursesXml) { $CoursesXml = Join-Path $ScriptRoot "radat1.xml" }
if (-not $EmitDat) { $EmitDat = Join-Path $ScriptRoot "EMIT.DAT" }

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-FixedUnicodeString {
    param([byte[]]$Bytes, [int]$Offset, [int]$CharacterCount)

    $value = [System.Text.Encoding]::Unicode.GetString($Bytes, $Offset, $CharacterCount * 2)
    $nul = $value.IndexOf([char]0)
    if ($nul -ge 0) { $value = $value.Substring(0, $nul) }
    return $value.Trim()
}

function Read-ClassFile {
    param([string]$Path)

    [xml]$xml = Get-Content -LiteralPath $Path -Raw
    $classes = @{}
    foreach ($node in $xml.Event.Classes.Class) {
        # KILP.DAT uses a zero-based class index; ClassNo is one-based.
        $classes[[int]$node.ClassNo - 1] = [string]$node.ClassId
    }
    return $classes
}

function Read-CourseFile {
    param([string]$Path)

    [xml]$xml = Get-Content -LiteralPath $Path -Raw
    $courses = @{}
    $assignments = @{}
    $punchMap = @{}

    foreach ($control in $xml.SelectNodes("//*[local-name()='Control']")) {
        $controlCodeNode = $control.SelectSingleNode("*[local-name()='ControlCode']")
        $unitCodeNode = $control.SelectSingleNode("*[local-name()='PunchingUnit']/*[local-name()='UnitCode']")
        if ($null -eq $controlCodeNode) { continue }

        $controlCode = $controlCodeNode.InnerText.Trim()
        if ([string]::IsNullOrWhiteSpace($controlCode) -or $controlCode -notmatch '^\d+$') { continue }

        if ($null -ne $unitCodeNode) {
            $unitCode = $unitCodeNode.InnerText.Trim()
            if ($unitCode -match '^\d+$') {
                $punchMap[$controlCode] = [int]$unitCode
            }
        }
    }

    foreach ($course in $xml.SelectNodes("//*[local-name()='Course']")) {
        $courseNameNode = $course.SelectSingleNode("*[local-name()='CourseName']")
        if ($null -eq $courseNameNode) { continue }

        $courseName = $courseNameNode.InnerText.Trim()
        if ([string]::IsNullOrWhiteSpace($courseName)) { continue }

        $controls = New-Object System.Collections.Generic.List[int]
        foreach ($courseControl in $course.SelectNodes(".//*[local-name()='CourseControl']")) {
            $controlCodeNode = $courseControl.SelectSingleNode("*[local-name()='ControlCode']")
            if ($null -eq $controlCodeNode) { continue }

            $rawValue = $controlCodeNode.InnerText.Trim()
            if ($rawValue -notmatch '^\d+$') { continue }

            $controlValue = [int]$rawValue
            if ($punchMap.ContainsKey($rawValue)) {
                $controlValue = [int]$punchMap[$rawValue]
            }

            [void]$controls.Add($controlValue)
        }
        $courses[$courseName] = $controls.ToArray()

        # These exports can identify the class inside the course instead.
        foreach ($classNode in $course.SelectNodes("*[local-name()='ClassShortName']")) {
            $className = $classNode.InnerText.Trim()
            if (-not [string]::IsNullOrWhiteSpace($className)) {
                $assignments[$className] = $courseName
            }
        }
    }

    # Assignments are optional; explicit mappings take precedence when present.
    foreach ($assignment in $xml.SelectNodes("//*[local-name()='ClassCourseAssignment']")) {
        $classNode = $assignment.SelectSingleNode("*[local-name()='ClassName']")
        $courseNode = $assignment.SelectSingleNode("*[local-name()='CourseName']")
        if ($null -eq $classNode -or $null -eq $courseNode) { continue }

        $className = $classNode.InnerText.Trim()
        $assignedCourse = $courseNode.InnerText.Trim()
        if (-not [string]::IsNullOrWhiteSpace($className) -and -not [string]::IsNullOrWhiteSpace($assignedCourse)) {
            $assignments[$className] = $assignedCourse
        }
    }

    return [pscustomobject]@{
        Courses = $courses
        Assignments = $assignments
    }
}

function Read-KilpDat {
    param(
        [string]$Path,
        [hashtable]$Classes,
        [hashtable]$Courses,
        [hashtable]$Assignments,
        [ValidateSet(1, 2)][int]$Race = 1
    )

    # A record is a 360-byte shared header followed by one 248-byte race
    # phase block per race stage the event has: 608 bytes for a single-race
    # event, 856 bytes when the event has two races (Race 1 and Race 2).
    $headerSize = 360
    $phaseSize = 248
    $bytes = [System.IO.File]::ReadAllBytes($Path)

    $stageCount = $null
    foreach ($candidate in 1, 2) {
        $candidateRecordSize = $headerSize + $phaseSize * $candidate
        if ($bytes.Length -ge ($candidateRecordSize * 2) -and ($bytes.Length % $candidateRecordSize) -eq 0) {
            $stageCount = $candidate
            break
        }
    }
    if ($null -eq $stageCount) {
        throw "Unsupported KILP.DAT size. Expected $($headerSize + $phaseSize)-byte (single race) or $($headerSize + $phaseSize * 2)-byte (two races) records, got $($bytes.Length) bytes."
    }
    if ($Race -gt $stageCount) {
        throw "This KILP.DAT file only contains data for race 1."
    }

    $recordSize = $headerSize + $phaseSize * $stageCount
    $phaseOffset = $headerSize + $phaseSize * ($Race - 1)
    $result = New-Object System.Collections.Generic.List[object]
    $recordCount = [int]($bytes.Length / $recordSize)

    for ($recordIndex = 1; $recordIndex -lt $recordCount; $recordIndex++) {
        $base = $recordIndex * $recordSize
        $status = [BitConverter]::ToInt16($bytes, $base)
        if ($status -ne 0) { continue }

        # Hashtable keys must use the same Int32 type as Read-ClassFile.
        $classIndex = [int][BitConverter]::ToInt16($bytes, $base + 348)
        $className = if ($Classes.ContainsKey($classIndex)) { [string]$Classes[$classIndex] } else { "#$classIndex" }

        $courseName = ""
        if ($Assignments.ContainsKey($className)) {
            $courseName = [string]$Assignments[$className]
        }
        elseif ($Courses.ContainsKey($className)) {
            $courseName = $className
        }

        $controls = @()
        if ($courseName -and $Courses.ContainsKey($courseName)) {
            $controls = @($Courses[$courseName])
        }

        $emitCard = [BitConverter]::ToInt32($bytes, $base + $phaseOffset + 68)
        if ($emitCard -le 0 -and $Race -eq 2) {
            # Some late registrations only contain the card in race 1.
            $emitCard = [BitConverter]::ToInt32($bytes, $base + $headerSize + 68)
        }

        [void]$result.Add([pscustomobject]@{
            RecordIndex = $recordIndex
            Number = [BitConverter]::ToUInt16($bytes, $base + 2)
            LastName = Get-FixedUnicodeString $bytes ($base + 48) 25
            FirstName = Get-FixedUnicodeString $bytes ($base + 98) 25
            Club = Get-FixedUnicodeString $bytes ($base + 180) 32
            ClubShort = Get-FixedUnicodeString $bytes ($base + 244) 16
            Country = Get-FixedUnicodeString $bytes ($base + 340) 4
            ClassIndex = $classIndex
            ClassName = $className
            CourseName = $courseName
            Controls = $controls
            EmitCard = $emitCard
        })
    }

    return $result.ToArray()
}

function Read-EmitDat {
    param([string]$Path)

    # Pirila's EMIT.DAT punch log: fixed 188-byte records. Offset 4 holds the
    # Emit card number (UInt32 LE); offset 0x48 holds up to 48 UInt16 LE
    # elapsed split times in seconds, zero-padded after the last real punch.
    $recordSize = 188
    $punchOffset = 0x48
    $maxPunches = 48

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0 -or ($bytes.Length % $recordSize) -ne 0) {
        throw "Unsupported EMIT.DAT size. Expected 188-byte records, got $($bytes.Length) bytes."
    }

    $result = New-Object System.Collections.Generic.List[object]
    $recordCount = [int]($bytes.Length / $recordSize)

    for ($recordIndex = 0; $recordIndex -lt $recordCount; $recordIndex++) {
        $base = $recordIndex * $recordSize
        $emitCard = [BitConverter]::ToUInt32($bytes, $base + 4)
        if ($emitCard -le 0) { continue }

        $times = New-Object System.Collections.Generic.List[int]
        for ($p = 0; $p -lt $maxPunches; $p++) {
            $seconds = [BitConverter]::ToUInt16($bytes, $base + $punchOffset + ($p * 2))
            if ($seconds -eq 0) { break }
            [void]$times.Add($seconds)
        }
        if ($times.Count -eq 0) { continue }

        [void]$result.Add([pscustomobject]@{
            EmitCard = [int]$emitCard
            PunchSeconds = $times.ToArray()
        })
    }

    return $result.ToArray()
}

function Set-UInt16LE {
    param([byte[]]$Buffer, [int]$Offset, [int]$Value)
    $Buffer[$Offset] = [byte]($Value -band 0xFF)
    $Buffer[$Offset + 1] = [byte](($Value -shr 8) -band 0xFF)
}

function Set-AsciiField {
    param([byte[]]$Buffer, [int]$Offset, [int]$Length, [string]$Value)
    $encoded = [System.Text.Encoding]::ASCII.GetBytes($Value.PadRight($Length).Substring(0, $Length))
    [Array]::Copy($encoded, 0, $Buffer, $Offset, $Length)
}

function Set-ZeroSumByte {
    param([byte[]]$Buffer, [int]$Start, [int]$ChecksumOffset)
    $sum = 0
    for ($i = $Start; $i -lt $ChecksumOffset; $i++) {
        $sum = ($sum + [int]$Buffer[$i]) -band 0xFF
    }
    $Buffer[$ChecksumOffset] = [byte]((- $sum) -band 0xFF)
}

function New-Emit250Packet {
    param(
        [int]$EmitCard,
        [int[]]$Controls,
        [int]$FinishMinutes = 60,
        [int[]]$Times
    )

    if ($EmitCard -le 0 -or $EmitCard -gt 999999) {
        throw "Emit card number must be between 1 and 999999."
    }

    $routeControls = @($Controls | Where-Object { $_ -ge 1 -and $_ -le 250 })
    if ($routeControls.Count -eq 0) {
        throw "The selected competitor has no course controls."
    }
    if ($routeControls.Count -gt 49) {
        throw "Course has more than 49 controls; one slot is reserved for reader code 250."
    }

    # Replay mode: reuse the real recorded split times instead of computing
    # evenly spaced synthetic ones.
    $useRealTimes = ($null -ne $Times) -and ($Times.Count -eq $routeControls.Count)

    $decoded = New-Object byte[] 217
    $decoded[0] = 0xFF
    $decoded[1] = 0xFF
    $decoded[2] = [byte]($EmitCard -band 0xFF)
    $decoded[3] = [byte](($EmitCard -shr 8) -band 0xFF)
    $decoded[4] = [byte](($EmitCard -shr 16) -band 0xFF)
    $decoded[5] = 0
    $decoded[6] = 1
    $decoded[7] = [byte]([DateTime]::Now.Year % 100)
    $decoded[8] = 0
    Set-ZeroSumByte $decoded 2 9

    $finishSeconds = if ($useRealTimes) { $Times[$Times.Count - 1] } else { [Math]::Max(60, $FinishMinutes * 60) }
    for ($i = 0; $i -lt $routeControls.Count; $i++) {
        $offset = 10 + ($i * 3)
        $decoded[$offset] = [byte]$routeControls[$i]
        $seconds = if ($useRealTimes) { $Times[$i] } else { [int][Math]::Round($finishSeconds * ($i + 1) / $routeControls.Count) }
        $seconds = [Math]::Min(65534, [Math]::Max(1, $seconds))
        Set-UInt16LE $decoded ($offset + 1) $seconds
    }

    $readerIndex = $routeControls.Count
    $readerOffset = 10 + ($readerIndex * 3)
    $decoded[$readerOffset] = 250
    Set-UInt16LE $decoded ($readerOffset + 1) ([Math]::Min(65534, $finishSeconds + 5))

    for ($i = 160; $i -le 215; $i++) { $decoded[$i] = 0x20 }
    Set-AsciiField $decoded 160 40 "Emit 250 simulator"
    $decoded[200] = [byte][char]'S'
    Set-AsciiField $decoded 201 4 "0000"
    $decoded[205] = [byte][char]'P'
    Set-AsciiField $decoded 206 4 "0000"
    $decoded[210] = [byte][char]'L'
    Set-AsciiField $decoded 211 4 "0001"
    $decoded[215] = 0
    Set-ZeroSumByte $decoded 0 216

    $encoded = New-Object byte[] 217
    for ($i = 0; $i -lt $decoded.Length; $i++) {
        $encoded[$i] = [byte]($decoded[$i] -bxor 0xDF)
    }
    return $encoded
}

function Test-Emit250Packet {
    param([byte[]]$Encoded)

    if ($Encoded.Length -ne 217) { throw "Packet length is not 217 bytes." }
    $decoded = New-Object byte[] $Encoded.Length
    for ($i = 0; $i -lt $Encoded.Length; $i++) {
        $decoded[$i] = [byte]($Encoded[$i] -bxor 0xDF)
    }
    if ($decoded[0] -ne 0xFF -or $decoded[1] -ne 0xFF) { throw "Invalid packet header." }

    $cardSum = 0
    for ($i = 2; $i -le 9; $i++) { $cardSum = ($cardSum + $decoded[$i]) -band 0xFF }
    if ($cardSum -ne 0) { throw "Invalid card-number checksum." }

    $packetSum = 0
    foreach ($value in $decoded) { $packetSum = ($packetSum + $value) -band 0xFF }
    if ($packetSum -ne 0) { throw "Invalid packet checksum." }
}

function Send-Emit250Packet {
    param([string]$PortName, [byte[]]$Packet, [bool]$Twice)

    $port = New-Object System.IO.Ports.SerialPort(
        $PortName,
        9600,
        [System.IO.Ports.Parity]::None,
        8,
        [System.IO.Ports.StopBits]::Two
    )
    $port.Handshake = [System.IO.Ports.Handshake]::None
    $port.WriteTimeout = 3000
    try {
        $port.Open()
        Start-Sleep -Milliseconds 150
        $port.Write($Packet, 0, $Packet.Length)
        if ($Twice) {
            Start-Sleep -Milliseconds 100
            $port.Write($Packet, 0, $Packet.Length)
        }
        $port.BaseStream.Flush()
    }
    finally {
        if ($port.IsOpen) { $port.Close() }
        $port.Dispose()
    }
}

function Wait-ReplayDelay {
    param([double]$Seconds)
    if ($Seconds -le 0) { return }
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($script:ReplayRunning -and (Get-Date) -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 50
    }
}

$script:Classes = @{}
$script:CourseData = $null
$script:AllCompetitors = @()
$script:VisibleCompetitors = @()
$script:ReplayEntries = @()
$script:ReplayRunning = $false

$form = New-Object System.Windows.Forms.Form
$form.Text = "Emit 250 Reader Simulator"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(1060, 900)
$form.MinimumSize = New-Object System.Drawing.Size(900, 780)
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$filesGroup = New-Object System.Windows.Forms.GroupBox
$filesGroup.Text = "Competition files"
$filesGroup.SetBounds(12, 10, 1018, 146)
$filesGroup.Anchor = 'Top,Left,Right'
$form.Controls.Add($filesGroup)

function Add-PathRow {
    param([string]$Label, [string]$Value, [int]$Y)
    $caption = New-Object System.Windows.Forms.Label
    $caption.Text = $Label
    $caption.SetBounds(12, $Y + 3, 92, 22)
    $filesGroup.Controls.Add($caption)

    $box = New-Object System.Windows.Forms.TextBox
    $box.Text = $Value
    $box.SetBounds(108, $Y, 810, 24)
    $box.Anchor = 'Top,Left,Right'
    $filesGroup.Controls.Add($box)

    $button = New-Object System.Windows.Forms.Button
    $button.Text = "Browse..."
    $button.SetBounds(926, $Y - 1, 78, 26)
    $button.Anchor = 'Top,Right'
    $filesGroup.Controls.Add($button)
    $button.Add_Click({
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.FileName = $box.Text
        $dialog.Filter = "All files (*.*)|*.*"
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $box.Text = $dialog.FileName }
    }.GetNewClosure())
    return $box
}

$kilpBox = Add-PathRow "KILP.DAT" $KilpDat 22
$classesBox = Add-PathRow "KilpSrj.xml" $ClassesXml 50
$coursesBox = Add-PathRow "radat1.xml" $CoursesXml 78
$emitDatBox = Add-PathRow "EMIT.DAT" $EmitDat 106

$loadButton = New-Object System.Windows.Forms.Button
$loadButton.Text = "Load files"
$loadButton.SetBounds(12, 164, 100, 30)
$form.Controls.Add($loadButton)

$raceLabel = New-Object System.Windows.Forms.Label
$raceLabel.Text = "Race:"
$raceLabel.SetBounds(128, 171, 42, 22)
$form.Controls.Add($raceLabel)

$raceCombo = New-Object System.Windows.Forms.ComboBox
$raceCombo.DropDownStyle = 'DropDownList'
$raceCombo.Items.AddRange(@("1", "2"))
$raceCombo.SelectedIndex = 0
$raceCombo.SetBounds(170, 167, 54, 26)
$form.Controls.Add($raceCombo)

$searchLabel = New-Object System.Windows.Forms.Label
$searchLabel.Text = "Search:"
$searchLabel.SetBounds(244, 171, 52, 22)
$form.Controls.Add($searchLabel)

$searchBox = New-Object System.Windows.Forms.TextBox
$searchBox.SetBounds(298, 167, 318, 26)
$searchBox.Anchor = 'Top,Left,Right'
$form.Controls.Add($searchBox)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Load competition files."
$statusLabel.SetBounds(630, 171, 400, 22)
$statusLabel.Anchor = 'Top,Right'
$statusLabel.TextAlign = 'MiddleRight'
$form.Controls.Add($statusLabel)

$grid = New-Object System.Windows.Forms.DataGridView
$grid.SetBounds(12, 204, 1018, 390)
$grid.Anchor = 'Top,Bottom,Left,Right'
$grid.ReadOnly = $true
$grid.AllowUserToAddRows = $false
$grid.AllowUserToDeleteRows = $false
$grid.MultiSelect = $false
$grid.SelectionMode = 'FullRowSelect'
$grid.AutoGenerateColumns = $false
$grid.AutoSizeColumnsMode = 'Fill'
$grid.RowHeadersVisible = $false
$form.Controls.Add($grid)

foreach ($columnInfo in @(
    @("Number", "No", 55),
    @("LastName", "Last name", 130),
    @("FirstName", "First name", 110),
    @("ClassName", "Class", 65),
    @("CourseName", "Course", 130),
    @("EmitCard", "Emit", 80),
    @("Club", "Club", 180)
)) {
    $column = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
    $column.Name = $columnInfo[0]
    $column.HeaderText = $columnInfo[1]
    $column.FillWeight = $columnInfo[2]
    [void]$grid.Columns.Add($column)
}

$replayGroup = New-Object System.Windows.Forms.GroupBox
$replayGroup.Text = "Race replay (EMIT.DAT)"
$replayGroup.SetBounds(12, 606, 1018, 132)
$replayGroup.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($replayGroup)

$loadEmitButton = New-Object System.Windows.Forms.Button
$loadEmitButton.Text = "Load EMIT.DAT"
$loadEmitButton.SetBounds(12, 24, 140, 28)
$replayGroup.Controls.Add($loadEmitButton)

$replayStatusLabel = New-Object System.Windows.Forms.Label
$replayStatusLabel.Text = "Load competition files and EMIT.DAT to replay a past race."
$replayStatusLabel.SetBounds(160, 28, 846, 22)
$replayStatusLabel.Anchor = 'Top,Left,Right'
$replayGroup.Controls.Add($replayStatusLabel)

$replayMinutesLabel = New-Object System.Windows.Forms.Label
$replayMinutesLabel.Text = "Replay duration (min):"
$replayMinutesLabel.SetBounds(12, 64, 140, 22)
$replayGroup.Controls.Add($replayMinutesLabel)

$replayMinutesInput = New-Object System.Windows.Forms.NumericUpDown
$replayMinutesInput.Minimum = 1
$replayMinutesInput.Maximum = 1000
$replayMinutesInput.Value = 5
$replayMinutesInput.SetBounds(158, 60, 70, 26)
$replayGroup.Controls.Add($replayMinutesInput)

$startReplayButton = New-Object System.Windows.Forms.Button
$startReplayButton.Text = "Start replay"
$startReplayButton.Enabled = $false
$startReplayButton.SetBounds(242, 58, 120, 30)
$replayGroup.Controls.Add($startReplayButton)

$stopReplayButton = New-Object System.Windows.Forms.Button
$stopReplayButton.Text = "Stop replay"
$stopReplayButton.Enabled = $false
$stopReplayButton.SetBounds(368, 58, 110, 30)
$replayGroup.Controls.Add($stopReplayButton)

$sendPanel = New-Object System.Windows.Forms.Panel
$sendPanel.SetBounds(12, 750, 1018, 88)
$sendPanel.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($sendPanel)

$portLabel = New-Object System.Windows.Forms.Label
$portLabel.Text = "COM port:"
$portLabel.SetBounds(0, 8, 66, 22)
$sendPanel.Controls.Add($portLabel)

$portCombo = New-Object System.Windows.Forms.ComboBox
$portCombo.DropDownStyle = 'DropDownList'
$portCombo.SetBounds(70, 4, 96, 26)
$sendPanel.Controls.Add($portCombo)

$refreshPortsButton = New-Object System.Windows.Forms.Button
$refreshPortsButton.Text = "Refresh"
$refreshPortsButton.SetBounds(174, 3, 74, 28)
$sendPanel.Controls.Add($refreshPortsButton)

$minutesLabel = New-Object System.Windows.Forms.Label
$minutesLabel.Text = "Finish time (min):"
$minutesLabel.SetBounds(270, 8, 105, 22)
$sendPanel.Controls.Add($minutesLabel)

$minutesInput = New-Object System.Windows.Forms.NumericUpDown
$minutesInput.Minimum = 1
$minutesInput.Maximum = 1000
$minutesInput.Value = 60
$minutesInput.SetBounds(378, 4, 70, 26)
$sendPanel.Controls.Add($minutesInput)

$twiceCheck = New-Object System.Windows.Forms.CheckBox
$twiceCheck.Text = "Send packet twice"
$twiceCheck.Checked = $true
$twiceCheck.SetBounds(470, 6, 145, 24)
$sendPanel.Controls.Add($twiceCheck)

$sendButton = New-Object System.Windows.Forms.Button
$sendButton.Text = "Simulate card read"
$sendButton.SetBounds(0, 43, 160, 34)
$sendPanel.Controls.Add($sendButton)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = "Save packet..."
$saveButton.SetBounds(170, 43, 120, 34)
$sendPanel.Controls.Add($saveButton)

$detailsLabel = New-Object System.Windows.Forms.Label
$detailsLabel.Text = ""
$detailsLabel.SetBounds(310, 42, 698, 38)
$detailsLabel.Anchor = 'Bottom,Left,Right'
$sendPanel.Controls.Add($detailsLabel)

function Refresh-Ports {
    $selected = [string]$portCombo.SelectedItem
    $portCombo.Items.Clear()
    $ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object)
    if ($ports.Count -gt 0) { $portCombo.Items.AddRange($ports) }
    if ($selected -and $portCombo.Items.Contains($selected)) {
        $portCombo.SelectedItem = $selected
    }
    elseif ($portCombo.Items.Count -gt 0) {
        $portCombo.SelectedIndex = 0
    }
}

function Refresh-Grid {
    $filter = $searchBox.Text.Trim().ToLowerInvariant()
    if ($filter) {
        $script:VisibleCompetitors = @($script:AllCompetitors | Where-Object {
            ("$($_.Number) $($_.FirstName) $($_.LastName) $($_.ClassName) $($_.CourseName) $($_.EmitCard) $($_.Club)").ToLowerInvariant().Contains($filter)
        })
    }
    else {
        $script:VisibleCompetitors = @($script:AllCompetitors)
    }
    # WinForms binding cannot discover PSCustomObject properties; fill cells directly.
    $grid.Rows.Clear()
    foreach ($competitor in $script:VisibleCompetitors) {
        $row = New-Object System.Windows.Forms.DataGridViewRow
        $row.CreateCells($grid, [object[]]@(
            $competitor.Number,
            $competitor.LastName,
            $competitor.FirstName,
            $competitor.ClassName,
            $competitor.CourseName,
            $competitor.EmitCard,
            $competitor.Club
        ))
        # Keep the competitor attached to its row when the user sorts the table.
        $row.Tag = $competitor
        [void]$grid.Rows.Add($row)
    }
    $statusLabel.Text = "$($script:VisibleCompetitors.Count) / $($script:AllCompetitors.Count) competitors"
}

function Get-SelectedCompetitor {
    if ($grid.SelectedRows.Count -eq 0) { throw "Select a competitor first." }
    $competitor = $grid.SelectedRows[0].Tag
    if ($null -eq $competitor) { throw "Invalid selection." }
    return $competitor
}

function Show-Error {
    param([Exception]$Exception)
    [System.Windows.Forms.MessageBox]::Show($form, $Exception.Message, "Emit 250 Simulator", 'OK', 'Error') | Out-Null
}

$loadButton.Add_Click({
    try {
        $script:Classes = Read-ClassFile $classesBox.Text
        $script:CourseData = Read-CourseFile $coursesBox.Text
        $script:AllCompetitors = @(Read-KilpDat $kilpBox.Text $script:Classes $script:CourseData.Courses $script:CourseData.Assignments ([int]$raceCombo.SelectedItem))
        Refresh-Grid

        # The competitor list changed, so any previously matched replay data is stale.
        $script:ReplayEntries = @()
        $startReplayButton.Enabled = $false
        $replayStatusLabel.Text = "Load EMIT.DAT to replay this race."
    }
    catch { Show-Error $_.Exception }
})

$raceCombo.Add_SelectedIndexChanged({
    if ($script:Classes.Count -gt 0) { $loadButton.PerformClick() }
})
$searchBox.Add_TextChanged({ Refresh-Grid })
$refreshPortsButton.Add_Click({ Refresh-Ports })

$grid.Add_SelectionChanged({
    if ($grid.SelectedRows.Count -gt 0 -and $null -ne $grid.SelectedRows[0].Tag) {
        $c = $grid.SelectedRows[0].Tag
        $detailsLabel.Text = "$($c.FirstName) $($c.LastName) | $($c.ClassName) | $($c.Controls.Count) course controls | Emit $($c.EmitCard)"
    }
    else {
        $detailsLabel.Text = ""
    }
})

$sendButton.Add_Click({
    try {
        $competitor = Get-SelectedCompetitor
        if (-not $portCombo.SelectedItem) { throw "Select a COM port." }
        $packet = New-Emit250Packet $competitor.EmitCard $competitor.Controls ([int]$minutesInput.Value)
        Test-Emit250Packet $packet
        Send-Emit250Packet ([string]$portCombo.SelectedItem) $packet $twiceCheck.Checked
        $statusLabel.Text = "Sent 217-byte packet for Emit $($competitor.EmitCard) to $($portCombo.SelectedItem)."
    }
    catch { Show-Error $_.Exception }
})

$saveButton.Add_Click({
    try {
        $competitor = Get-SelectedCompetitor
        $packet = New-Emit250Packet $competitor.EmitCard $competitor.Controls ([int]$minutesInput.Value)
        Test-Emit250Packet $packet
        $dialog = New-Object System.Windows.Forms.SaveFileDialog
        $dialog.Filter = "Binary packet (*.bin)|*.bin|All files (*.*)|*.*"
        $dialog.FileName = "emit250-$($competitor.EmitCard).bin"
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            [System.IO.File]::WriteAllBytes($dialog.FileName, $packet)
            $statusLabel.Text = "Saved $($packet.Length)-byte packet to $($dialog.FileName)."
        }
    }
    catch { Show-Error $_.Exception }
})

$loadEmitButton.Add_Click({
    try {
        if ($script:AllCompetitors.Count -eq 0) { throw "Load competition files first." }

        $entries = Read-EmitDat $emitDatBox.Text
        $replay = New-Object System.Collections.Generic.List[object]
        $competitorsByCard = @{}
        foreach ($competitor in $script:AllCompetitors) {
            if ($competitor.EmitCard -gt 0 -and -not $competitorsByCard.ContainsKey($competitor.EmitCard)) {
                $competitorsByCard[$competitor.EmitCard] = $competitor
            }
        }

        foreach ($entry in $entries) {
            $competitor = $competitorsByCard[$entry.EmitCard]
            if ($null -eq $competitor -or $competitor.Controls.Count -eq 0) { continue }

            # Only replay as many controls as we have both a course code and a real punch time for.
            $count = [Math]::Min($competitor.Controls.Count, $entry.PunchSeconds.Count)
            if ($count -eq 0) { continue }

            [void]$replay.Add([pscustomobject]@{
                Competitor = $competitor
                Controls = @($competitor.Controls | Select-Object -First $count)
                Times = @($entry.PunchSeconds | Select-Object -First $count)
                FinishSeconds = $entry.PunchSeconds[$count - 1]
            })
        }

        $script:ReplayEntries = @($replay | Sort-Object FinishSeconds)
        $matched = $script:ReplayEntries.Count
        $replayStatusLabel.Text = "$matched / $($entries.Count) EMIT.DAT punches matched to loaded competitors."
        $startReplayButton.Enabled = ($matched -gt 0)
    }
    catch {
        $script:ReplayEntries = @()
        $startReplayButton.Enabled = $false
        Show-Error $_.Exception
    }
})

$startReplayButton.Add_Click({
    $previousSendEnabled = $sendButton.Enabled
    try {
        if ($script:ReplayEntries.Count -eq 0) { throw "Load EMIT.DAT first." }
        if (-not $portCombo.SelectedItem) { throw "Select a COM port." }

        $totalSeconds = [double]$replayMinutesInput.Value * 60
        $span = [double]($script:ReplayEntries[$script:ReplayEntries.Count - 1].FinishSeconds - $script:ReplayEntries[0].FinishSeconds)
        $scale = if ($span -gt 0) { $totalSeconds / $span } else { 0 }

        $script:ReplayRunning = $true
        $startReplayButton.Enabled = $false
        $stopReplayButton.Enabled = $true
        $loadButton.Enabled = $false
        $loadEmitButton.Enabled = $false
        $sendButton.Enabled = $false

        $previousFinish = $null
        $sent = 0
        foreach ($item in $script:ReplayEntries) {
            if (-not $script:ReplayRunning) { break }
            if ($null -ne $previousFinish) {
                Wait-ReplayDelay (($item.FinishSeconds - $previousFinish) * $scale)
            }
            if (-not $script:ReplayRunning) { break }
            $previousFinish = $item.FinishSeconds

            $packet = New-Emit250Packet $item.Competitor.EmitCard $item.Controls 0 $item.Times
            Test-Emit250Packet $packet
            Send-Emit250Packet ([string]$portCombo.SelectedItem) $packet $twiceCheck.Checked
            $sent++
            $replayStatusLabel.Text = "Replay: $sent / $($script:ReplayEntries.Count) sent."
        }

        if ($sent -eq $script:ReplayEntries.Count) {
            $replayStatusLabel.Text = "Replay complete: $sent / $($script:ReplayEntries.Count) sent."
        }
        else {
            $replayStatusLabel.Text = "Replay stopped: $sent / $($script:ReplayEntries.Count) sent."
        }
    }
    catch { Show-Error $_.Exception }
    finally {
        $script:ReplayRunning = $false
        $startReplayButton.Enabled = ($script:ReplayEntries.Count -gt 0)
        $stopReplayButton.Enabled = $false
        $loadButton.Enabled = $true
        $loadEmitButton.Enabled = $true
        $sendButton.Enabled = $previousSendEnabled
    }
})

$stopReplayButton.Add_Click({
    $script:ReplayRunning = $false
})

$form.Add_Shown({
    Refresh-Ports
    if ((Test-Path -LiteralPath $kilpBox.Text) -and (Test-Path -LiteralPath $classesBox.Text) -and (Test-Path -LiteralPath $coursesBox.Text)) {
        $loadButton.PerformClick()
    }
})

[void]$form.ShowDialog()
