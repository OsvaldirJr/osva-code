// Catálogo de skills prontas embutidas no app + detecção da stack do projeto.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

export interface CatalogSkill {
  id: string
  label: string
  description: string
  content: string
}

function readPackageDeps(folder: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ])
  } catch {
    return new Set()
  }
}

function readComposerDeps(folder: string): Set<string> {
  try {
    const composer = JSON.parse(readFileSync(join(folder, 'composer.json'), 'utf-8')) as {
      require?: Record<string, string>
      'require-dev'?: Record<string, string>
    }
    return new Set([
      ...Object.keys(composer.require ?? {}),
      ...Object.keys(composer['require-dev'] ?? {})
    ])
  } catch {
    return new Set()
  }
}

function hasSqlFiles(folder: string): boolean {
  const candidates = ['', 'db', 'database', 'sql', 'migrations', 'prisma']
  for (const sub of candidates) {
    try {
      const dir = sub ? join(folder, sub) : folder
      if (!existsSync(dir)) continue
      if (readdirSync(dir).some((f) => f.endsWith('.sql') || f === 'schema.prisma')) {
        return true
      }
    } catch {
      // segue para o próximo diretório
    }
  }
  return false
}

/** Identifica a stack do projeto e retorna os ids das skills do catálogo que se aplicam. */
export function detectSkills(folder: string): string[] {
  const deps = readPackageDeps(folder)
  const composerDeps = readComposerDeps(folder)
  const detected: string[] = []
  if (deps.has('react') || deps.has('react-dom') || deps.has('next')) detected.push('react')
  if ([...deps].some((d) => d.startsWith('@angular/'))) detected.push('angular')
  if (deps.has('vue') || deps.has('nuxt')) detected.push('vue')
  if (deps.has('express') || deps.has('@nestjs/core') || deps.has('fastify') || deps.has('koa')) {
    detected.push('node')
  }
  if (existsSync(join(folder, 'tsconfig.json'))) detected.push('typescript')
  if (
    existsSync(join(folder, 'requirements.txt')) ||
    existsSync(join(folder, 'pyproject.toml')) ||
    existsSync(join(folder, 'setup.py'))
  ) {
    detected.push('python')
  }
  if (composerDeps.has('laravel/framework') || existsSync(join(folder, 'artisan'))) {
    detected.push('laravel')
  }
  if (existsSync(join(folder, 'pubspec.yaml'))) detected.push('flutter')
  const sqlOrms = ['prisma', '@prisma/client', 'knex', 'typeorm', 'sequelize', 'drizzle-orm', 'pg', 'mysql2', 'better-sqlite3']
  if (hasSqlFiles(folder) || sqlOrms.some((d) => deps.has(d)) || detected.includes('laravel')) {
    detected.push('sql')
  }
  if (
    existsSync(join(folder, 'pom.xml')) ||
    existsSync(join(folder, 'build.gradle')) ||
    existsSync(join(folder, 'build.gradle.kts')) ||
    existsSync(join(folder, 'src/main/java'))
  ) {
    detected.push('java')
  }
  if (
    existsSync(join(folder, 'Dockerfile')) ||
    existsSync(join(folder, 'docker-compose.yml')) ||
    existsSync(join(folder, 'docker-compose.yaml')) ||
    existsSync(join(folder, 'compose.yaml'))
  ) {
    detected.push('docker')
  }
  return detected
}

export const SKILL_CATALOG: CatalogSkill[] = [
  {
    id: 'react',
    label: 'React',
    description: 'Boas práticas modernas de React (hooks, estado, dados de servidor)',
    content: `---
nome: react
descricao: Boas práticas de React neste projeto
---

Ao escrever ou revisar código React neste projeto:

- Use componentes de função com hooks; nunca componentes de classe.
- Derive estado em vez de sincronizar com useEffect. useEffect é só para
  efeitos externos (eventos, subscriptions, integração com libs imperativas).
- Dados de servidor: use React Query/SWR (cache, retry, loading) em vez de
  fetch dentro de useEffect. Sempre trate loading e erro.
- useMemo/useCallback apenas quando houver problema medido de performance.
- Componha componentes pequenos; evite prop drilling com composição
  (children/render props) antes de recorrer a contexto.
- Listas: key estável (id do dado), nunca o índice quando a ordem muda.
- Formulários: react-hook-form + zod para validação.
- Nunca mutar estado diretamente; sempre criar novos objetos/arrays.
`
  },
  {
    id: 'angular',
    label: 'Angular',
    description: 'Angular moderno (standalone, signals, control flow novo)',
    content: `---
nome: angular
descricao: Boas práticas de Angular neste projeto
---

Ao escrever ou revisar código Angular neste projeto:

- Use standalone components; não crie NgModules novos.
- Prefira signals para estado local e computed para derivações;
  RxJS apenas onde streams fazem sentido (HTTP, eventos contínuos).
- Use o control flow nativo (@if, @for com track, @switch) em vez de
  *ngIf/*ngFor.
- Injete dependências com inject() em vez de constructor quando possível.
- Change detection OnPush em todos os componentes.
- Rotas com lazy loading (loadComponent/loadChildren).
- Formulários: typed reactive forms; nunca template-driven em telas novas.
- Serviços com providedIn: 'root'; um serviço = uma responsabilidade.
`
  },
  {
    id: 'vue',
    label: 'Vue',
    description: 'Vue 3 com Composition API e script setup',
    content: `---
nome: vue
descricao: Boas práticas de Vue neste projeto
---

Ao escrever ou revisar código Vue neste projeto:

- Vue 3 com <script setup lang="ts"> e Composition API; nada de Options API.
- Estado: ref/computed locais; Pinia para estado compartilhado.
- Props tipadas com defineProps<T>(); eventos com defineEmits.
- watch/watchEffect com parcimônia — prefira computed.
- Componentes pequenos e single-file; extraia composables (useX) para
  lógica reutilizável.
- Listas com :key estável; v-if e v-for nunca no mesmo elemento.
`
  },
  {
    id: 'node',
    label: 'Node.js (backend)',
    description: 'APIs Node seguras e sustentáveis (ESM, validação, erros)',
    content: `---
nome: node
descricao: Boas práticas de backend Node neste projeto
---

Ao escrever ou revisar código de backend Node neste projeto:

- ESM e async/await; nunca callbacks aninhados nem .then encadeado longo.
- Valide TODA entrada externa na borda com zod; nunca confie no body.
- Erros: middleware/handler central; nunca engula exceções; responda
  status HTTP corretos (400 validação, 401/403 auth, 500 inesperado).
- Segredos só em variáveis de ambiente; nunca hardcode nem commit de .env.
- Nunca bloqueie o event loop (sem cálculos pesados síncronos; use streams
  para arquivos/dados grandes).
- Logs estruturados (pino) com contexto; nada de console.log em produção.
- SQL sempre parametrizado; nunca concatene strings em queries.
`
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    description: 'Tipagem estrita e idiomática',
    content: `---
nome: typescript
descricao: Boas práticas de TypeScript neste projeto
---

Ao escrever ou revisar TypeScript neste projeto:

- strict sempre; proibido any — use unknown + narrowing quando necessário.
- Prefira union types e literais a enums; interfaces para objetos públicos.
- Generics quando eliminam repetição real; não sobre-engenheire tipos.
- Funções pequenas com tipos de retorno explícitos nas exportadas.
- null/undefined: trate na borda; use optional chaining e nullish coalescing.
- Nunca use "as" para calar o compilador — corrija o tipo de verdade;
  type guards (is) para narrowing reutilizável.
`
  },
  {
    id: 'laravel',
    label: 'Laravel',
    description: 'Laravel idiomático (Eloquent, FormRequest, filas, políticas)',
    content: `---
nome: laravel
descricao: Boas práticas de Laravel neste projeto
---

Ao escrever ou revisar código Laravel neste projeto:

- Validação SEMPRE em FormRequest; nunca valide no controller.
- Controllers finos: regra de negócio em Services/Actions; uma
  responsabilidade por classe.
- Eloquent: previna N+1 com eager loading (with); use scopes para filtros
  reutilizáveis; casts para tipos; nunca query dentro de loop.
- Banco: toda alteração de schema via migration (nunca à mão); seeders e
  factories para dados de teste.
- Autorização com Policies/Gates; nunca cheque papel de usuário solto no
  controller.
- Tarefas lentas (e-mail, integrações) em Jobs com fila; nunca no request.
- Configuração via config/*.php lendo env(); nunca env() fora de config.
- Rotas nomeadas; API Resources para respostas JSON consistentes.
- Testes com Pest/PHPUnit usando RefreshDatabase e factories.
`
  },
  {
    id: 'flutter',
    label: 'Flutter',
    description: 'Flutter/Dart com widgets enxutos e gerência de estado sã',
    content: `---
nome: flutter
descricao: Boas práticas de Flutter neste projeto
---

Ao escrever ou revisar código Flutter neste projeto:

- Widgets pequenos e componíveis; extraia sub-widgets em vez de métodos
  buildAlgo() gigantes; use const em todo widget que puder.
- Estado: separe UI de lógica (Riverpod, Bloc ou o padrão já usado no
  projeto — siga o existente); setState só para estado local trivial.
- Null-safety de verdade: evite ! (bang); trate nulos com ??, ?. e
  fluxos claros.
- Async: nunca use BuildContext após await sem checar mounted;
  FutureBuilder/StreamBuilder com tratamento de loading e erro.
- Listas longas: ListView.builder (nunca ListView com children gigante).
- Navegação tipada (go_router se disponível); temas centralizados em
  ThemeData — nada de cores/tamanhos mágicos espalhados.
- Imagens e assets declarados no pubspec; dimensione imagens de rede.
- Testes: widget tests para componentes críticos; golden tests para UI
  estável.
`
  },
  {
    id: 'sql',
    label: 'SQL',
    description: 'Consultas seguras e eficientes (índices, transações, migrações)',
    content: `---
nome: sql
descricao: Boas práticas de SQL e banco de dados neste projeto
---

Ao escrever ou revisar SQL / código de banco neste projeto:

- SEMPRE queries parametrizadas; NUNCA concatene entrada do usuário em SQL
  (nem "só desta vez").
- Nunca SELECT *: liste as colunas necessárias.
- Previna N+1: busque relações com JOIN/IN em lote, não uma query por item.
- Escreva pensando em índice: filtros e JOINs em colunas indexadas; ao criar
  query lenta, proponha o índice junto (e confira com EXPLAIN).
- Transações para operações multi-tabela; curtas — nunca segure transação
  durante chamada externa.
- Alterações de schema via migração versionada, com rollback definido;
  nunca ALTER TABLE manual em produção.
- Tipos corretos (datas como date/timestamp, dinheiro como numeric/decimal
  — nunca float).
- Constraints no banco (NOT NULL, UNIQUE, FK): o banco é a última linha de
  defesa, não confie só na aplicação.
- Paginação em listagens (LIMIT/OFFSET ou cursor); nunca retorne tabelas
  inteiras.
`
  },
  {
    id: 'java',
    label: 'Java',
    description: 'Java moderno (records, Optional na borda, Spring idiomático)',
    content: `---
nome: java
descricao: Boas práticas de Java neste projeto
---

Ao escrever ou revisar código Java neste projeto:

- Use os recursos modernos: records para dados imutáveis, switch com
  pattern matching, var em locais óbvios, text blocks para strings longas.
- Imutabilidade por padrão: campos final, coleções imutáveis (List.of);
  exponha cópias, nunca o estado interno.
- Optional apenas como retorno (nunca em campo ou parâmetro); trate na
  borda com map/orElse — nunca chame get() sem checagem.
- Exceções: específicas e com contexto; nunca capture Exception genérica
  para engolir; use try-with-resources para tudo que fecha.
- Se for Spring: injeção SEMPRE por construtor (nunca @Autowired em campo),
  configuração tipada com @ConfigurationProperties, transações no service
  (@Transactional) e DTOs nas bordas — entidades JPA não saem do domínio.
- JPA: cuidado com N+1 (fetch join/EntityGraph), equals/hashCode corretos
  em entidades, lazy por padrão.
- Streams para transformações simples; laço tradicional quando ficar mais
  legível — não force encadeamentos ilegíveis.
- Testes com JUnit 5 + AssertJ; Mockito só nas bordas; nomeie testes pelo
  comportamento.
`
  },
  {
    id: 'docker',
    label: 'Docker',
    description: 'Imagens enxutas e seguras, compose organizado',
    content: `---
nome: docker
descricao: Boas práticas de Docker neste projeto
---

Ao escrever ou revisar Dockerfiles e compose neste projeto:

- Multi-stage build sempre: estágio de build separado do de execução;
  a imagem final leva só o necessário (runtime + artefatos).
- Base enxuta e fixada: prefira -slim/alpine quando viável e fixe a versão
  (node:20-slim, nunca latest).
- Ordene camadas para cache: copie manifestos (package.json, pom.xml...)
  e instale dependências ANTES de copiar o código.
- .dockerignore sempre (node_modules, .git, dist, .env).
- Nunca rode como root: crie usuário e use USER no estágio final.
- Segredos NUNCA na imagem (nem em ARG/ENV de build); injete em runtime
  via variáveis de ambiente ou secrets.
- Um processo por container; comunicação entre serviços via rede do
  compose (nome do serviço como host).
- Compose: healthcheck nos serviços críticos, depends_on com condition,
  volumes nomeados para dados persistentes, restart: unless-stopped.
- Exponha portas em 127.0.0.1 quando o serviço não deve ser público.
- HEALTHCHECK na imagem quando o serviço tem endpoint de saúde.
`
  },
  {
    id: 'python',
    label: 'Python',
    description: 'Python moderno com type hints e boas práticas',
    content: `---
nome: python
descricao: Boas práticas de Python neste projeto
---

Ao escrever ou revisar Python neste projeto:

- Type hints em todas as funções públicas; rode mypy/pyright mentalmente.
- Estruturas: dataclasses ou pydantic para dados; evite dicts soltos.
- f-strings para formatação; pathlib para caminhos; context managers (with)
  para recursos.
- Erros: exceções específicas; nunca except Exception sem re-raise/log.
- Dependências pinadas (requirements.txt/pyproject); ambiente virtual sempre.
- Testes com pytest; fixtures em vez de setup manual repetido.
- Siga PEP 8; nomes descritivos; funções curtas com uma responsabilidade.
`
  }
]
