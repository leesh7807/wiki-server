const net = require("node:net");

function parseAppPort(value) {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
}

async function selectServerPort(bindHost, preferredPort, defaultPort, available = isPortAvailable) {
  if (await available(bindHost, preferredPort)) {
    return {
      port: preferredPort,
      warning: preferredPort === defaultPort
        ? ""
        : `Configured port ${preferredPort} is being used instead of the default ${defaultPort}.`,
    };
  }

  for (let candidate = preferredPort + 1; candidate <= Math.min(preferredPort + 40, 65535); candidate += 1) {
    if (await available(bindHost, candidate)) {
      return {
        port: candidate,
        warning: `Default port ${preferredPort} was already in use. Wiki Server started on ${candidate}.`,
      };
    }
  }
  throw new Error(`No available Wiki Server port near ${preferredPort}`);
}

function isPortAvailable(bindHost, candidatePort) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host: bindHost, port: candidatePort, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

module.exports = { parseAppPort, selectServerPort };
