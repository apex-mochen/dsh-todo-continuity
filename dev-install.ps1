# dev-install.ps1 — 打包本插件并安装到指定 DSH profile。
#
# 为什么用 tarball 而不是直接指目录：npm pack 出来的 tarball 就是将来发布到
# npm / 市场的那份产物，用它安装可以保证「本地测的」和「发出去的」是同一个东西，
# 也避免维护第二份会在你不注意时变旧的副本。
#
#   .\dev-install.ps1              # 装到 headless profile（默认，便于脚本化复现）
#   .\dev-install.ps1 web          # 装到 web profile
#
# ⚠️ 别把 tarball 路径直接内联进带引号的字符串里，例如
#    dsh plugin --profile $Profile add "$(Get-ChildItem *.tgz).FullName"
#    PowerShell 会把它当成字面量，pnpm 于是记录一条名字像
#    "xxx.tgz.FullName" 的垃圾依赖（本项目真踩过）。先把路径算进变量再用。
param([string]$Profile = 'headless')

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "[1/3] 打包 ..." -ForegroundColor Cyan
npm pack | Out-Null
$tgz = (Get-ChildItem -Path $PSScriptRoot -Filter '*.tgz' | Select-Object -First 1).FullName
Write-Host "      $tgz ($([math]::Round((Get-Item $tgz).Length / 1KB, 1)) KB)"

Write-Host "[2/3] 安装到 profile '$Profile' ..." -ForegroundColor Cyan
dsh plugin --profile $Profile add $tgz
if ($LASTEXITCODE -ne 0) { throw "安装失败（退出码 $LASTEXITCODE）" }

Write-Host "[3/3] 确认已进入组装树 ..." -ForegroundColor Cyan
$cfg = dsh --profile $Profile --dump-config 2>&1 | Out-String
if ($cfg -match 'dsh-todo-continuity') {
    Write-Host "      OK — dsh-todo-continuity 在组装树里" -ForegroundColor Green
} else {
    Write-Host "      警告：组装树里没找到，请检查 profile 的 package.json bundles" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "完成。重启 DSH（web profile 需要重启应用）后生效。" -ForegroundColor Green
Write-Host "验证方法：见 EVIDENCE.md —— 桩里同时调 todo_write 与 create_goal，"
Write-Host "          让 goal-round-driver 自动进入第二轮（真实的第二个 turn/start），"
Write-Host "          再看会话里第二个 turn/start 之后是否多出一条 todo/write。"
Write-Host ""
Write-Host "卸载回滚：dsh plugin --profile $Profile remove dsh-todo-continuity" -ForegroundColor DarkGray
Write-Host ""

# 显式成功退出：脚本中途调用过 npm / pnpm，它们的退出码会留在 $LASTEXITCODE，
# 让"明明成功却返回 1"——调用方或 CI 会误判为失败。
exit 0
