export type StartHttpServerOptions = {
  listen: () => Promise<unknown>;
  warmupEnabled: boolean;
  warmUp: () => Promise<unknown>;
  onWarmupError: (error: unknown) => void;
};

export async function startHttpServer(options: StartHttpServerOptions) {
  await options.listen();
  if (!options.warmupEnabled) return;

  try {
    await options.warmUp();
  } catch (error) {
    options.onWarmupError(error);
  }
}
