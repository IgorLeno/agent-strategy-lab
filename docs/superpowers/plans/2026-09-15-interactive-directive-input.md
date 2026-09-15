# Captura interativa da Run Directive

- [x] Inspecionar instruções, lições, Git e fluxo stdin/TUI (main limpa, 702824131bea).
- [x] Reproduzir em PTY e comparar bytes enviados/recebidos antes da correção (8 repinturas, sem perda de bytes).
- [x] Impedir repintura durante a captura e abandonar a posição antiga do frame (`waitingForInput` em lab-ui.ts + `finish()` reseta `previousLines`).
- [x] Cobrir digitação lenta, colagem, edição, EOF, SIGINT e entrada redirecionada com substituto antes da execução (test/dev/lab-input-pty.test.ts + test/dev/lab-tui.test.ts).
- [x] Executar regressões, typecheck, build, suíte nativa e git diff --check (183 arquivos / 2767 testes, exit 0; typecheck e build limpos; diff --check limpo).

Escopo: captura e apresentação apenas; nenhum worker real, alteração no alvo,
commit, push ou deploy. A fronteira submitRunDirective será substituída nos
testes do CLI, registrando a entrada crua e simulando progresso posterior.
