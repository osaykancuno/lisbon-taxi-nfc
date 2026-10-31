# THE LISBON WAY: pubblica (o ripubblica) il gioco su SuperRare Studio, da Windows. Si avvia con doppio clic su PUBBLICA.cmd.
#
# La prima volta: installa cio' che manca, fa il login se serve, crea l'app (una sola volta: il suo indirizzo resta
# per sempre in deploy\the-lisbon-way.config.json), poi costruisce e pubblica il gioco. Le volte dopo: aggiorna i nomi del
# muro, rifa' i test, costruisce e aggiorna la stessa app. Non tocca crediti, pagamenti o wallet.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'deploy') | Out-Null
$Config = Join-Path $PSScriptRoot 'deploy\the-lisbon-way.config.json'
$Zip = Join-Path $PSScriptRoot 'dist\the-lisbon-way.zip'

function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host ''; Write-Host "STOP: $text" -ForegroundColor Red; exit 1 }
function Run([string]$exe, [string[]]$argList, [string]$what) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { Fail "$what non e' riuscito (codice $LASTEXITCODE). Il messaggio e' qui sopra." }
}
# rare-profile con --json: l'ultima riga JSON della risposta, come oggetto (o $null)
function Invoke-Rare([string[]]$argList) {
  $lines = @(& rare-profile @argList --json 2>&1 | ForEach-Object { "$_" })
  $script:CliRaw = ($lines -join "`n")
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = "$($lines[$i])".Trim()
    if ($line.StartsWith('{')) { try { return ($line | ConvertFrom-Json) } catch { } }
  }
  return $null
}
# gli oggetti con un id (e un nome) dentro una risposta, a qualsiasi profondita'
function Find-WithId($node) {
  $found = @()
  if ($null -eq $node) { return $found }
  if ($node -is [System.Array]) { foreach ($item in $node) { $found += Find-WithId $item }; return $found }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    $names = $node.PSObject.Properties.Name
    if ($names -contains 'id' -and (($names -contains 'name') -or ($names -contains 'slug') -or ($names -contains 'title'))) { $found += $node }
    foreach ($p in $node.PSObject.Properties) { if ($p.Name -ne 'id') { $found += Find-WithId $p.Value } }
  }
  return $found
}

Step 'Controllo Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Start-Process 'https://nodejs.org/'; Fail 'Node.js non e'' installato: installa la versione LTS (22 o piu'' recente) dalla pagina appena aperta, poi rilancia PUBBLICA.cmd.' }
$major = [int](((& node --version) -replace '^v', '').Split('.')[0])
if ($major -lt 22) { Start-Process 'https://nodejs.org/'; Fail "Node.js $major e' troppo vecchio: installa la versione LTS (22 o piu' recente), poi rilancia PUBBLICA.cmd." }

Step 'Controllo la riga di comando di SuperRare'
if (-not (Get-Command rare-profile -ErrorAction SilentlyContinue)) { Run 'npm' @('install', '--global', '@rareprotocol/rare-profile@0.1.0') 'L''installazione di rare-profile' }

Step 'Installo le dipendenze del gioco'
# ogni pacchetto che serve, uno per uno: una cartella node_modules incompleta (o un npm che salta gli strumenti di
# sviluppo, per esempio con NODE_ENV=production) si reinstalla da capo, strumenti di sviluppo compresi
$needed = @('tsx', 'esbuild', 'fflate', 'typescript', 'zod', '@rareprotocol\connect')
$missing = @($needed | Where-Object { -not (Test-Path (Join-Path $PSScriptRoot "node_modules\$_\package.json")) })
if ($missing.Count -gt 0) {
  Write-Host "Mancano: $($missing -join ', '). Installo tutto da capo."
  Run 'npm' @('ci', '--include=dev') 'npm ci'
} else { Write-Host 'gia'' installate.' }

Step 'Aggiorno i nomi del muro'
& node --import tsx scripts/snapshot-wall.ts
if ($LASTEXITCODE -ne 0) { Write-Host 'Il muro non risponde adesso: uso i nomi gia'' inclusi.' -ForegroundColor Yellow }

Step 'Provo il gioco (test delle regole e del verificatore, circa un minuto)'
Run 'npx' @('--no-install', 'tsx', '--test', 'tests/the-lisbon-way.test.ts', 'tests/the-lisbon-way-controls.test.ts') 'I test'

# la risposta della creazione dell'app, salvata appena arriva: se qualcosa si ferma dopo, non si crea una seconda app
$Answer = Join-Path $PSScriptRoot 'deploy\the-lisbon-way.app.json'
if (-not (Test-Path $Config) -and (Test-Path $Answer)) {
  Step 'Riprendo la prima pubblicazione: l''app esiste gia'''
  Run 'npx' @('--no-install', 'tsx', 'scripts/the-lisbon-way-config.ts', $Answer) 'La scrittura della configurazione'
}
# il gioco e' gia' online a questo indirizzo (deploy\the-lisbon-way.origin): si aggiorna QUELLA app, ritrovata tra le tue
$OriginFile = Join-Path $PSScriptRoot 'deploy\the-lisbon-way.origin'
if (-not (Test-Path $Config) -and (Test-Path $OriginFile)) {
  $origin = (Get-Content -Raw -LiteralPath $OriginFile).Trim()
  Step "Cerco tra le tue app quella gia' online: $origin"
  $list = Invoke-Rare @('product', 'list')
  if ($null -eq $list -or -not $list.ok) {
    Write-Host 'Serve il login: approva nel browser il codice che compare qui sotto.' -ForegroundColor Yellow
    Run 'rare-profile' @('login') 'Il login'
    $list = Invoke-Rare @('product', 'list')
  }
  $found = 2
  if ($list -and $list.ok) {
    $listFile = Join-Path $env:TEMP 'the-lisbon-way-products.json'
    [System.IO.File]::WriteAllText($listFile, $script:CliRaw)
    & npx --no-install tsx scripts/the-lisbon-way-config.ts --origin $origin --products $listFile
    $found = $LASTEXITCODE
  }
  if ($found -ne 0) {
    Write-Host ''
    Write-Host "Non trovo da solo l'App ID di $origin." -ForegroundColor Yellow
    $id = Read-Host "Incollalo qui (lo trovi nella pagina dell'app su SuperRare Studio, o nella lista qui sopra)"
    Run 'npx' @('--no-install', 'tsx', 'scripts/the-lisbon-way-config.ts', '--origin', $origin, '--app-id', $id.Trim()) 'La scrittura della configurazione'
  }
}
if (-not (Test-Path $Config)) {
  # senza la config si creerebbe un'app NUOVA: mai per sbaglio, solo se lo chiedi esplicitamente
  Write-Host ''
  Write-Host "Non trovo deploy\the-lisbon-way.config.json: senza questo file lo script creerebbe un'app NUOVA su SuperRare." -ForegroundColor Yellow
  Write-Host "Se il gioco e' gia' online, NON serve: metti in questa cartella il file deploy\the-lisbon-way.config.json"
  Write-Host "della pubblicazione precedente (o scarica il progetto aggiornato da GitHub, che lo contiene) e rilancia PUBBLICA.cmd."
  $choice = Read-Host "Per creare davvero un'app nuova scrivi NUOVA (qualsiasi altra risposta annulla)"
  if ($choice -cne 'NUOVA') { Fail "Annullato: nessuna app creata, niente pubblicato." }
  Step 'Prima pubblicazione: login e negozio'
  $stores = Invoke-Rare @('store', 'list')
  if ($null -eq $stores -or -not $stores.ok) {
    Write-Host 'Serve il login: approva nel browser il codice che compare qui sotto.' -ForegroundColor Yellow
    Run 'rare-profile' @('login') 'Il login'
    $stores = Invoke-Rare @('store', 'list')
    if ($null -eq $stores -or -not $stores.ok) { Fail "Non riesco a leggere i tuoi negozi su SuperRare Studio. Risposta: $script:CliRaw" }
  }
  $list = @(Find-WithId $stores.data | Where-Object { $_ })
  if ($list.Count -eq 0) {
    Write-Host 'Non hai ancora un negozio: ne creo uno, "THE LISBON WAY".'
    $created = Invoke-Rare @('store', 'create', 'THE LISBON WAY', '--description', 'THE LISBON WAY, a game of THE WALL ARCADE')
    if ($null -eq $created -or -not $created.ok) { Fail "La creazione del negozio non e' riuscita. Risposta: $script:CliRaw" }
    $list = @(Find-WithId $created.data | Where-Object { $_ })
    if ($list.Count -eq 0 -and $created.data.id) { $list = @($created.data) }
    if ($list.Count -eq 0) { Fail "Negozio creato, ma non trovo il suo id. Risposta: $script:CliRaw" }
  }
  $store = $list[0]
  $storeName = @($store.name, $store.title, $store.slug) | Where-Object { $_ } | Select-Object -First 1
  Write-Host "Negozio: $storeName ($($store.id))"

  Step 'Prima pubblicazione: creo l''app (una volta sola)'
  $tmp = Join-Path $env:TEMP 'the-lisbon-way-bootstrap'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $page = Join-Path $tmp 'index.html'
  [System.IO.File]::WriteAllText($page, '<!doctype html><title>Integration test only</title><h1>Integration test only</h1>')
  $bootstrap = Join-Path $tmp 'bootstrap.zip'
  Compress-Archive -Path $page -DestinationPath $bootstrap -Force
  $deployed = Invoke-Rare @('app', 'deploy', '--store', "$($store.id)", '--title', 'THE LISBON WAY - integration test', '--price', '0', '--zip', $bootstrap)
  if ($null -eq $deployed -or -not $deployed.ok) { Fail "La creazione dell'app non e' riuscita. Risposta: $script:CliRaw" }
  [System.IO.File]::WriteAllText($Answer, $script:CliRaw)
  Run 'npx' @('--no-install', 'tsx', 'scripts/the-lisbon-way-config.ts', $Answer) 'La scrittura della configurazione'
}

$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
Step "Costruisco il gioco per $($cfg.appOrigin)"
Run 'npx' @('--no-install', 'tsx', 'scripts/build.ts', '--config', 'deploy/the-lisbon-way.config.json', '--output', 'dist/the-lisbon-way.zip', '--force') 'La build'

Step 'Pubblico il gioco su SuperRare Studio (verificatore e evento di punteggio compresi)'
$updated = Invoke-Rare @('app', 'update', "$($cfg.appId)", '--zip', $Zip, '--max-attempts', '10000')
if ($null -eq $updated -or -not $updated.ok) {
  if ($updated -and $updated.error -and $updated.error.code -eq 'auth_required') {
    Run 'rare-profile' @('login') 'Il login'
    $updated = Invoke-Rare @('app', 'update', "$($cfg.appId)", '--zip', $Zip, '--max-attempts', '10000')
  }
  if ($null -eq $updated -or -not $updated.ok) { Fail "La pubblicazione non e' riuscita. Risposta: $script:CliRaw" }
}

$line = 'Drive the Lisbon tram: pick up the people of the wall, drop them at the stop of their colour. 90 seconds.'
Write-Host ''
Write-Host 'FATTO: THE LISBON WAY e'' online.' -ForegroundColor Green
Write-Host ''
Write-Host "Indirizzo del gioco : $($cfg.appOrigin)"
Write-Host "App ID              : $($cfg.appId)"
Write-Host 'Titolo              : THE LISBON WAY'
Write-Host "Riga                : $line"
Write-Host ''
Write-Host 'Ora apro il gioco (prova la Practice) e la pagina di invio all''arcade: entra con il wallet del tuo nome sul muro,'
Write-Host 'incolla indirizzo, App ID, titolo e riga qui sopra, il tuo wallet per i pagamenti, e spunta la casella.'
try { Set-Clipboard -Value "$($cfg.appOrigin)" } catch { }
Start-Process "$($cfg.appOrigin)/"
Start-Process 'https://thewallarcade.superrare.com/submit.html'
