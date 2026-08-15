export async function withBoundedRetry(operation, options) {
  return operation(1);
}
