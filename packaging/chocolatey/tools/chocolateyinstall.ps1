$ErrorActionPreference = 'Stop'
$packageArgs = @{
    packageName    = $env:ChocolateyPackageName
    fileType       = 'exe'
    url64bit       = 'https://github.com/gary23w/torflix/releases/download/v0.3.0/Torflix-Setup-0.3.0.exe'
    checksum64     = 'd90067f146908a67546fbbf2140db3888f7bb23fadd105beda407d3322ae5933'
    checksumType64 = 'sha256'
    silentArgs     = '/S /allusers --noLaunch'
    validExitCodes = @(0, 1641, 3010)
    softwareName   = 'Torflix*'
}
Install-ChocolateyPackage @packageArgs
