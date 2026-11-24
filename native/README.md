# Protótipos de arraste nativo

Esses programas não fazem parte do pacote do HeyMouse. Servem para validar as duas pontas antes de integrar o gesto contínuo.

- Windows: execute `scripts/build-edge-drag-probe.ps1` e rode `.tmp/edge-drag/EdgeDragProbe.exe left`. Arraste um arquivo do Explorer até a faixa sem soltar. O evento `file-drag-enter` mostra que o Windows entregou os dados da origem durante o gesto. Validado no Windows do projeto.
- Mac: compile e execute as linhas abaixo em um Mac com Swift. Arraste a área de texto da janela para uma pasta aberta do Finder. A cópia deve aparecer nessa pasta, e o terminal deve mostrar `finder-drop-saved`. Feche a janela ao terminar. O protótipo usa um arquivo de teste já presente no Mac e foi validado no Mac do projeto.

```sh
mkdir -p .tmp/edge-drag
xcrun swiftc native/macos/FinderDragProbe.swift -o .tmp/edge-drag/FinderDragProbe
.tmp/edge-drag/FinderDragProbe "/caminho/de/um/arquivo.txt"
```

## Sentido inverso

No Mac, compile o detector da borda. Arraste um arquivo do Finder até a faixa verde, sem soltar. O resultado esperado é `file-drag-enter`. A faixa fecha depois de 30 segundos.

```sh
mkdir -p .tmp/edge-drag
xcrun swiftc native/macos/EdgeDragProbe.swift -o .tmp/edge-drag/MacEdgeDragProbe
.tmp/edge-drag/MacEdgeDragProbe right
```

No Windows, execute `scripts/build-edge-drag-probe.ps1`. Rode `.tmp/edge-drag/ExplorerDragProbe.exe "C:\caminho\arquivo.txt"` e arraste a área de texto da janela para outra pasta aberta no Explorer. Confira se a cópia aparece lá. Use um arquivo pequeno que já esteja no Windows.

## Integração experimental Windows → Mac

O aplicativo pode ligar a captura da borda do Windows à sessão nativa do Finder. O modo é voltado a desenvolvimento e fica desligado nas sessões normais. Ainda precisa de validação com os dois computadores. O sentido Mac → Windows ainda usa os protótipos separados acima.

Use o ID completo do outro aparelho, disponível nos detalhes do dispositivo. No Mac, compile o auxiliar do Finder e inicie o HeyMouse pelo Terminal. Autorize Acessibilidade para o processo que rodar o auxiliar.

```sh
mkdir -p .tmp/edge-drag
xcrun swiftc native/macos/FinderDragProbe.swift -o .tmp/edge-drag/FinderDragProbe
npm run build
export HEYMOUSE_EXPERIMENTAL_DRAG_PEER='ID_DO_WINDOWS'
export HEYMOUSE_EXPERIMENTAL_DRAG_HELPER="$PWD/.tmp/edge-drag/FinderDragProbe"
npm start
```

No Windows, feche a instância anterior e inicie depois do Mac:

```powershell
.\scripts\build-edge-drag-probe.ps1
npm run build
$env:HEYMOUSE_EXPERIMENTAL_DRAG_PEER = 'ID_DO_MAC'
$env:HEYMOUSE_EXPERIMENTAL_DRAG_HELPER = (Resolve-Path .tmp/edge-drag/EdgeDragProbe.exe).Path
$env:HEYMOUSE_EXPERIMENTAL_DRAG_EDGE = 'left'
npm start
```

Disponha uma pasta do Finder aberta antes do teste. A faixa do Windows dura 30 segundos. Use um arquivo de até 8 MB e mantenha o botão pressionado até o auxiliar abrir no Mac. A cópia é preparada temporariamente no Mac para iniciar o arraste. Só o Finder decide a pasta de destino na soltura. Cancelar ou encerrar a sessão remove a cópia temporária. Os binários auxiliares ainda não são distribuídos nos instaladores.
