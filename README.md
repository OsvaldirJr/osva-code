# OsvaCode

Aplicativo desktop (macOS) para conversar com o **seu modelo de IA próprio** e com outros modelos,
com suporte a **servidores MCP** (ferramentas/plugins) e **respostas humanizadas**.

## Funcionalidades

- 🧠 **Múltiplos modelos** — qualquer provedor compatível com a API da OpenAI: Ollama, LM Studio,
  vLLM, OpenRouter, OpenAI, etc. Troque de modelo pelo seletor no topo da janela.
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
│   ├── chat.ts      # loop de agente: streaming + execução de ferramentas
│   ├── mcp.ts       # conexão com servidores MCP (SDK oficial, stdio)
│   ├── humanizer.ts # traduz eventos técnicos para linguagem simples
│   └── config.ts    # settings.json em userData
├── preload/         # ponte segura (contextBridge) entre main e renderer
├── renderer/        # interface React (chat, cartões de ferramenta, configurações)
└── shared/          # tipos compartilhados
```

As configurações ficam em `~/Library/Application Support/osvacode/settings.json`.
