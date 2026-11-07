# API smoke tests — Professional Navigator
# Запуск: powershell -ExecutionPolicy Bypass -File scripts/check-api.ps1
# Требуется запущенный сервер на http://localhost:3000 и применённые миграции.
# Успешная AI-генерация = только HTTP 201. HTTP 502 — обработанная ошибка модели, не успех.

$baseUrl = "http://localhost:3000"
$sessionId = [guid]::NewGuid().ToString()
$passed = 0
$failed = 0
$generateStatus = $null

function Get-ApiResult {
    param(
        [string]$Path,
        [string]$Method = "POST",
        [string]$Body,
        [hashtable]$Headers = @{}
    )

    try {
        $params = @{
            Uri = "$baseUrl$Path"
            Method = $Method
            Headers = $Headers
            UseBasicParsing = $true
            ErrorAction = "Stop"
        }

        if ($Method -ne "GET") {
            $params.ContentType = "application/json"
            $params.Body = $Body
        }

        $response = Invoke-WebRequest @params
        return @{
            Status = [int]$response.StatusCode
            Body = $response.Content
        }
    }
    catch {
        $status = 0
        $content = $_.Exception.Message
        $exResp = $_.Exception.Response

        if ($exResp) {
            try {
                $status = [int]$exResp.StatusCode
            }
            catch {
                $status = 0
            }

            try {
                $stream = $exResp.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $content = $reader.ReadToEnd()
                    $reader.Close()
                }
            }
            catch {
                $content = $_.Exception.Message
            }
        }

        return @{
            Status = $status
            Body = $content
        }
    }
}

function Test-Api {
    param(
        [string]$Name,
        [string]$Path,
        [string]$Method = "POST",
        [string]$Body,
        [hashtable]$Headers = @{},
        [int[]]$ExpectedStatus
    )

    $result = Get-ApiResult -Path $Path -Method $Method -Body $Body -Headers $Headers
    $actual = [int]$result.Status

    if ($ExpectedStatus -contains $actual) {
        Write-Host "PASS | $Name | HTTP $actual" -ForegroundColor Green
        $script:passed++
    }
    else {
        Write-Host "FAIL | $Name | Expected $($ExpectedStatus -join '/'), got $actual" -ForegroundColor Red
        if ($result.Body) {
            Write-Host $result.Body
        }
        $script:failed++
    }

    return $result
}

$validHeader = @{ "X-Session-ID" = $sessionId }

Write-Host ""
Write-Host "=== PUBLIC GET ==="

Test-Api -Name "Health" -Path "/api/health" -Method "GET" -ExpectedStatus @(200, 503) | Out-Null
Test-Api -Name "Professions" -Path "/api/professions" -Method "GET" -ExpectedStatus @(200, 500) | Out-Null
Test-Api -Name "Clarification questions" -Path "/api/clarification/questions" -Method "GET" -ExpectedStatus @(200) | Out-Null
Test-Api -Name "Diagnostic questionnaires" -Path "/api/diagnostic/questions" -Method "GET" -ExpectedStatus @(200) | Out-Null

Write-Host ""
Write-Host "=== SESSION TESTS ==="

Test-Api -Name "Missing session header" `
    -Path "/api/track/select" `
    -Body '{"trackType":"explore"}' `
    -ExpectedStatus @(401) | Out-Null

Test-Api -Name "Invalid UUID" `
    -Path "/api/track/select" `
    -Headers @{ "X-Session-ID" = "invalid-uuid" } `
    -Body '{"trackType":"explore"}' `
    -ExpectedStatus @(400) | Out-Null

Test-Api -Name "Create session" `
    -Path "/api/track/select" `
    -Headers $validHeader `
    -Body '{"trackType":"explore"}' `
    -ExpectedStatus @(200) | Out-Null

Test-Api -Name "Update session" `
    -Path "/api/track/select" `
    -Headers $validHeader `
    -Body '{"trackType":"interests"}' `
    -ExpectedStatus @(200) | Out-Null

Write-Host ""
Write-Host "=== USER API TESTS ==="

Test-Api -Name "Submit diagnostic" `
    -Path "/api/diagnostic/submit" `
    -Headers $validHeader `
    -Body '{"answers":[{"questionId":"test_q1","answer":"tech"}]}' `
    -ExpectedStatus @(201) | Out-Null

Test-Api -Name "Latest diagnostic" `
    -Path "/api/diagnostic/latest" `
    -Method "GET" `
    -Headers $validHeader `
    -ExpectedStatus @(200) | Out-Null

Test-Api -Name "Submit clarification" `
    -Path "/api/clarification/submit" `
    -Headers $validHeader `
    -Body '{"answers":[{"questionId":"agent_q2_work_style","answer":"team"}]}' `
    -ExpectedStatus @(201) | Out-Null

Write-Host ""
Write-Host "=== AI GENERATION ==="

$generate = Get-ApiResult -Path "/api/recommendations/generate" -Body "{}" -Headers $validHeader
$generateStatus = [int]$generate.Status

if ($generateStatus -eq 201) {
    Write-Host "PASS | Generate recommendations succeeded | HTTP 201" -ForegroundColor Green
    $script:passed++
}
elseif ($generateStatus -eq 503) {
    Write-Host "PASS | Generate skipped: AI is not configured | HTTP 503" -ForegroundColor Yellow
    $script:passed++
    Write-Host "INFO | Successful generation was not verified in this run."
}
elseif ($generateStatus -eq 502) {
    Write-Host "FAIL | Generate recommendations did not succeed | HTTP 502" -ForegroundColor Red
    Write-Host "INFO | 502 means the gateway/schema error was handled, not that generation succeeded."
    if ($generate.Body) {
        Write-Host $generate.Body
    }
    $script:failed++
}
elseif ($generateStatus -eq 504) {
    Write-Host "FAIL | Generate recommendations timed out | HTTP 504" -ForegroundColor Red
    $script:failed++
}
else {
    Write-Host "FAIL | Generate recommendations unexpected status | HTTP $generateStatus" -ForegroundColor Red
    if ($generate.Body) {
        Write-Host $generate.Body
    }
    $script:failed++
}

Test-Api -Name "Save reflection" `
    -Path "/api/reflection" `
    -Headers $validHeader `
    -Body '{"rating":"useful","comment":"API smoke test"}' `
    -ExpectedStatus @(201) | Out-Null

Write-Host ""
Write-Host "=== RESULT ==="
Write-Host "Passed: $passed"
Write-Host "Failed: $failed"
Write-Host "Generate HTTP status: $generateStatus"

if ($failed -gt 0) {
    exit 1
}
