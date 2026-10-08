param([string]$PlatformTools = '.tools/platform-tools')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$toolsRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $PlatformTools))
$sbfRust = Join-Path $toolsRoot 'rust/bin/rustc.exe'
$sbfCargo = Join-Path $toolsRoot 'rust/bin/cargo.exe'
$llvmBin = Join-Path $toolsRoot 'llvm/bin'
if (!(Test-Path -LiteralPath $sbfRust)) { throw 'Extract official Solana platform-tools v1.57 into .tools/platform-tools first, or use cargo build-sbf --arch v0.' }
$env:RUSTC = $sbfRust
$env:RUSTDOC = Join-Path $toolsRoot 'rust/bin/rustdoc.exe'
$env:CARGO_HOME = Join-Path $projectRoot '.tools/cargo'
$env:CC = Join-Path $llvmBin 'clang.exe'
$env:AR = Join-Path $llvmBin 'llvm-ar.exe'
$env:PATH = (Join-Path $toolsRoot 'rust/bin') + ';' + $llvmBin + ';' + $env:PATH
& $sbfCargo build --release --locked --target sbpf-solana-solana --manifest-path programs/corporate-actions/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw 'SBF compilation failed.' }
New-Item -ItemType Directory -Force -Path target/deploy | Out-Null
& (Join-Path $llvmBin 'llvm-objcopy.exe') --strip-all target/sbpf-solana-solana/release/corporate_actions.so target/deploy/corporate_actions.so
if ($LASTEXITCODE -ne 0) { throw 'SBF stripping failed.' }
Get-Item target/deploy/corporate_actions.so | Select-Object FullName, Length
