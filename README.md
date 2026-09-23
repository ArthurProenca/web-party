# Web Party

Extensão Manifest V3 para assistir a vídeos do YouTube e episódios do Crunchyroll em grupo, sincronizando os controles por uma conexão WebRTC direta. Destinada ao **Chrome e Microsoft Edge 116 ou superior**.

O host escolhe o vídeo e os convidados são levados a ele automaticamente. Qualquer participante pode dar play ou pausar; posição e velocidade seguem o host. Cada participante carrega seu próprio vídeo diretamente do serviço, com sua própria autorização de acesso, conta e assinatura quando exigidas. **A extensão não transmite áudio ou vídeo, não compartilha credenciais e não remove nem contorna DRM, assinaturas ou restrições regionais.**

Não há backend de sinalização nem relay TURN. A conexão é negociada pela troca manual de dois códigos em um chat externo. O STUN do Google é opcional e vem ativado por padrão.

## Instalação

Não é necessário build, Node.js, `npm install` ou dependências para usar a extensão.

1. Baixe ou clone este repositório.
2. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e selecione a pasta **`extension/`**, não a raiz do repositório. Ela contém o `manifest.json`.
5. Fixe o ícone da Web Party, se desejar, e abra um vídeo compatível. Recarregue páginas que já estavam abertas antes da instalação para carregar o script da extensão.

Todos os participantes precisam instalar a extensão em seus próprios perfis ou máquinas. Firefox e Safari **não são suportados por esta arquitetura**: a implementação depende de `chrome.offscreen` e das APIs Chromium utilizadas, sem adaptação para esses navegadores.

## Criar E Entrar

1. **Host:** abra um vídeo do YouTube ou um episódio do Crunchyroll, inicie o player e mantenha essa aba ativa. Abra a extensão, informe seu nome e clique em **Criar uma party**. Aguarde a preparação da conexão, que pode levar até 20 segundos: o **link de convite é copiado automaticamente**. Cole no chat com **uma pessoa**, por um canal privado e autenticado.
2. **Convidado:** clique no link. O vídeo do host abre com um cartão da Web Party: informe seu nome (fica salvo) e clique em **Entrar na party**. A resposta é gerada e **copiada automaticamente**; cole no chat com o host. O cartão confirma quando a conexão fecha.
3. **Host:** copie a resposta do chat e abra a extensão. Ela reconhece a resposta na área de transferência e mostra **Conectar _nome_**. Um clique conclui a conexão. Aguarde o estado **Conectado**; trocar códigos não garante que a rede permita conectar.
4. Para adicionar outra pessoa, o host usa **Convidar outra pessoa**: um novo link é copiado. São até **8 convidados, além do host**, em topologia estrela: cada convidado conecta-se ao host, não aos demais convidados.

Se o navegador bloquear autoplay no convidado, clique em reproduzir no próprio player para liberar áudio e sincronização.

**Alternativa manual:** os campos do popup continuam aceitando o link, o código sozinho ou a mensagem inteira do chat. O convidado pode colar o convite em **Entrar em party existente**, e o host pode colar a resposta em **Ou cole a resposta aqui**. O popup também reconhece um convite copiado quando o convidado ainda não está em uma party.

Cada convite conecta uma única pessoa e vale por 30 minutos. **Descartar convite e gerar outro** invalida o convite pendente anterior. Respostas também são validadas por idade e devem corresponder à party e ao convite ainda pendente. Não reutilize códigos de conexões encerradas.

### Links e códigos

- O convite viaja no fragmento (`#wp=...`) do endereço do vídeo do host. Fragmentos não são enviados aos servidores do site, e a extensão remove o convite do endereço antes de os scripts da página rodarem.
- Os códigos (`WP2.`) têm cerca de 200 a 300 caracteres: carregam apenas credenciais ICE, a impressão digital DTLS e os candidatos UDP, e a descrição completa é remontada do outro lado. Quando a conexão não pode ser compactada assim, a extensão usa o formato completo (`WP1.`), mais longo, que continua aceito.
- Não há pressa para colar a resposta: enquanto o convite vale, a conexão ainda não estabelecida continua tentando em segundo plano. Sem isso, o Chrome desiste em cerca de 15 segundos sem resposta e, entre redes diferentes, a abertura no roteador expira antes de o host colar o código.
- Os códigos contêm endereços de rede (IP público via STUN e nomes mDNS locais). Compartilhe apenas com quem você convidou.
- A extensão pede permissão para ler e escrever na área de transferência. A leitura acontece só quando o popup é aberto, para reconhecer uma resposta ou convite; nada é enviado a terceiros.

## Reprodução

- Host e convidados podem dar play e pausar. Um play/pausa do convidado, feito por clique ou tecla no player, é enviado ao host, que aplica no próprio player e repassa o novo estado a todos. Pausas e retomadas feitas pelo próprio site, sem interação do usuário, não são repassadas.
- O host é a autoridade sobre o vídeo, a busca na linha do tempo e a velocidade. Buscas e mudanças de velocidade do convidado são corrigidas pelo próximo estado recebido.
- O host escolhe a velocidade (**1x, 1.25x, 1.5x ou 2x**) direto no popup, ou pelo menu do próprio player; todos passam a assistir nela. Os convidados veem a velocidade atual no popup.
- Somente controles e metadados necessários, como URL e título do conteúdo, estados de reprodução e informações de participantes/conexão, trafegam pelo canal de dados. Não há compartilhamento do stream.
- A sincronização só é aplicada quando host e convidado estão no mesmo vídeo ou episódio, identificado pelo serviço e pelo ID do conteúdo. Não é sincronização entre um vídeo do YouTube e outro do Crunchyroll.
- Quando o host muda de vídeo ou episódio, inclusive por navegação SPA, a aba da party de cada convidado é redirecionada automaticamente e trazida para a frente. Só o host troca o vídeo: se o convidado navegar a aba da party para outro vídeo, ela volta ao vídeo do host. Se o convidado fechar a aba da party ou sair do site, ela só é reaberta quando o host mudar de vídeo.
- Se a aba vinculada for fechada ou sair de um endereço compatível, abra o conteúdo novamente e use **Usar esta aba**. A conexão com as pessoas pode continuar enquanto o player fica indisponível.
- O player precisa estar carregado e detectável. O script procura elementos HTML `<video>` visíveis, com duração finita, nos frames permitidos. Mudanças nos sites podem exigir ajustes na extensão.
- Há correção de desvio e estimativa de atraso, não garantia de sincronização exata. Buffering do host pode pausar o convidado; buffering local, políticas de autoplay e limitações do player continuam sujeitos ao navegador e ao serviço.
- **Anúncios pausam a party para todos.** Quando alguém recebe um anúncio, os demais ficam pausados na posição atual até o anúncio terminar, e a reprodução retoma sozinha se estava tocando. O popup mostra para quem é o anúncio. Durante o anúncio do host, o tempo do anúncio não é repassado; durante o de um convidado, o player dele não é sincronizado. Se um convidado parar de informar o anúncio por 6 segundos, ou se o anúncio passar de 3 minutos, a party é liberada. O host pode forçar a retomada dando play no próprio player. Esta extensão não bloqueia anúncios.
- A detecção de anúncio usa o estado do próprio player do YouTube (`ad-showing`). **No Crunchyroll, anúncios ainda não são detectados**: a party não pausa para eles, e o anúncio de uma pessoa pode dessincronizá-la até terminar.
- **Transmissões ao vivo não são suportadas de forma confiável.** Prefira conteúdo sob demanda com a mesma timeline para todos.
- O host pode remover convidados individualmente. **Sair da party** encerra a participação do convidado; **Encerrar party** no host encerra a sala para todos. Não há transferência automática de host.

## Sessão E Continuidade

As instâncias de `RTCPeerConnection` e os canais de dados ficam no documento **offscreen**, e não no popup ou no service worker. Fechar o popup não encerra a party. A suspensão ou reinicialização do service worker também não deve derrubar essas conexões **enquanto o documento offscreen continuar vivo**; o worker volta a intermediar mensagens quando necessário.

`chrome.storage.session` guarda snapshots com metadados da sessão, códigos pendentes, preferências de nome/STUN e rascunhos dos campos do popup. Isso permite reabrir a interface durante a sessão do navegador. Esse armazenamento não é um backup das conexões e não equivale a persistência em disco com `storage.local` ou `storage.sync`.

**Reiniciar o navegador, recarregar/desativar a extensão ou interromper o documento offscreen perde as conexões P2P.** O armazenamento de sessão é limpo ao reiniciar o navegador ou recarregar/desativar a extensão. Se o offscreen reiniciar e ainda encontrar metadados de uma party interrompida, recupera as preferências, mas descarta a party e seus transportes e informa a interrupção. Não restaura peers nem exibe uma conexão fictícia a partir de códigos salvos.

Depois de uma interrupção, o host precisa criar uma nova party e os convidados precisam de novos convites e respostas. Uma falha definitiva de um peer também exige nova troca de códigos; se necessário, o convidado deve sair da party anterior antes de entrar novamente. Uma queda breve de rede pode se recuperar, mas isso não é garantido.

## Rede E Privacidade

### Conectividade

- Por padrão, a descoberta ICE usa `stun:stun.l.google.com:19302`. Esse servidor recebe o IP de quem o consulta para ajudar a descobrir um endereço alcançável, mas não retransmite a party nem o vídeo.
- A opção **Usar STUN para descobrir meu endereço de rede** pode ser desativada antes de criar ou entrar na party. Sem STUN, a tentativa usa candidatos locais do WebRTC, geralmente adequada à mesma LAN. Políticas de mDNS, isolamento entre clientes Wi-Fi, firewalls e diferenças entre navegadores podem impedir a conexão mesmo na mesma rede.
- **Não existe TURN nem backend de sinalização.** STUN não é relay e não resolve todos os NATs. NAT duplo, CGNAT, NAT restritivo, VPNs e redes corporativas podem impedir a conexão direta. Não há garantia de funcionamento entre redes distintas, nem mesmo com STUN ativado.
- Se a conexão não se estabelecer, confira a troca completa de códigos e tente um novo convite ou outra rede. Desativar STUN não é uma solução geral para conexões pela internet. O host tem um prazo de aproximadamente 90 segundos após aceitar a resposta para a conexão abrir.

### Códigos E Confiança

Os códigos `WP1.` contêm JSON compactado com **gzip** e codificado em **base64url**. **Isso não é criptografia:** qualquer pessoa com o código pode decodificá-lo. Eles incluem nome, identificadores da party e do convite, data e descrição SDP, com candidatos ICE que podem revelar endereços IP ou nomes mDNS e o fingerprint do certificado WebRTC.

Trate convite e resposta como dados privados de conexão, não como senhas secretas ou prova de identidade. Não os publique em issues, logs públicos, capturas de tela ou salas abertas. A expiração limita a aceitação pela extensão, mas não apaga informações já copiadas.

O canal de dados WebRTC usa criptografia de transporte, porém a identidade do outro participante depende da integridade da troca dos códigos. **Use um canal privado e autenticado e confirme com quem está falando.** Se alguém interceptar e puder substituir os códigos no chat, poderá realizar um ataque de intermediário (MITM), apesar da criptografia do WebRTC. A extensão não oferece verificação independente de identidade. Em uma conexão direta, os participantes também podem conhecer os endereços de rede uns dos outros.

## Arquitetura

| Caminho | Responsabilidade |
| --- | --- |
| `extension/manifest.json` | Manifest V3, Chrome mínimo 116, permissões, páginas e domínios permitidos. |
| `extension/background.js` | Service worker: cria/localiza o offscreen, valida a origem das operações e intermedeia mensagens, abas e armazenamento de sessão. |
| `extension/offscreen.html`, `extension/offscreen.js` | Documento persistente durante a party: WebRTC, negociação ICE, peers, convites, estado da sala e distribuição dos controles do host. |
| `extension/lib/protocol.js` | Codificação e validação dos sinais, limites de tamanho e validade, identificação de mídia e normalização de estados de reprodução. |
| `extension/content.js` | Descoberta e observação do player nos frames permitidos; coleta de estado e aplicação dos controles nos convidados. |
| `extension/popup.html`, `extension/popup.css`, `extension/popup.js` | Interface, troca de códigos, lista de participantes, escolha da aba e rascunhos. |
| `tests/` | Testes de protocolo, player, orquestração offscreen e roteamento de mensagens, com simulações das APIs do navegador quando necessário. |
| `scripts/check.js` | Verificações locais acionadas por `npm run check`. |
| `scripts/package.js` | Empacotamento Chromium acionado por `npm run package`. |

### Permissões

- `activeTab`: acesso à aba ativa por ação do usuário, para selecionar o conteúdo da party.
- `storage`: metadados, preferências, códigos pendentes e rascunhos em `chrome.storage.session`.
- `offscreen`: mantém o contexto WebRTC fora da vida útil do popup e do service worker.
- Acesso aos sites restrito a HTTPS em `*.youtube.com`, `*.youtube-nocookie.com` e `*.crunchyroll.com`. Os content scripts são carregados nos frames desses domínios, incluindo players incorporados permitidos. Isso não significa suporte a toda rota desses sites ou a páginas arbitrárias que incorporem seus vídeos.

## Desenvolvimento

Use **Node.js 22 ou superior** com npm. Não há dependências npm para instalar nem etapa de compilação da extensão.

```sh
npm test
npm run check
npm run package
```

`npm test` executa os testes com `node --test`. As verificações locais e os testes simulados não substituem testes WebRTC reais, nem comprovam compatibilidade atual com os players dos serviços.

Na validação inicial, um teste adicional com Chromium 153 real e dois perfis independentes confirmou a troca de códigos, WebRTC sem STUN, controles de um vídeo HTML de teste, reabertura do popup, reinício do service worker e encerramento pelo host. A interface também foi verificada em largura de 560 pixels. Esse teste usou uma página controlada, não os players reais do YouTube/Crunchyroll nem duas redes distintas.

O empacotamento gera **`dist/WebParty-chrome-v0.1.0.zip`** para a versão atual. O mesmo ZIP serve ao Chrome e ao Edge; não há pacote Edge separado. Para carregar sem compactação, extraia o ZIP e selecione a pasta que contém o `manifest.json`.

O script de empacotamento usa o comando **`zip` do sistema operacional**, disponível ou instalável no macOS e Linux. No Windows, use WSL com Node.js 22+ e `zip`, ou compacte manualmente **o conteúdo de `extension/`**, mantendo o `manifest.json` na raiz do arquivo. Essa dependência é só do empacotamento, não da instalação sem compactação.

Os workflows em `.github/workflows/` validam testes, sintaxe e manifesto e geram um único pacote Chromium para Chrome e Edge. Firefox e Safari não são empacotados porque esta arquitetura depende de APIs Chromium (`chrome.offscreen`); suporte a esses navegadores exige uma implementação específica antes de ser adicionado ao CI.

## Verificação Manual

Este é um roteiro de validação, **não um registro de testes já realizados em navegadores ou serviços reais**. Use ao menos dois perfis independentes ou duas máquinas, com a extensão instalada nos dois lados e acesso autorizado ao mesmo conteúdo. Repita no Chrome e no Edge 116+. Testar apenas duas abas do mesmo perfil não representa dois participantes independentes.

1. **Troca completa:** com um vídeo carregado no host, crie a party e confira que o link foi copiado. No outro perfil, clique no link, confirme que o endereço fica sem `#wp=`, entre pelo cartão e confira que a resposta foi copiada. No host, abra a extensão com a resposta copiada e use **Conectar**. Confira que só aparece **Conectado** após o canal abrir e que o cartão do convidado confirma. Repita para YouTube e Crunchyroll e com o fluxo manual pelos campos do popup.
2. **Redes distintas:** repita em duas máquinas em redes diferentes, por exemplo banda larga e hotspot móvel, com STUN ativado. Esse teste é importante para exercitar NAT/ICE reais. Registre também falhas; sucesso na LAN não comprova funcionamento pela internet. Tente sem STUN na LAN e observe possíveis limitações de mDNS ou isolamento de rede.
3. **Controles e autoplay:** no host, reproduza, pause, busque para frente e para trás e altere a velocidade. Verifique o acompanhamento no convidado. No convidado, pause e retome pelo player e confirme que host e demais convidados acompanham; busca e velocidade do convidado não devem alterar o host. Quando autoplay for bloqueado, confira o aviso e clique em reproduzir no player do convidado.
4. **Anúncios:** com um convidado recebendo anúncio (YouTube sem Premium), confirme que host e demais convidados pausam, que o popup indica para quem é o anúncio e que todos retomam ao final. Repita com o anúncio no host e confirme que os convidados não saltam para o tempo do anúncio.
5. **Troca de vídeo e SPA:** troque o vídeo/episódio no host, inclusive por navegação SPA, e confirme que a aba da party do convidado é levada ao novo conteúdo sem abrir o popup. No convidado, navegue a aba da party para outro vídeo e confirme que ela volta ao do host. Confirme que estados do episódio anterior não são aplicados ao novo.
6. **Aba fechada:** feche a aba do player mantendo o navegador aberto. Confira a indicação de player indisponível, abra uma nova aba compatível e use **Usar esta aba** para retomar, sem reutilizar amostras da aba antiga.
7. **Códigos inválidos:** tente código truncado, prefixo incorreto, resposta no campo de convite, resposta de outra party, código expirado após 30 minutos e resposta de convite descartado ou já usado. Espere erros claros, sem criar um falso estado conectado ou consumir indevidamente o convite válido.
8. **Vários convidados:** adicione pessoas com convites distintos, confira os estados individuais e o limite de oito convidados. Remova uma pessoa e confirme que os demais continuam. Encerre a party no host e confira o encerramento nos convidados.
9. **Desconexão:** interrompa a rede de um participante, observe os estados de recuperação/falha e verifique que o convidado deixa de aplicar estados remotos antigos. Após falha definitiva, teste sair e conectar com um novo convite e uma nova resposta.
10. **Popup e worker:** feche e reabra o popup durante a geração e a troca de códigos e durante a reprodução. Confira códigos pendentes, rascunhos e estado atual. Com a party conectada, termine apenas o service worker pelas ferramentas de desenvolvimento do navegador, mantendo o offscreen vivo. Confira que as conexões continuam e que a interface volta a consultar o estado real ao reabrir. Um inspetor aberto pode impedir a suspensão natural do worker.
11. **Interrupção e reinício:** interrompa o offscreen e confirme que a interface não restaura uma party ficticiamente conectada. Separadamente, recarregue a extensão e reinicie o navegador; confirme a limpeza de `storage.session`, a ausência de conexões restauradas e a necessidade de criar nova party e trocar novos códigos. Recarregue também as páginas de vídeo após recarregar a extensão.
