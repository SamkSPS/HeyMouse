# Protótipos de arraste nativo

Esses programas não fazem parte do pacote do HeyMouse. Servem para validar as duas pontas antes de integrar o gesto contínuo.

- Windows: execute `scripts/build-edge-drag-probe.ps1` e rode `.tmp/edge-drag/EdgeDragProbe.exe left`. Arraste um arquivo do Explorer até a faixa sem soltar. O evento `file-drag-enter` mostra que o Windows entregou os dados da origem durante o gesto. Validado no Windows do projeto.
- Mac: compile e execute as linhas abaixo em um Mac com Swift. Arraste a área de texto da janela para uma pasta aberta do Finder. A cópia deve aparecer nessa pasta, e o terminal deve mostrar `finder-drop-saved`. Feche a janela ao terminar. O protótipo usa um arquivo de teste já presente no Mac e ainda precisa ser executado lá.

```sh
mkdir -p .tmp/edge-drag
xcrun swiftc native/macos/FinderDragProbe.swift -o .tmp/edge-drag/FinderDragProbe
.tmp/edge-drag/FinderDragProbe "/caminho/de/um/arquivo.txt"
```

A integração pendente é transferir o controle do gesto do Explorer para a sessão de arraste do Mac. Ela precisa preservar a posição, o botão pressionado, a soltura e o cancelamento enquanto o cursor passa de um sistema para o outro. A cópia deve começar somente após a soltura em um destino aceito.
