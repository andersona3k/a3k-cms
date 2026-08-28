# A3K Player — Android (Fase 3)

App nativo que embrulha o player web (`<cms>/player/`) numa **casca de kiosk**
para mini PC Android e tablets.

- **minSdk 28** (Android 9), targetSdk 34, Kotlin.
- **Autostart no boot** + **tela cheia imersiva** (saível pelo gesto secreto).
- **Offline real**: intercepta os GET do WebView e cacheia em disco —
  `/assets/*` (baixa uma vez), o manifest (serve o último quando sem rede) e a
  casca do app (`/player`, `/vendor`).
- **Watchdog** por `AlarmManager` (sem foreground service) + relaunch após crash.
- Pareamento pelo **código** do fluxo "Add player" do CMS (opcional; sem código
  o app abre `/player/` e pareia solto — só serve com 1 empresa).

## Build

Pré-requisitos já presentes nesta máquina: Android SDK em
`C:\Users\Usuario\AppData\Local\Android\Sdk`, JDK 21 em
`C:\Users\Usuario\.jdks\jbr-21.0.11` (fixado em `gradle.properties` porque o
JDK 25 da IDE não roda AGP 8.5). Ajuste os caminhos em `gradle.properties` e
`local.properties` se mudarem.

```bash
cd players/android
./gradlew :app:assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease      # release sem assinatura; assine antes de distribuir
```

Abrir no Android Studio: `File > Open` a pasta `players/android`. Se o Studio
usar o JBR 25 dele e o sync falhar, aponte *Gradle JDK* para o
`jbr-21.0.11` (Settings > Build Tools > Gradle).

## Instalar num aparelho

Via ADB (aparelho com Depuração USB ligada, ou ADB por Wi-Fi):

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Ou copie o `.apk` para o aparelho e instale pelo gerenciador de arquivos
(ative "fontes desconhecidas").

## Primeiro uso / provisionamento

1. Abra o app. Sem configuração, ele cai na tela **Configuração do Player**.
2. Preencha o **endereço do CMS** (ex.: `http://192.168.0.41:3000`). Use
   **Testar conexão** para confirmar (`/api/health`).
3. (Opcional, recomendado com multiempresa) No CMS, painel **Dispositivos →
   Add player**, gere um **código** já com nome/grupo/tipo. Digite esse código
   no campo **Código de pareamento**.
4. Escolha a **orientação** (paisagem para TV/mini PC; retrato/automática para
   tablet).
5. **Salvar e iniciar** → o player abre em tela cheia e pareia. O device
   aparece no CMS já vinculado (se usou código).

Depois disso o app sobe sozinho a cada boot.

## Operação

- **Reconfigurar**: no player, toque **7 vezes no canto superior esquerdo**
  (dentro de 3s) para abrir a tela de Configuração.
- **Sair do app**: botões Voltar/Menu são ignorados de propósito. Use o gesto
  acima e depois o botão Home do sistema, ou desinstale.
- **Autostart em alguns fabricantes** (Xiaomi/Redmi, alguns boxes) exige
  habilitar "iniciar automaticamente" / "autostart" nas configurações do
  aparelho para o app.
- **Cache**: fica em `filesDir/cms/` (`media/`, `doc/`, `manifest.json`).
  Ainda não há limpeza automática de assets removidos da playlist — limpar =
  reinstalar ou (futuro) botão na tela de Configuração.

## Estrutura

```
app/src/main/
  AndroidManifest.xml
  java/com/a3k/player/
    App.kt              Application: handler de crash + arma o watchdog
    SetupActivity.kt    tela de configuracao (URL, codigo, orientacao)
    PlayerActivity.kt   WebView em kiosk: imersivo, keep-screen-on, gesto secreto
    BootReceiver.kt     autostart no BOOT_COMPLETED
    Watchdog.kt         AlarmManager a cada ~4min; relaunch se o player sumiu
    cms/Prefs.kt        SharedPreferences (cms_url, pair_code, orientation)
    cms/CmsCache.kt     intercept do WebView -> cache de disco (offline real)
  res/                  layout do setup, tema preto, icone adaptativo
```

## Limites conhecidos da v1

- Sem lockdown total (screen pinning / device owner) — o app é saível.
- Watchdog reabre o player, mas não reinicia o aparelho travado.
- Cache de mídia não é podado; cresce com a biblioteca.
- Release não assinado no build padrão — gere um keystore antes de distribuir.
- Não testado em aparelho real ainda (build e lint OK; falta rodar em campo).
