#requires -Version 5.1
<#
.SYNOPSIS
  手动发布 @dsh-agent-toolkit/token-usage 到 npm 官方 registry。
.DESCRIPTION
  门禁链：npm 登录检查 → 版本冲突检查 → test → typecheck → pack 内容核查 → 人工确认 → publish → npm view 验证。
  prepack 钩子会在 pack/publish 前自动重跑 bundle（Node 半 + 浏览器半）。
.EXAMPLE
  在仓库根目录执行：powershell -File scripts/publish-token-usage.ps1
  已在本地跑过测试可跳过：powershell -File scripts/publish-token-usage.ps1 -SkipTests
#>
[CmdletBinding()]
param(
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$Registry = 'https://registry.npmjs.org'   # 必须钉官方源（本机默认 registry 是 npmmirror 镜像）
$PkgName  = '@dsh-agent-toolkit/token-usage'
$PkgDir   = Join-Path $PSScriptRoot '..\packages\token-usage' | Resolve-Path

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

$pkg = Get-Content (Join-Path $PkgDir 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
Step "准备发布 $PkgName@$version"

# 1. npm 登录检查（granular token 或交互登录均可）
$user = npm whoami --registry $Registry 2>$null
if ($LASTEXITCODE -ne 0 -or -not $user) {
  throw "未登录官方 registry。请先执行: npm login --registry $Registry（或配置 granular access token 到 `$env:USERPROFILE\.npmrc）"
}
Write-Host "npm 用户: $user"

# 2. 版本冲突检查（npm 版本不可撤回）
npm view "$PkgName@$version" version --registry $Registry 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw "$PkgName@$version 已存在于 npm。请先 bump package.json 版本号再发布。" }
Write-Host "版本 $version 尚未发布，可发布"

# 3. 测试与类型检查
if (-not $SkipTests) {
  Step '测试与类型检查'
  pnpm --filter $PkgName test
  if ($LASTEXITCODE -ne 0) { throw '测试失败，中止发布' }
  pnpm --filter $PkgName typecheck
  if ($LASTEXITCODE -ne 0) { throw '类型检查失败，中止发布' }
}

# 4. pack 内容核查（prepack 自动重跑 bundle）
Step 'pack 内容核查'
Push-Location $PkgDir
try {
  pnpm pack
  if ($LASTEXITCODE -ne 0) { throw 'pnpm pack 失败' }
  $tgz = "dsh-agent-toolkit-token-usage-$version.tgz"
  $entries = tar -tf $tgz
  $required = @(
    'package/package.json', 'package/README.md', 'package/LICENSE',
    'package/cordis.patch.yml', 'package/lib/index.js',
    'package/lib/index.d.ts', 'package/lib/client.js'
  )
  foreach ($r in $required) {
    if ($entries -notcontains $r) { throw "tarball 缺少必需文件: $r" }
  }
  $forbidden = $entries | Where-Object {
    $_ -match '^package/(src|tests|node_modules)/' -or
    $_ -match 'tsconfig|tsdown\.config|vitest\.config'
  }
  if ($forbidden) { throw "tarball 含违禁文件: $($forbidden -join ', ')" }
  Write-Host "tarball 内容核查通过（$($entries.Count) 项）"
}
finally { Pop-Location }

# 5. 人工确认 + 发布
Step '发布'
$confirm = Read-Host "即将把 $PkgName@$version 发布到 npm（不可撤回）。输入 yes 继续"
if ($confirm -ne 'yes') { throw '已取消发布' }
Push-Location $PkgDir
try {
  # 若账号要求 2FA，npm 会在此交互式提示输入 OTP
  pnpm publish --no-git-checks --registry $Registry
  if ($LASTEXITCODE -ne 0) { throw 'pnpm publish 失败，见上方错误输出' }
}
finally { Pop-Location }

# 6. 发布验证
Step '发布验证'
$got = npm view "$PkgName@$version" version --registry $Registry 2>$null
if ($got -ne $version) {
  Write-Host "npm view 暂未取到 $version——registry 同步可能有延迟，请稍后手动复查：" -ForegroundColor Yellow
  Write-Host "  npm view $PkgName --registry $Registry"
  exit 0
}
Write-Host "`n发布成功: $PkgName@$version" -ForegroundColor Green
Write-Host "安装验证: dsh plugin --profile web add $PkgName"
