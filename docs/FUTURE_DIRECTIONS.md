# Direções futuras — evidence-triggered

> **Isto não é um plano.**
>
> - não é executável;
> - não tem ordem;
> - não tem dependências;
> - não autoriza implementação;
> - não é backlog, não é milestone, não é roadmap.
>
> Cada item abaixo é um **tema plausível**, não um compromisso. Nenhum vira
> trabalho sem evidência vinda de projeto real: uma observação concreta de uso,
> um defeito reproduzível ou um custo medido. Sem essa evidência, o item
> permanece aqui e nada acontece.

A fonte autoritativa de trabalho é [`dev/plan.yaml`](../dev/plan.yaml). Nada
neste arquivo entra lá por estar escrito aqui.

## Como um tema vira trabalho

```text
REAL PROJECT
   ↓
OBSERVATION
   ↓
CONCRETE NEED / DEFECT
   ↓
SMALLEST COHERENT CHANGE
   ↓
REGRESSION
   ↓
BACK TO REAL PROJECT
```

O ciclo começa no projeto real, nunca neste documento. A mudança certa é a
menor que resolve a necessidade observada — não a decomposição mais completa
que alguém consegue desenhar antes de ter o problema.

## Temas

### 1. Telemetria de execução provider-neutral mais rica

Hoje a observação ao vivo mede **atividade** (chunks em stdout/stderr,
silêncio, suspeita de stall) e não progresso semântico; o parse do transporte
de cada provider é post-hoc. Uma leitura mais rica e provider-neutral do que
acontece durante a execução é plausível — se um projeto real mostrar que a
falta dela custou diagnóstico, tempo ou intervenção humana.

Restrição que qualquer versão futura herda: telemetria observa, não decide.
Previsão de runtime não tem autoridade sobre encerramento.

### 2. Fluxo persistente de `HUMAN_REQUIRED` → decisão → resume

`HUMAN_REQUIRED` é terminal hoje: a decisão humana acontece fora do sistema e
o nó bloqueado não é retomado automaticamente. Um registro persistido de
decisão com retomada do ponto exato é plausível — se a operação real mostrar
que o custo do caminho manual é recorrente e não apenas ocasional.

### 3. Execução paralela limitada

A execução é estritamente serial (`concurrency = 1`). Paralelismo limitado só
faz sentido **se projetos reais demonstrarem benefício** que compense conflito
de merge, isolamento de workspace e perda de legibilidade da história. Sem
essa demonstração, serial continua sendo a escolha certa, não uma limitação.

### 4. Adapters externos opcionais de execução

Substratos de execução alternativos podem ser plugados atrás dos contratos já
existentes — **quando houver necessidade concreta**, não por antecipação.
Nenhum adapter específico está escolhido, e nenhum é compromisso.

O control plane continua sendo o produto: planning, task graph, scheduling,
routing, validação, evidência, billing, credential policy, recovery, gates
humanos e história de projeto não migram para um adapter.

### 5. Conhecimento contextual derivado de histórico

Derivar conhecimento reutilizável da história de execução só é discutível
**depois de existir amostra real suficiente** para que a derivação seja
evidência e não folclore. Antes disso, qualquer store de conhecimento seria
inferência sobre um `n` pequeno demais.

Se algum dia existir: derivado nunca vira fato canônico sozinho, contradição
fica exposta em vez de ser resolvida em silêncio, e consulta é pull com
provenance registrada.

## Hipótese a reconsiderar (não é direção assumida)

**Retrieval estrutural / otimização de contexto.** A ideia de montar o
contexto do worker a partir de uma leitura estrutural do repositório parecia
uma direção óbvia antes do piloto. Hoje é **hipótese em aberto**, mantida aqui
para ser reconsiderada com evidência — e possivelmente descartada.

O motivo é um conflito de princípio, não de esforço: escolher o que o agente
vê é prescrever *como* ele trabalha, o que colide com
**"control the boundaries, not the implementation"**. Qualquer retomada desse
tema precisa primeiro resolver o conflito explicitamente, com evidência de que
o benefício medido justifica atravessar a fronteira — não assumir que
atravessar é o caminho.

## O que este documento não faz

Não substitui o roadmap removido, e não é o começo de um novo. Não existe
sequência de milestones pré-autorizada depois da v0.1. Se um tema daqui virar
trabalho, ele entra em `dev/plan.yaml` com id novo, escopo mínimo e
justificativa vinda do projeto real que o motivou — nunca com a decomposição
que alguém escreveu antes de o problema existir.
