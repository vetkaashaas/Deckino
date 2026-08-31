[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
if ($signature.Status -ne "Valid") {
    throw "Python installer signature status is $($signature.Status)."
}
if ($signature.SignerCertificate.Subject -notlike "*Python Software Foundation*") {
    throw "Python installer signer is not the Python Software Foundation."
}
