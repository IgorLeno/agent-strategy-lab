import { canonicalJson } from './canonical.js';

/**
 * TAMANHO É OBSERVAÇÃO, NÃO AUTORIDADE.
 *
 * Estes números são ALVOS ADVISÓRIOS de concisão para os artifacts estruturados
 * do protocolo. Nenhum deles interrompe lifecycle: um TaskPacket ou um
 * HandoffDraft que passa do alvo continua VÁLIDO, continua sendo parseado e
 * continua fechando a tarefa. O que rejeita artifact é o schema estrito — campo
 * inventado, campo ausente, campo malformado —, nunca a contagem de bytes.
 *
 * A regra existe porque a run real `semi-imperium-real-01` morreu duas vezes
 * pelo mesmo erro de categoria. Primeiro o HandoffRecord selado (4318 bytes)
 * foi cobrado do teto do draft. Depois, com trabalho de ~19 min já validado e
 * já commitado em `be5ff5a`, a task 04 morreu em
 * `BudgetExceededError: HandoffDraft excede o budget: 4438 bytes > 4096 bytes`.
 * Em nenhum dos dois casos havia limite REAL do lado de fora: nem quota de
 * provider, nem janela de contexto, nem memória de máquina. Era o Lab
 * estrangulando trabalho válido com um número que ele mesmo inventou.
 *
 * É a mesma correção já aplicada à previsão de runtime — forecast ≠ deadline.
 * Aqui: alvo advisório de tamanho ≠ gate de execução.
 *
 * Limite REAL de provider (janela de contexto de fato recusada pelo provider) é
 * outra coisa, é do ambiente, e se trata onde ele acontece — jamais por um
 * proxy interno de 4 KiB ou 12 KiB fingindo representá-lo.
 */
export const ADVISORY_TASK_PACKET_BYTES = 12_288; // 12 KiB
export const ADVISORY_HANDOFF_DRAFT_BYTES = 4_096; // 4 KiB

export function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

/**
 * Medição de tamanho de artifact — telemetria pura, sem efeito.
 *
 * `advisory_threshold_exceeded` é rótulo de observabilidade: pode alimentar
 * relatório e histórico, e NÃO pode decidir PASS/FAIL, parar execução, criar
 * HUMAN_REQUIRED, mudar routing ou mudar cobrança. Nenhum caller tem
 * autorização para tratá-lo como veredito.
 */
export interface ArtifactSizeAdvisory {
  readonly bytes: number;
  readonly advisory_threshold_bytes: number;
  readonly advisory_threshold_exceeded: boolean;
}

export function artifactSizeAdvisory(
  value: unknown,
  advisoryThresholdBytes: number,
): ArtifactSizeAdvisory {
  const bytes = byteSize(value);
  return {
    bytes,
    advisory_threshold_bytes: advisoryThresholdBytes,
    advisory_threshold_exceeded: bytes > advisoryThresholdBytes,
  };
}
