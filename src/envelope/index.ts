/**
 * Envelopes de reprodutibilidade: serialização canônica e hash sha256 dos
 * componentes que definem uma execução e uma avaliação.
 *
 * Fronteira: são DOIS envelopes independentes. Mudar uma flag da CLI muda o
 * envelope de execução; mudar um hidden grader muda só o de avaliação. Um
 * envelope único obrigaria a re-executar o agente para trocar de rubrica.
 *
 * Preenchido por M10.
 */
export {};
