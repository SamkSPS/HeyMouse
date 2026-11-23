# HeyMouse

Aplicativo desktop em português para compartilhar mouse e teclado pela rede local. A interface organiza as telas. O motor nativo [Deskflow 1.27](https://github.com/deskflow/deskflow/releases/tag/v1.27.0) transporta os eventos.

## Abrir no Windows

No pacote gerado, abra `release/win-unpacked/HeyMouse.exe`. Mantenha a pasta inteira ao copiar para outro Windows x64. Ela inclui o motor Deskflow.

Para montar o pacote a partir do código com Node.js 24:

```sh
npm ci
npm run engine:fetch
npm run pack
```

## Conectar dois computadores

1. Abra o HeyMouse nos dois computadores, na mesma rede IPv4.
2. Em um deles, clique em **Parear dispositivo** e gere um convite. Cole o convite no outro computador na opção **Tenho um convite**.
3. No computador que tem o mouse e teclado, selecione o modo servidor. No outro, selecione o modo receptor e escolha o servidor pareado.
4. No servidor, arraste as telas para refletir a posição física dos computadores. Use **Iniciar** nos dois.

Os aparelhos pareados mantêm sua identidade quando o endereço IP muda. A descoberta automática usa multicast IPv4 (UDP 47855). O pareamento e a medição de tempo de resposta usam TCP 47856 por padrão. O motor usa TCP 24800 no servidor por padrão. Permita essas conexões na rede privada se o firewall bloquear. Redes de convidados podem isolar os aparelhos.

Se o Deskflow já estiver rodando, encerre-o normalmente antes de iniciar o compartilhamento pelo HeyMouse. A medição em milissegundos na interface representa o tempo de resposta do canal de controle. A latência do mouse e teclado precisa ser medida separadamente.

## macOS

No Mac, com Node.js 24 instalado, execute na pasta do projeto:

```sh
npm ci
npm run pack:mac
```

O comando baixa e verifica o motor Deskflow para a arquitetura do Mac e gera um DMG do HeyMouse em `release/`. O motor fica dentro do HeyMouse, dispensando a instalação separada do Deskflow. O macOS pode pedir acesso à Rede Local e Acessibilidade. O pacote precisa ser gerado e validado em um Mac.

## Linux

Gere o aplicativo na plataforma de destino com `npm ci` e `npm run build`, e abra com `npm start`. Instale o Deskflow 1.27 e selecione o executável `deskflow-core` nas configurações se ele não for encontrado. O macOS pode pedir autorização de Acessibilidade. Em Linux/Wayland, o acesso depende dos portais disponíveis no ambiente gráfico. Essas plataformas ainda precisam de validação em máquinas reais.

O compartilhamento de áudio está previsto para uma etapa futura.
