function makeIntegrationGuide(baseUrl) {
  return `# Wiki Server\n\nBase URL: ${baseUrl}\n\n` +
    `- POST /query with { "content": "neutral question" }\n` +
    `- POST /ingest with { "content": "file path, document text, or Source / Ingest context" }\n` +
    `- POST /lint with {}\n\n` +
    `Commands return 202 with a jobId. Poll GET /jobs/<jobId> until succeeded, failed, cancelled, or interrupted. ` +
    `Read successful answers from result.lastAgentMessage. The receiving repository decides when to call each command.\n`;
}

module.exports = { makeIntegrationGuide };
