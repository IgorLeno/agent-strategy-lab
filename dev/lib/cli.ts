/** Parser de argumentos mínimo — o harness é fino de propósito. */
export interface ParsedArgs {
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const eq = name.indexOf('=');
    if (eq >= 0) {
      options.set(name.slice(0, eq), name.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, options, positionals };
}

/** stdout é reservado para saída de máquina (JSON); diagnóstico vai em stderr. */
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function fail(message: string, exitCode = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}
