# Parses PowerShell scripts with PowerShell's own parser (never executes them) and prints
# one JSON object per script: header comment, params with types/defaults/comments, $env reads.
# Works on Windows PowerShell 5.1 and pwsh 7.
# Paths come '|'-joined because -File can't bind arrays.
param([Parameter(Mandatory)][string]$PathList)

$ErrorActionPreference = 'Stop'
$Path = $PathList -split '\|'
$out = foreach ($file in $Path) {
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    $comments = @($tokens | Where-Object { $_.Kind -eq 'Comment' })

    # Header: the comment lines before the first real token.
    $firstCode = $tokens | Where-Object { $_.Kind -notin 'Comment', 'NewLine', 'EndOfInput' } | Select-Object -First 1
    $headerLimit = if ($firstCode) { $firstCode.Extent.StartLineNumber } else { [int]::MaxValue }
    $header = ($comments | Where-Object { $_.Extent.EndLineNumber -lt $headerLimit } | ForEach-Object {
            $_.Text -replace '^<#|#>$', '' -replace '^#\s?', ''
        }) -join "`n"
    $help = $ast.GetHelpContent()
    $synopsis = if ($help) { (@($help.Synopsis, $help.Description) | Where-Object { $_ }) -join "`n" } else { $null }

    $params = @()
    if ($ast.ParamBlock) {
        foreach ($p in $ast.ParamBlock.Parameters) {
            $name = $p.Name.VariablePath.UserPath
            $type = 'string'; $choices = $null; $mandatory = $false
            foreach ($attr in $p.Attributes) {
                if ($attr -is [System.Management.Automation.Language.TypeConstraintAst]) {
                    $type = $attr.TypeName.Name
                } elseif ($attr.TypeName.Name -eq 'ValidateSet') {
                    $choices = @($attr.PositionalArguments | ForEach-Object { $_.Value })
                } elseif ($attr.TypeName.Name -eq 'Parameter') {
                    foreach ($na in $attr.NamedArguments) {
                        if ($na.ArgumentName -eq 'Mandatory' -and ($na.ExpressionOmitted -or $na.Argument.Extent.Text -match 'true')) { $mandatory = $true }
                    }
                }
            }
            # Comments directly above the parameter (contiguous lines) document it.
            $doc = @(); $line = $p.Extent.StartLineNumber - 1
            while ($true) {
                $c = $comments | Where-Object { $_.Extent.EndLineNumber -eq $line -and $_.Extent.StartOffset -gt $ast.ParamBlock.Extent.StartOffset } | Select-Object -Last 1
                if (-not $c) { break }
                $doc = , ($c.Text -replace '^#\s?', '') + $doc
                $line = $c.Extent.StartLineNumber - 1
            }
            $helpDoc = if ($help -and $help.Parameters) { $help.Parameters[$name.ToUpper()] } else { $null }
            $params += [ordered]@{
                name        = $name
                psType      = $type
                choices     = $choices
                default     = if ($p.DefaultValue) { $p.DefaultValue.Extent.Text } else { $null }
                required    = $mandatory
                description = if ($helpDoc) { $helpDoc.Trim() } elseif ($doc.Count) { $doc -join ' ' } else { $null }
            }
        }
    }

    $envVars = @($ast.FindAll({
                param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] -and $n.VariablePath.DriveName -eq 'env'
            }, $true) | ForEach-Object { $_.VariablePath.UserPath -replace '^env:', '' } | Sort-Object -Unique)

    # Other repo scripts this one calls, e.g. & (Join-Path $root 'build.ps1')
    $calls = @([regex]::Matches($ast.Extent.Text, "['""]([\w.-]+\.ps1)['""]") | ForEach-Object { $_.Groups[1].Value } |
        Where-Object { $_ -ne (Split-Path $file -Leaf) } | Sort-Object -Unique)

    $text = $ast.Extent.Text
    [ordered]@{
        file        = $file
        header      = $header
        synopsis    = $synopsis
        params      = $params
        env         = $envVars
        calls       = $calls
        startsProcs = [bool]($text -match '\bStart-Process\b')
        stopsProcs  = [bool]($text -match '\bStop-Process\b|CloseMainWindow')
        errors      = @($errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" })
    }
}
ConvertTo-Json -InputObject @($out) -Depth 6 -Compress
