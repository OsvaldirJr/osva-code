# OsvaCode

Aplicativo desktop (macOS) para conversar com o **seu modelo de IA próprio** e com outros modelos,
com suporte a **servidores MCP** (ferramentas/plugins) e **respostas humanizadas**.

## Funcionalidades

- 🧠 **Múltiplos modelos** — qualquer provedor compatível com a API da OpenAI: Ollama, LM Studio,
  vLLM, OpenRouter, OpenAI, etc. Troque de modelo pelo seletor do campo de mensagem ou pelo
  rodapé do menu. A bolinha ao lado do campo mostra o uso de tokens da conversa.
- 🗂️ **Menu lateral** — Nova conversa, Pesquisa, Automatização e Design. O menu pode ser
  minimizado para uma faixa de ícones. No DevMode, as conversas da mesma pasta ficam juntas.
- 📎 **Anexos** — o botão **+** envia imagem, arquivo ou pasta. Imagens vão para modelos que
  enxergam; arquivos e pastas entram como texto, com limite de tamanho. Segredos (`.env`, chaves)
  são listados sem o conteúdo.
- ⚡ **Automatização** — lista de automações com interruptor de ativa/inativa. Gatilhos manuais,
  agendados (a cada hora, todo dia, dias úteis, toda semana, todo mês) e por ferramenta
  (GitHub, Slack, Microsoft Teams, Sentry, Linear, Webhook e PagerDuty). Cada ferramenta ganha
  uma URL local (`http://127.0.0.1:47321/hooks/…`) para colar no webhook. O OsvaCode precisa
  estar aberto, e a ferramenta só alcança o endereço se conseguir chegar neste computador.
- 🎨 **Design** — área de canvas abaixo de Automatização. O modelo desenha apresentação, tela,
  interface a partir do código, sistema de design ou motion com a ferramenta `design_canvas`.
  Dá para baixar o quadro em PNG.
- ⌘ **Comandos /** — no campo de mensagem, `/` abre ações e skills do projeto (por exemplo
  `/revisar` e `/explicar`).
- 🔌 **MCP e plugins** — adicione servidores MCP nas Configurações; as ferramentas deles ficam
  disponíveis para o modelo automaticamente.
- 💬 **Retorno humanizado**:
  - streaming palavra a palavra;
  - cada chamada de ferramenta aparece como um cartão explicando, em linguagem simples,
    o que o modelo está fazendo e o resultado;
  - botão **💡 Simplificar** em cada resposta, que a reescreve para leitores não técnicos;
  - erros traduzidos para mensagens claras ("o servidor do modelo não está rodando" em vez de
    `ECONNREFUSED`).

## Como rodar

```bash
npm install
npm run dev        # desenvolvimento (recarrega ao salvar)
npm run build      # build de produção
npm run package    # gera o app .dmg/.app para macOS
```

## Servindo o seu modelo próprio

O caminho mais simples é o [Ollama](https://ollama.com):

1. Instale o Ollama (`brew install ollama`) e deixe-o rodando (`ollama serve`).
2. Importe seus pesos:
   - **GGUF**: crie um arquivo `Modelfile` com `FROM ./meu-modelo.gguf` e rode
     `ollama create meu-modelo -f Modelfile`.
   - **Pesos HuggingFace/PyTorch**: converta para GGUF com o script `convert_hf_to_gguf.py`
     do [llama.cpp](https://github.com/ggerganov/llama.cpp) e importe como acima.
3. No OsvaCode, abra **Configurações → Modelos**: o provedor padrão já aponta para
   `http://localhost:11434/v1`. Clique em **Buscar modelos disponíveis** e selecione o seu.

> Alternativas: LM Studio (interface gráfica) ou vLLM (produção/GPU) — ambos expõem a mesma
> API compatível com OpenAI; basta cadastrar a URL deles como um novo provedor.

## Adicionando servidores MCP

Em **Configurações → MCP e plugins**, informe o comando que inicia o servidor. Exemplos:

| Servidor        | Comando | Argumentos |
| --------------- | ------- | ---------- |
| Sistema de arquivos | `npx`   | `-y @modelcontextprotocol/server-filesystem /Users/voce` |
| Fetch (web)     | `uvx`   | `mcp-server-fetch` |
| Memória         | `npx`   | `-y @modelcontextprotocol/server-memory` |

Marque **Habilitado** e salve — o app conecta na hora e mostra as ferramentas encontradas.

> ⚠️ Para o modelo conseguir *usar* as ferramentas, ele precisa suportar *function calling*
> (tool use). No Ollama, modelos como `llama3.1`, `qwen2.5` e derivados suportam.

## Arquitetura

```
src/
├── main/            # processo principal do Electron (Node)
│   ├── index.ts     # janela, IPC, ciclo de vida
│   ├── chat.ts      # loop de agente: streaming, ferramentas e design_canvas
│   ├── mcp.ts       # conexão com servidores MCP (SDK oficial, stdio)
│   ├── automationHooks.ts # webhooks locais das automações
│   ├── attach.ts    # leitura de imagem, arquivo e pasta anexados
│   ├── slashCommands.ts # expansão dos comandos /
│   ├── humanizer.ts # traduz eventos técnicos para linguagem simples
│   └── config.ts    # settings.json em userData
├── preload/         # ponte segura (contextBridge) entre main e renderer
├── renderer/        # interface React (chat, automações, design, configurações)
└── shared/          # tipos compartilhados, inclusive o documento do canvas
```

As configurações ficam em `~/Library/Application Support/osvacode/settings.json`.
